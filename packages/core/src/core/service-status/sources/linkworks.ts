import { failSchema, fetchBoundedText } from "../http.js";
import { worstStatus } from "../severity.js";
import { maskRegions, stableHash } from "./shared.js";
import type {
  NormalizedComponent,
  ServiceStatusAdapterContext,
  ServiceStatusAdapterResult,
  ServiceStatusLevel,
} from "../types.js";

/**
 * Linkworks "llm·monitor" dashboard adapter — **third-party synthetic
 * evidence, not an official Ollama Cloud status feed**.
 *
 * The dashboard is an independently operated probe of a homelab inference
 * cluster. It is useful as a corroborating signal and nothing more, so the
 * source is registered with `external_synthetic` provenance and its scope note
 * says so explicitly. Nothing here may be presented as vendor truth.
 *
 * The page is server-rendered Astro. The parsed surface is the SSR
 * `role="table"` block, not the island's hydration `props` attribute: the props
 * encoding is an Astro implementation detail, while the rendered rows carry the
 * status pill and the explicit probe timestamp that the page itself displays.
 *
 * Fails closed on unknown markup or an unrecognized status word — a probe page
 * that changed shape must not be read as "green".
 *
 * One live quirk shapes the component model: the dashboard runs several engines
 * per host and renders some of them under an identical label, so two rows can
 * be byte-identical in every identity-bearing attribute. Those rows are merged
 * into one component carrying the worst status of the group rather than being
 * assigned a fabricated id or silently dropped.
 */

export const LINKWORKS_LIVE_URL = "https://ollama.linkworksinc.com/live";

/** Status words rendered by the live dashboard. */
const STATUS_WORDS: Readonly<Record<string, ServiceStatusLevel>> = {
  OK: "operational",
  DEGRADED: "degraded",
};

/**
 * Work bound, set well above what the live dashboard renders (twelve rows at
 * recording time). Exceeding it fails the refresh: reading a prefix could drop
 * exactly the degraded endpoint and publish a green snapshot.
 */
const MAX_ROWS = 200;
const ENDPOINT_URL = /\bhttps?:\/\/[^\s"'<>]+/gi;

export interface LinkworksSourceConfig {
  sourceId: string;
  label: string;
  url: string;
}

export function normalizeLinkworksDashboard(
  config: LinkworksSourceConfig,
  html: string,
  fetchedAt: Date
): ServiceStatusAdapterResult {
  const label = `${config.label} dashboard`;

  const rowRanges = scanDashboardStructure(label, html);
  const rows = rowRanges.map(
    (range) => [html.slice(range.start, range.end), html.slice(range.contentStart, range.end)] as const
  );
  if (rows.length === 0) failSchema(label, "endpoint table contains no rows");

  if (rows.length > MAX_ROWS) {
    failSchema(
      label,
      `dashboard listed ${String(rows.length)} rows, above the ${String(MAX_ROWS)} cap`
    );
  }

  const notes: string[] = [];
  const grouped = new Map<string, NormalizedComponent>();
  const groupSizes = new Map<string, number>();
  for (const row of rows) {
    const parsed = parseRow(label, row[0] ?? "", row[1] ?? "");
    groupSizes.set(parsed.id, (groupSizes.get(parsed.id) ?? 0) + 1);
    const existing = grouped.get(parsed.id);
    if (!existing) {
      grouped.set(parsed.id, parsed);
      continue;
    }
    // The dashboard publishes several engines under one label — two SCOUT rows
    // are byte-identical in every identity-bearing attribute and differ only in
    // probe time and throughput, neither of which is stable identity. Rather
    // than fabricate an id or drop a row, indistinguishable rows collapse into
    // one component carrying the worst status of the group, so a degraded
    // engine can never be hidden by a healthy twin.
    grouped.set(parsed.id, {
      ...existing,
      status: worstStatus([existing.status, parsed.status]),
      updatedAt: laterTimestamp(existing.updatedAt, parsed.updatedAt),
    });
  }
  for (const [id, size] of groupSizes) {
    if (size < 2) continue;
    notes.push(
      `${String(size)} rows share the identity of ${JSON.stringify(grouped.get(id)!.name)}; ` +
        "they were merged, taking the worst status"
    );
  }
  const components = [...grouped.values()];

  return {
    sourceId: config.sourceId,
    fetchedAt: fetchedAt.toISOString(),
    baseline: {
      status: "operational",
      description: "Third-party synthetic probe dashboard; not official Ollama Cloud status",
      derived: true,
    },
    components: components.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    // The dashboard publishes no incident record of its own.
    incidents: [],
    notes,
  };
}

interface RowRange {
  /** Start of the row's opening `<a …>` tag. */
  start: number;
  /** Start of the row's content, just past that tag. */
  contentStart: number;
  /** End of the row's content, at its `</a>`. */
  end: number;
}

/**
 * Verify the dashboard's envelope and row nesting before reading anything out
 * of it, and return the byte range of each endpoint row.
 *
 * Matching row anchors directly succeeds on the *complete prefix* of a
 * truncated response, so a page cut off inside a trailing degraded endpoint
 * would parse as a tidy list of healthy ones. It is equally fooled by a
 * `</html>` sitting inside a `<script>`, which is why the scan runs over a copy
 * with script, style and comment content blanked out.
 *
 * Script and style are masked before comments: the live page's inline scripts
 * are the realistic place for a stray `<!--`, and this is a check for one known
 * server-rendered surface rather than a general HTML parser.
 */
function scanDashboardStructure(label: string, html: string): RowRange[] {
  const masked = maskRegions(html, [
    /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,
    /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,
    /<!--[\s\S]*?-->/g,
  ]);

  const single = (pattern: RegExp, what: string): { start: number; end: number } => {
    const found = [...masked.matchAll(pattern)];
    if (found.length !== 1) {
      failSchema(label, `page has ${String(found.length)} ${what}; expected exactly one`);
    }
    const match = found[0]!;
    return { start: match.index, end: match.index + match[0].length };
  };

  const htmlOpen = single(/<html\b[^>]*>/gi, "<html> tags");
  const htmlClose = single(/<\/html\s*>/gi, "</html> tags");
  const bodyOpen = single(/<body\b[^>]*>/gi, "<body> tags");
  const bodyClose = single(/<\/body\s*>/gi, "</body> tags");
  const tableOpen = single(/<div\b[^>]*role="table"[^>]*>/gi, 'role="table" blocks');

  // Find the `</div>` that closes the table, by depth from its opening tag.
  let depth = 0;
  let tableCloseStart = -1;
  for (const match of masked.slice(tableOpen.start).matchAll(/<div\b[^>]*>|<\/div\s*>/gi)) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) {
      tableCloseStart = tableOpen.start + match.index;
      break;
    }
  }
  if (tableCloseStart < 0) {
    failSchema(label, 'page is truncated: the role="table" block is never closed');
  }

  if (
    !(
      htmlOpen.start < bodyOpen.start &&
      bodyOpen.end <= tableOpen.start &&
      tableCloseStart < bodyClose.start &&
      bodyClose.start < htmlClose.start
    )
  ) {
    failSchema(label, "page nests its <html>, <body> and endpoint table out of order");
  }

  // Row anchors, matched by depth so a nested anchor cannot be mistaken for a
  // second row and an unclosed one cannot be silently dropped.
  const table = masked.slice(tableOpen.end, tableCloseStart);
  const rows: RowRange[] = [];
  let anchorDepth = 0;
  let openRow: { start: number; contentStart: number } | null = null;
  for (const match of table.matchAll(/<a\b[^>]*>|<\/a\s*>/gi)) {
    const absolute = tableOpen.end + match.index;
    if (match[0].startsWith("</")) {
      anchorDepth -= 1;
      if (anchorDepth < 0) failSchema(label, "endpoint table closes an anchor that was never opened");
      if (anchorDepth === 0 && openRow) {
        rows.push({ ...openRow, end: absolute });
        openRow = null;
      }
      continue;
    }
    const isRow = /role="row"/i.test(match[0]);
    if (isRow && anchorDepth > 0) failSchema(label, "endpoint table nests one row inside another");
    if (isRow && anchorDepth === 0) {
      openRow = { start: absolute, contentStart: absolute + match[0].length };
    }
    anchorDepth += 1;
  }
  if (anchorDepth !== 0 || openRow) {
    failSchema(label, "endpoint table is truncated: a row anchor is never closed");
  }

  return rows;
}

function parseRow(label: string, rowHtml: string, inner: string): NormalizedComponent {
  const pills = [...inner.matchAll(/<span class="pill-[a-z0-9_-]+">([^<]*)<\/span>/gi)];
  if (pills.length !== 1) {
    failSchema(label, `endpoint row has ${String(pills.length)} status pills; expected exactly one`);
  }
  const word = (pills[0]?.[1] ?? "").trim().toUpperCase();
  const status = STATUS_WORDS[word];
  if (!status) {
    failSchema(label, `endpoint row reports unrecognized status ${JSON.stringify(word)}`);
  }

  // Identity order of preference: the row's own title, then the first cell's
  // title, then the first cell's text. The live page omits the row title for
  // endpoints that have no friendly name, so the fallback chain is load-bearing.
  const rowTitle = matchAttribute(rowHtml.slice(0, rowHtml.indexOf(">") + 1), "title");
  const firstCell = inner.match(/<div class="font-mono[^"]*"(?:[^>]*?)title="([^"]*)"[^>]*>([^<]*)<\/div>/);
  const cellTitle = (firstCell?.[1] ?? "").trim();
  const cellText = (firstCell?.[2] ?? "").trim();
  const identity = rowTitle ?? (cellTitle !== "" ? cellTitle : cellText);
  if (identity === "") failSchema(label, "endpoint row has no identifiable endpoint");

  const probe = inner.match(/title="Last probe at ([^("]+?)\s*(?:\(local:[^"]*)?"/);
  let updatedAt: string | null = null;
  if (probe?.[1]) {
    const parsed = new Date(probe[1].trim());
    if (Number.isNaN(parsed.getTime())) {
      failSchema(label, "endpoint row has an unparseable last-probe timestamp");
    }
    updatedAt = parsed.toISOString();
  }

  return {
    // Hashing the raw identity keeps rows distinguishable when two endpoints
    // share a display name, without persisting the private host it embeds.
    id: `endpoint:${stableHash(identity)}`,
    name: redactEndpointUrl(cellText !== "" ? cellText : identity),
    status,
    description: null,
    groupId: null,
    isGroup: false,
    selected: true,
    updatedAt,
  };
}

function laterTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/** The dashboard prints raw probe URLs; Seam does not need to store them. */
function redactEndpointUrl(name: string): string {
  return name.replace(ENDPOINT_URL, "<endpoint>").replace(/\s+@\s+<endpoint>/, "").trim() || name;
}

function matchAttribute(tag: string, attribute: string): string | null {
  const match = tag.match(new RegExp(`\\b${attribute}="([^"]*)"`));
  const value = match?.[1]?.trim() ?? "";
  return value === "" ? null : value;
}

export function createLinkworksAdapter(
  config: LinkworksSourceConfig
): (context: ServiceStatusAdapterContext) => Promise<ServiceStatusAdapterResult> {
  return async (context) => {
    const response = await fetchBoundedText({
      label: `${config.label} dashboard`,
      url: config.url,
      expectContentType: /text\/html/i,
      fetchImpl: context.fetchImpl,
      signal: context.signal,
    });
    return normalizeLinkworksDashboard(config, response.text, context.now());
  };
}
