import { failSchema, fetchBoundedText } from "../http.js";
import { worstStatus } from "../severity.js";
import {
  maskRegions,
  maxTimestamp,
  orderUpdates,
  stableHash,
  withUniqueIds,
  type RawIncidentUpdate,
} from "./shared.js";
import type {
  NormalizedComponent,
  NormalizedIncident,
  ServiceStatusAdapterContext,
  ServiceStatusAdapterResult,
  ServiceStatusLevel,
} from "../types.js";

/**
 * xAI official status feed (`https://status.x.ai/feed.xml`).
 *
 * The feed is RSS 2.0 whose `<description>` is a CDATA-wrapped HTML block:
 *
 *     <h3>Status: RESOLVED</h3>
 *     <p>Severity: available</p>
 *     <p>Resolved: Thu, 03 Sep 2026 17:08:11 GMT</p>
 *     <hr /><h4>Updates:</h4>
 *     <div><p><strong>Thu, 03 Sep 2026 17:08:11 GMT</strong></p><h3>…</h3><p>…</p></div>
 *
 * Three properties of the live feed drive this parser:
 *
 *   - `<pubDate>` is the incident's *creation* time. It is routinely earlier
 *     than the first structured update and is never the resolution time.
 *   - Update blocks are not consistently ordered — the live feed contains both
 *     newest-first and oldest-first items — so every timestamp is read
 *     explicitly and the sequence is re-sorted.
 *   - A resolved item may carry no `Resolved:` line at all. That is an absent
 *     fact, not a malformed one: `resolvedAt` stays null rather than being
 *     back-filled from `pubDate` or from the newest update.
 *
 * Lifecycle is decided by evidence rather than by a vocabulary guess: an item
 * is resolved when it says `RESOLVED`, and anything else well-formed is treated
 * as active. Guessing the active-side vocabulary would risk reading a live
 * outage as resolved, which is the one direction that must never happen.
 */

export const XAI_FEED_URL = "https://status.x.ai/feed.xml";

/**
 * Work bound, set well above what the live feed returns (114 items at recording
 * time). Exceeding it fails the refresh rather than reading a prefix: the feed
 * is not ordered such that a prefix is guaranteed to contain every unresolved
 * item, so a truncated read could report success while hiding an active
 * incident.
 */
const MAX_ITEMS = 500;
const STATUS_TOKEN = /^[A-Z][A-Z0-9 _-]{0,40}$/;

/**
 * The only severity token observed on the live feed. Anything else becomes
 * `unknown` — an ungraded but non-green level — because inventing a severity
 * grade for an unrecognized word is exactly the failure mode this subsystem
 * exists to avoid.
 */
const SEVERITY_LEVELS: Readonly<Record<string, ServiceStatusLevel>> = {
  available: "operational",
};

export interface XaiSourceConfig {
  sourceId: string;
  label: string;
  feedUrl: string;
}

export function normalizeXaiFeed(
  config: XaiSourceConfig,
  xml: string,
  fetchedAt: Date
): ServiceStatusAdapterResult {
  const label = `${config.label} rss`;
  if (/<!DOCTYPE/i.test(xml) || /<!ENTITY/i.test(xml)) {
    // No external entities, ever. This parser resolves only the five
    // predefined XML entities and numeric character references.
    failSchema(label, "feed declares a DOCTYPE or ENTITY and was rejected");
  }

  const channelStart = xml.indexOf("<channel>");
  if (channelStart < 0) failSchema(label, "feed has no <channel> element");
  const channelHead = xml.slice(channelStart, indexOfOr(xml, "<item", xml.length));
  const channelTitle = extractTag(channelHead, "title") ?? config.label;

  const itemRanges = scanFeedStructure(label, xml);
  const rawItems = itemRanges.map((range) => xml.slice(range.contentStart, range.contentEnd));
  if (rawItems.length === 0) failSchema(label, "feed contains no <item> elements");

  if (rawItems.length > MAX_ITEMS) {
    failSchema(
      label,
      `feed returned ${String(rawItems.length)} items, above the ${String(MAX_ITEMS)} cap`
    );
  }

  const notes: string[] = [];
  const parsed: ParsedItem[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    const item = parseItem(label, raw, notes);
    if (seen.has(item.incident.externalId)) {
      failSchema(label, `duplicate incident id ${JSON.stringify(item.incident.externalId)}`);
    }
    seen.add(item.incident.externalId);
    parsed.push(item);
  }
  const incidents = parsed.map((item) => item.incident);

  return {
    sourceId: config.sourceId,
    fetchedAt: fetchedAt.toISOString(),
    baseline: {
      // The feed exposes no page-level indicator, so the baseline is derived:
      // "the official feed parsed". Component and incident severity, not this
      // baseline, are what make the source go red.
      status: "operational",
      description: channelTitle,
      derived: true,
    },
    components: deriveComponents(parsed),
    incidents,
    notes,
  };
}

interface ParsedItemScope {
  componentId: string;
  componentName: string;
}

interface ParsedItem {
  incident: NormalizedIncident;
  scope: ParsedItemScope;
}

function parseItem(label: string, raw: string, notes: string[]): ParsedItem {
  const title = extractTag(raw, "title");
  if (!title) failSchema(label, "item has no <title>");
  const link = extractTag(raw, "link");
  const guid = extractTag(raw, "guid");
  const pubDate = extractTag(raw, "pubDate");
  if (!pubDate) failSchema(label, `item ${JSON.stringify(title)} has no <pubDate>`);
  const startedAt = parseFeedDate(label, pubDate, `<pubDate> of ${JSON.stringify(title)}`);

  const categories = [...raw.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/g)].map((match) =>
    decodeXml(match[1] ?? "").trim().toLowerCase()
  );

  const description = extractTag(raw, "description") ?? "";
  const externalId = guid || link || stableHash(title, pubDate);

  const statusMatch = description.match(/<h3>\s*Status:\s*([^<]+)<\/h3>/i);
  if (!statusMatch) {
    failSchema(label, `item ${JSON.stringify(externalId)} has no "Status:" line`);
  }
  const statusToken = decodeXml(statusMatch[1] ?? "").trim().toUpperCase();
  if (!STATUS_TOKEN.test(statusToken)) {
    failSchema(label, `item ${JSON.stringify(externalId)} has a malformed status token`);
  }
  const resolvedByStatus = statusToken === "RESOLVED";
  if (categories.length > 0) {
    const resolvedByCategory = categories.includes("resolved");
    if (resolvedByCategory !== resolvedByStatus) {
      failSchema(
        label,
        `item ${JSON.stringify(externalId)} has an ambiguous lifecycle: ` +
          `status ${JSON.stringify(statusToken)} disagrees with its category tags`
      );
    }
  }
  const stage = resolvedByStatus ? "resolved" : "active";

  const severityMatch = description.match(/<p>\s*Severity:\s*([^<]+)<\/p>/i);
  const severityToken = severityMatch ? decodeXml(severityMatch[1] ?? "").trim().toLowerCase() : "";
  let impact: ServiceStatusLevel;
  if (severityToken === "") {
    impact = "unknown";
    notes.push(`item ${externalId} has no severity line; impact recorded as unknown`);
  } else {
    const mapped = SEVERITY_LEVELS[severityToken];
    if (mapped) {
      impact = mapped;
    } else {
      impact = "unknown";
      notes.push(
        `item ${externalId} reports unrecognized severity ${JSON.stringify(severityToken)}; ` +
          "impact recorded as unknown rather than graded"
      );
    }
  }

  const resolvedMatch = description.match(/<p>\s*Resolved:\s*([^<]+)<\/p>/i);
  let resolvedAt: string | null = null;
  if (resolvedMatch) {
    resolvedAt = parseFeedDate(
      label,
      decodeXml(resolvedMatch[1] ?? ""),
      `"Resolved:" line of ${JSON.stringify(externalId)}`
    );
    if (stage === "active") {
      failSchema(
        label,
        `item ${JSON.stringify(externalId)} is not resolved but carries a "Resolved:" time`
      );
    }
  } else if (stage === "resolved") {
    notes.push(`item ${externalId} is resolved upstream without an explicit resolution time`);
  }

  const updates = parseUpdates(label, externalId, description);
  const latest = updates.length > 0 ? updates[updates.length - 1]!.createdAt : null;
  const updatedAt = maxTimestamp([latest, startedAt]) ?? startedAt;

  const scope = deriveScope(title, link);
  return {
    scope,
    incident: {
      externalId,
      title,
      stage,
      lifecycle: statusToken.toLowerCase(),
      impact,
      url: link,
      startedAt,
      updatedAt,
      resolvedAt,
      componentIds: [scope.componentId],
      updates,
    },
  };
}

function parseUpdates(label: string, externalId: string, description: string) {
  const blocks = [
    ...description.matchAll(
      /<div>\s*<p>\s*<strong>([^<]+)<\/strong>\s*<\/p>([\s\S]*?)<\/div>/g
    ),
  ];
  const raw: RawIncidentUpdate[] = blocks.map((block) => {
    const createdAt = parseFeedDate(
      label,
      decodeXml(block[1] ?? ""),
      `update timestamp of ${JSON.stringify(externalId)}`
    );
    const inner = block[2] ?? "";
    const heading = stripTags(inner.match(/<h3>([\s\S]*?)<\/h3>/)?.[1] ?? "");
    const body = stripTags(inner.replace(/<h3>[\s\S]*?<\/h3>/, ""));
    return {
      // The feed gives updates no identifier, so identity is content-derived
      // and therefore stable across polls of an unchanged incident.
      id: `${externalId}:${createdAt}:${stableHash(heading, body)}`,
      lifecycle: heading.toLowerCase() || "update",
      body: heading && body ? `${heading} — ${body}` : heading || body,
      createdAt,
    };
  });
  return orderUpdates(withUniqueIds(raw), `${label} incident ${externalId}`);
}

/**
 * Component identity comes from the incident link's path segment
 * (`https://status.x.ai/api-us-east-1/INC…`), which is stable across renames of
 * the human-facing title. The bracketed title prefix supplies only the label.
 */
function deriveScope(title: string, link: string | null): ParsedItemScope {
  const bracket = title.match(/^\s*\[([^\]]+)\]/);
  const componentName = bracket?.[1]?.trim() || title.trim();
  let segment: string | null = null;
  if (link) {
    const path = link.replace(/^https?:\/\/[^/]+/i, "").split("/").filter(Boolean);
    if (path.length >= 2) segment = path[0] ?? null;
  }
  const componentId = segment ?? `name:${stableHash(componentName)}`;
  return { componentId, componentName };
}

/**
 * xAI publishes no component feed, so components are the incident scopes seen
 * in the window, carrying the worst impact of their *active* incidents.
 */
function deriveComponents(items: readonly ParsedItem[]): NormalizedComponent[] {
  const byId = new Map<string, { name: string; impacts: ServiceStatusLevel[]; updatedAt: string | null }>();
  for (const { incident, scope } of items) {
    const existing = byId.get(scope.componentId) ?? { name: scope.componentName, impacts: [], updatedAt: null };
    if (incident.stage === "active") existing.impacts.push(incident.impact);
    existing.updatedAt = maxTimestamp([existing.updatedAt, incident.updatedAt]);
    byId.set(scope.componentId, existing);
  }
  return [...byId.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => ({
      id,
      name: value.name,
      status: worstStatus(value.impacts),
      description: null,
      groupId: null,
      isGroup: false,
      selected: true,
      updatedAt: value.updatedAt,
    }));
}

interface ItemRange {
  contentStart: number;
  contentEnd: number;
}

interface StructuralToken {
  name: "rss" | "channel" | "item";
  closing: boolean;
  start: number;
  end: number;
}

/**
 * Verify the feed's envelope and item nesting before reading anything out of it,
 * and return the byte ranges of each item's content.
 *
 * Matching `<item>…</item>` pairs directly succeeds happily on the *complete
 * prefix* of a truncated response, so a body cut off inside a trailing
 * unresolved incident would parse as a tidy list of resolved ones and publish
 * `operational` over a live outage. It is equally fooled by tag-like text: a
 * `</rss>` quoted inside an incident's CDATA body is not a real close.
 *
 * The scan therefore runs over a copy with CDATA, comments and processing
 * instructions blanked out, and checks only the three tags that carry
 * structure. Item *content* is then sliced from the original text, so CDATA is
 * still parsed normally. This is deliberately not a general XML parser — it
 * asserts the one shape this feed has always had.
 */
function scanFeedStructure(label: string, xml: string): ItemRange[] {
  const masked = maskRegions(xml, [
    /<!\[CDATA\[[\s\S]*?\]\]>/g,
    /<!--[\s\S]*?-->/g,
    /<\?[\s\S]*?\?>/g,
  ]);

  const tokens: StructuralToken[] = [];
  for (const match of masked.matchAll(/<(\/?)\s*(rss|channel|item)\b[^>]*>/gi)) {
    const raw = match[0];
    const start = match.index;
    if (/\/\s*>$/.test(raw)) {
      failSchema(label, `feed uses a self-closing <${match[2]!.toLowerCase()}>`);
    }
    tokens.push({
      name: match[2]!.toLowerCase() as StructuralToken["name"],
      closing: match[1] === "/",
      start,
      end: start + raw.length,
    });
  }

  const only = (name: StructuralToken["name"], closing: boolean): StructuralToken => {
    const found = tokens.filter((token) => token.name === name && token.closing === closing);
    if (found.length !== 1) {
      failSchema(
        label,
        `feed has ${String(found.length)} <${closing ? "/" : ""}${name}> tags; expected exactly one`
      );
    }
    return found[0]!;
  };

  const rssOpen = only("rss", false);
  const rssClose = only("rss", true);
  const channelOpen = only("channel", false);
  const channelClose = only("channel", true);

  if (!(rssOpen.start < channelOpen.start && channelClose.start < rssClose.start)) {
    failSchema(label, "feed nests <rss> and <channel> out of order");
  }

  const itemTokens = tokens.filter((token) => token.name === "item");
  const ranges: ItemRange[] = [];
  let open: StructuralToken | null = null;
  for (const token of itemTokens) {
    if (token.start < channelOpen.end || token.start > channelClose.start) {
      failSchema(label, "feed has an <item> outside its <channel>");
    }
    if (!token.closing) {
      if (open) failSchema(label, "feed nests one <item> inside another");
      open = token;
      continue;
    }
    if (!open) failSchema(label, "feed closes an <item> that was never opened");
    ranges.push({ contentStart: open.end, contentEnd: token.start });
    open = null;
  }
  if (open) {
    failSchema(label, "feed is truncated: an <item> is never closed");
  }

  return ranges;
}

function indexOfOr(haystack: string, needle: string, fallback: number): number {
  const index = haystack.indexOf(needle);
  return index < 0 ? fallback : index;
}

function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match) return null;
  const value = decodeXml(match[1] ?? "").trim();
  return value === "" ? null : value;
}

/** CDATA unwrapping plus the five predefined entities and numeric references. */
export function decodeXml(value: string): string {
  const unwrapped = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return unwrapped
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

function stripTags(html: string): string {
  return decodeXml(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseFeedDate(label: string, value: string, what: string): string {
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    failSchema(label, `${what} is not a parseable date`);
  }
  return parsed.toISOString();
}

export function createXaiAdapter(
  config: XaiSourceConfig
): (context: ServiceStatusAdapterContext) => Promise<ServiceStatusAdapterResult> {
  return async (context) => {
    const response = await fetchBoundedText({
      label: `${config.label} feed`,
      url: config.feedUrl,
      expectContentType: /(application|text)\/(rss\+)?xml/i,
      fetchImpl: context.fetchImpl,
      signal: context.signal,
    });
    return normalizeXaiFeed(config, response.text, context.now());
  };
}
