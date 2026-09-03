import { describeError, failSchema, fetchBoundedText, parseJson } from "../http.js";
import { maxTimestamp, minTimestamp, orderUpdates, stableHash, withUniqueIds, type RawIncidentUpdate } from "./shared.js";
import type {
  NormalizedIncident,
  ServiceStatusAdapterContext,
  ServiceStatusAdapterResult,
} from "../types.js";

/**
 * Google AI Studio adapter.
 *
 * AI Studio has no documented status API. Its status page calls an internal
 * "Alkali" RPC with a public browser API key that is embedded in the page
 * bootstrap and rotates, so the key is rediscovered on every refresh and is
 * never logged, persisted, or included in an error message.
 *
 * The RPC answers positional protobuf-shaped JSON:
 *
 *     [[[[ id, title, categoryCode,
 *          [[ lifecycleCode, "YYYY-MM-DD HH:mm", ["<epochSeconds>"], text ], … ],
 *          n, [n, …] ], … ]]]
 *
 * The display timestamp is rendered in a local zone; the epoch-seconds field is
 * the authoritative time and is the only one read.
 *
 * Lifecycle code 4 is resolution — it terminates all 60 incidents in the live
 * history, and code 5 is observed strictly between 1 and 4 within an incident.
 * Beyond that, **no severity is inferred from a lifecycle number**: every
 * incident's impact is recorded as `unknown`, which is ungraded rather than
 * green. An unrecognized code fails the whole refresh closed and the previous
 * snapshot is retained.
 */

export const AI_STUDIO_BOOTSTRAP_URL = "https://aistudio.google.com/status";
export const AI_STUDIO_RPC_URL =
  "https://alkalimakersuite-pa.clients6.google.com/$rpc/" +
  "google.internal.alkali.applications.makersuite.v1.MakerSuiteService/ListIncidentsHistory";

/** Codes observed on the live feed. Anything else is schema drift. */
const KNOWN_LIFECYCLE_CODES = new Set([1, 2, 3, 4, 5]);
const RESOLVED_CODE = 4;

const BOOTSTRAP_KEY_PATTERN = /AIza[0-9A-Za-z_-]{35}/g;
const MAX_CANDIDATES = 5;
/**
 * Work bound, set well above what the live RPC returns (sixty incidents at
 * recording time). Exceeding it fails the refresh rather than reading a prefix,
 * so a truncated read can never report success while omitting an unresolved
 * incident.
 */
const MAX_INCIDENTS = 500;
const ANTI_XSS_PREFIX = /^\)\]\}'?\s*/;

export interface GoogleAiStudioSourceConfig {
  sourceId: string;
  label: string;
  bootstrapUrl: string;
  rpcUrl: string;
}

/**
 * Extract candidate public API keys from the status page bootstrap.
 *
 * Returns opaque strings that callers must treat as secrets: they are passed
 * straight to the RPC header and never surfaced anywhere else.
 */
export function discoverBootstrapCandidates(html: string): string[] {
  const found = html.match(BOOTSTRAP_KEY_PATTERN) ?? [];
  const unique: string[] = [];
  for (const candidate of found) {
    if (!unique.includes(candidate)) unique.push(candidate);
    if (unique.length >= MAX_CANDIDATES) break;
  }
  return unique;
}

export function normalizeAlkaliHistory(
  config: GoogleAiStudioSourceConfig,
  rawText: string,
  fetchedAt: Date
): ServiceStatusAdapterResult {
  const label = `${config.label} incident history`;
  const body = rawText.replace(ANTI_XSS_PREFIX, "");
  const root = parseJson(label, body);

  if (!Array.isArray(root) || !Array.isArray(root[0])) {
    failSchema(label, "response is not the expected [[ … ]] envelope");
  }
  const wrapper = (root[0] as unknown[])[0];
  if (!Array.isArray(wrapper)) {
    failSchema(label, "response envelope does not contain an incident list");
  }

  if (wrapper.length > MAX_INCIDENTS) {
    failSchema(
      label,
      `history returned ${String(wrapper.length)} incidents, above the ${String(MAX_INCIDENTS)} cap`
    );
  }

  const notes: string[] = [];
  if (wrapper.length === 0) {
    notes.push("history is empty");
  }

  const incidents: NormalizedIncident[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of wrapper.entries()) {
    const incident = parseIncident(label, entry, index);
    if (seen.has(incident.externalId)) {
      failSchema(label, `duplicate incident id ${JSON.stringify(incident.externalId)}`);
    }
    seen.add(incident.externalId);
    incidents.push(incident);
  }

  const active = incidents.filter((incident) => incident.stage === "active");
  return {
    sourceId: config.sourceId,
    fetchedAt: fetchedAt.toISOString(),
    baseline: {
      // No page-level indicator exists, so the baseline is derived from the
      // successful parse. Any active incident carries `unknown` impact, which
      // is what actually moves the effective status off operational.
      status: "operational",
      description:
        active.length === 0
          ? "AI Studio incident history parsed with no active incident"
          : `AI Studio incident history parsed with ${String(active.length)} active incident(s)`,
      derived: true,
    },
    // The RPC exposes no component catalogue, so no components are synthesized.
    components: [],
    incidents,
    notes,
  };
}

function parseIncident(label: string, entry: unknown, index: number): NormalizedIncident {
  if (!Array.isArray(entry) || entry.length < 4) {
    failSchema(label, `incident tuple at index ${String(index)} has an unexpected shape`);
  }
  const externalId = entry[0];
  if (typeof externalId !== "string" || externalId.trim() === "") {
    failSchema(label, `incident at index ${String(index)} has no id`);
  }
  const title = entry[1];
  if (typeof title !== "string") {
    failSchema(label, `incident ${JSON.stringify(externalId)} has no title`);
  }
  const rawUpdates = entry[3];
  if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
    failSchema(label, `incident ${JSON.stringify(externalId)} has no updates`);
  }

  const parsedUpdates: (RawIncidentUpdate & { code: number })[] = [];
  for (const rawUpdate of rawUpdates) {
    if (!Array.isArray(rawUpdate) || rawUpdate.length < 4) {
      failSchema(label, `incident ${JSON.stringify(externalId)} has a malformed update tuple`);
    }
    const code = rawUpdate[0];
    if (typeof code !== "number" || !KNOWN_LIFECYCLE_CODES.has(code)) {
      failSchema(
        label,
        `incident ${JSON.stringify(externalId)} uses unknown lifecycle code ${JSON.stringify(code)}`
      );
    }
    const epochField = rawUpdate[2];
    if (!Array.isArray(epochField) || typeof epochField[0] !== "string") {
      failSchema(label, `incident ${JSON.stringify(externalId)} has no update timestamp`);
    }
    const seconds = Number(epochField[0]);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      failSchema(label, `incident ${JSON.stringify(externalId)} has a non-numeric update timestamp`);
    }
    const text = typeof rawUpdate[3] === "string" ? rawUpdate[3] : "";
    const createdAt = new Date(seconds * 1000).toISOString();
    parsedUpdates.push({
      code,
      id: `${externalId}:${createdAt}:${stableHash(String(code), text)}`,
      lifecycle: `code-${String(code)}`,
      body: text,
      createdAt,
    });
  }

  // Uniquify first, then index by the *final* id. Two byte-identical terminal
  // updates — which the RPC does emit — collapse onto one id before
  // uniquifying, so a map built from the pre-uniquified list would not contain
  // the id that ends up last and the incident would be misread as unresolved.
  const unique = withUniqueIds(parsedUpdates);
  const codeById = new Map(unique.map((update) => [update.id, update.code]));
  const ordered = orderUpdates(unique, `${label} incident ${externalId}`);
  const latest = ordered[ordered.length - 1]!;
  const latestCode = codeById.get(latest.id);
  if (latestCode === undefined) {
    failSchema(label, `incident ${JSON.stringify(externalId)} lost its lifecycle code while ordering`);
  }
  const resolved = latestCode === RESOLVED_CODE;

  return {
    externalId,
    title: title.trim() === "" ? externalId : title,
    stage: resolved ? "resolved" : "active",
    lifecycle: latest.lifecycle,
    // Deliberately ungraded: the RPC carries no severity field, and a lifecycle
    // number is not one.
    impact: "unknown",
    url: null,
    startedAt: minTimestamp(ordered.map((update) => update.createdAt))!,
    updatedAt: maxTimestamp(ordered.map((update) => update.createdAt))!,
    resolvedAt: resolved ? latest.createdAt : null,
    componentIds: [],
    updates: ordered,
  };
}

export function createGoogleAiStudioAdapter(
  config: GoogleAiStudioSourceConfig
): (context: ServiceStatusAdapterContext) => Promise<ServiceStatusAdapterResult> {
  return async (context) => {
    const bootstrap = await fetchBoundedText({
      label: `${config.label} bootstrap`,
      url: config.bootstrapUrl,
      expectContentType: /text\/html/i,
      fetchImpl: context.fetchImpl,
      signal: context.signal,
    });

    const candidates = discoverBootstrapCandidates(bootstrap.text);
    if (candidates.length === 0) {
      failSchema(`${config.label} bootstrap`, "no RPC credential candidate was discoverable");
    }

    let lastError: string | null = null;
    for (const [index, candidate] of candidates.entries()) {
      try {
        const response = await fetchBoundedText({
          // The candidate index is enough to debug a rotation; the candidate
          // itself never reaches a message or a log line.
          label: `${config.label} RPC (candidate ${String(index + 1)})`,
          url: config.rpcUrl,
          method: "POST",
          headers: {
            "content-type": "application/json+protobuf",
            "x-goog-api-key": candidate,
            origin: "https://aistudio.google.com",
            referer: "https://aistudio.google.com/",
            accept: "*/*",
          },
          body: "[]",
          expectContentType: /application\/json/i,
          fetchImpl: context.fetchImpl,
          signal: context.signal,
        });
        return normalizeAlkaliHistory(config, response.text, context.now());
      } catch (error) {
        lastError = describeError(error);
        if (isSchemaFailure(error)) throw error;
      }
    }
    failSchema(
      `${config.label} RPC`,
      `every discovered credential candidate failed — last error: ${lastError ?? "unknown"}`
    );
  };
}

function isSchemaFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "ServiceStatusSchemaError";
}
