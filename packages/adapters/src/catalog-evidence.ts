/**
 * Portable, provider-neutral evidence validation and canonical serialization
 * for the model catalog (#236).
 *
 * ONE parser, applied twice: before a remote bridge returns a candidate, and
 * again before core persists or loads one. A bridge is not a trust boundary we
 * can skip — a compromised or buggy remote must not be able to write arbitrary
 * content into a durable snapshot that the controller then renders.
 *
 * Two properties this file is responsible for:
 *
 * 1. **Exact-key closure.** Every accepted key is enumerated here, at every
 *    nesting level. An unknown key is a rejection, not a passthrough. Length
 *    limits are NOT secret sanitization: a 40-character token fits any bound,
 *    so content is screened as well as size.
 * 2. **Canonical identity.** Checksum, diff and reduction-confirmation
 *    fingerprints must not depend on JavaScript property insertion order, and
 *    the confirmation fingerprint must not depend on volatile observation
 *    timestamps — otherwise two semantically identical observations can never
 *    confirm each other.
 *
 * Nothing here knows a provider, a CLI, or a model name.
 */

/** Bound on general evidence text fields. */
export const CATALOG_EVIDENCE_TEXT_MAX = 200;
/** Bound on the free-text note, which is the most abusable field. */
export const CATALOG_EVIDENCE_NOTE_MAX = 200;
/** Bound on how many records one model row may carry. */
export const CATALOG_EVIDENCE_MAX_RECORDS = 8;
/** Bound on entries in an evidence list (e.g. effort choices). */
export const CATALOG_EVIDENCE_MAX_LIST = 24;
/** Bound on one entry inside an evidence list. */
export const CATALOG_EVIDENCE_LIST_ITEM_MAX = 64;
/** Bound on a model description. */
export const CATALOG_DESCRIPTION_MAX = 400;

export const CATALOG_EVIDENCE_KINDS = [
  "live-observation",
  "verified-record",
  "declared-manifest",
  "enrichment",
] as const;

const EVIDENCE_KEYS = [
  "kind", "source", "observedAt", "runtimeVersion", "adapterVersion",
  "scopeRef", "resolvedModel", "context", "effort", "note",
] as const;
const CONTEXT_KEYS = ["native", "maximum", "effective", "method"] as const;
const EFFORT_KEYS = ["choices", "selectionDefault", "method"] as const;

/**
 * Content screens. Deliberately conservative and provider-agnostic: these match
 * SHAPES of credentials and personal data, never a provider's vocabulary.
 */
/** Screens that apply to EVERY field, including bare identifiers. */
const UNIVERSAL_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "token-prefix", re: /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[abprs]|AKIA|ASIA|AIza|glpat)[-_][A-Za-z0-9_-]{8,}/ },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: "pem", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "long-opaque", re: /[A-Za-z0-9_-]{40,}/ },
  { id: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { id: "home-path", re: /(?:\/home\/|\/Users\/|~\/)/ },
  { id: "credential-path", re: /\.(?:credentials|netrc|npmrc|pem|key|p12|pfx)\b|\bid_(?:rsa|ed25519|ecdsa)\b|(?:^|[\/\s])\.env\b|(?:^|[\/\s])\.ssh(?:[\/\s]|$)/i },
  { id: "control-chars", re: /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ },
];

/**
 * Additional screens for FREE TEXT only.
 *
 * `assignment` and `token-word` cannot be applied to identifier/label fields: a
 * legitimate raw model id such as `vendor::nebula@2026` trips an assignment
 * shape that uses `:`, and a legitimate source label may legitimately contain
 * the word "credential". Those fields are constrained by a charset instead,
 * which has no room to spell a `KEY=VALUE` pair.
 */
const FREE_TEXT_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  { id: "assignment", re: /[A-Za-z0-9_.-]{2,}\s*=\s*\S{4,}/ },
  { id: "bearer", re: /\bbearer\s+\S+/i },
  { id: "token-word", re: /\b(?:secret|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key)\b/i },
];

/**
 * Charset for identifier/label fields. No `=`, no quotes, no backticks, no
 * control characters, so an environment fragment cannot be spelled here at all,
 * while real model ids, versions and source labels can.
 */
const LABEL_CHARSET = /^[\w .:@/\[\]()+#,\u00a7&|~-]+$/u;

export class CatalogEvidenceError extends Error {
  readonly path: string;
  constructor(path: string, detail: string) {
    super(`evidence ${path}: ${detail}`);
    this.name = "CatalogEvidenceError";
    this.path = path;
  }
}

/**
 * True when text carries something that must never reach a durable snapshot.
 * Screening SHAPE, not vocabulary, is what keeps this provider-neutral.
 * `freeText` adds the screens that only make sense for prose.
 */
export function looksUnsafeForCatalog(text: string, freeText = true): string | null {
  for (const pattern of UNIVERSAL_PATTERNS) {
    if (pattern.re.test(text)) return pattern.id;
  }
  if (freeText) {
    for (const pattern of FREE_TEXT_PATTERNS) {
      if (pattern.re.test(text)) return pattern.id;
    }
  }
  return null;
}

/**
 * Identifier/label field: a model id, a source name, a version, a method. These
 * are constrained by CHARSET rather than by prose screens, because a legitimate
 * raw model id can contain `:` and `@` while an environment fragment cannot be
 * spelled without `=` or quotes.
 */
function assertLabel(path: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw new CatalogEvidenceError(path, "must be a string");
  if (!value.length) throw new CatalogEvidenceError(path, "must not be empty");
  if (value.length > max) throw new CatalogEvidenceError(path, `exceeds ${max} characters`);
  if (!LABEL_CHARSET.test(value)) {
    throw new CatalogEvidenceError(path, "contains characters not allowed in an identifier");
  }
  const unsafe = looksUnsafeForCatalog(value, false);
  if (unsafe) throw new CatalogEvidenceError(path, `rejected content (${unsafe})`);
  return value;
}

/** Free-text field (note, description): every screen applies. */
function assertFreeText(path: string, value: unknown, max: number): string {
  if (typeof value !== "string") throw new CatalogEvidenceError(path, "must be a string");
  if (!value.length) throw new CatalogEvidenceError(path, "must not be empty");
  if (value.length > max) throw new CatalogEvidenceError(path, `exceeds ${max} characters`);
  const unsafe = looksUnsafeForCatalog(value, true);
  if (unsafe) throw new CatalogEvidenceError(path, `rejected content (${unsafe})`);
  return value;
}

function assertExactKeys(path: string, value: unknown, allowed: ReadonlyArray<string>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogEvidenceError(path, "must be an object");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new CatalogEvidenceError(`${path}.${key}`, "unknown key");
  }
  return record;
}

/**
 * `scopeRef` identifies a scope WITHOUT being a credential. Either a
 * fingerprint (the hex digest `catalogScopeFingerprint` produces) or a short
 * sanitized label from a restricted alphabet — never a path, URL, or account.
 */
const SANITIZED_SCOPE_REF = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;

function assertScopeRef(path: string, value: unknown): string {
  if (typeof value !== "string") throw new CatalogEvidenceError(path, "must be a string");
  if (FINGERPRINT.test(value)) return value;
  if (!SANITIZED_SCOPE_REF.test(value)) {
    throw new CatalogEvidenceError(path, "must be a scope fingerprint or a bounded sanitized identifier");
  }
  const unsafe = looksUnsafeForCatalog(value, false);
  if (unsafe) throw new CatalogEvidenceError(path, `rejected content (${unsafe})`);
  return value;
}

function assertPositiveWindow(path: string, value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new CatalogEvidenceError(path, "must be a positive integer or null");
  }
  return value;
}

export interface ParsedCatalogEvidence {
  kind: (typeof CATALOG_EVIDENCE_KINDS)[number];
  source: string;
  observedAt?: string;
  runtimeVersion?: string;
  adapterVersion?: number;
  scopeRef?: string;
  resolvedModel?: string;
  context?: { native?: number | null; maximum?: number | null; effective?: number | null; method?: string };
  effort?: { choices?: string[]; selectionDefault?: string; method?: string };
  note?: string;
}

/** Validate one record. Throws {@link CatalogEvidenceError} on any violation. */
export function parseCatalogEvidenceRecord(path: string, raw: unknown): ParsedCatalogEvidence {
  const record = assertExactKeys(path, raw, EVIDENCE_KEYS);
  const kind = record.kind;
  if (typeof kind !== "string" || !(CATALOG_EVIDENCE_KINDS as ReadonlyArray<string>).includes(kind)) {
    throw new CatalogEvidenceError(`${path}.kind`, "unknown evidence kind");
  }
  const parsed: ParsedCatalogEvidence = {
    kind: kind as ParsedCatalogEvidence["kind"],
    source: assertLabel(`${path}.source`, record.source, CATALOG_EVIDENCE_TEXT_MAX),
  };
  if (record.observedAt !== undefined) {
    const at = record.observedAt;
    if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) {
      throw new CatalogEvidenceError(`${path}.observedAt`, "must be an ISO-8601 timestamp");
    }
    parsed.observedAt = at;
  }
  if (record.runtimeVersion !== undefined) {
    parsed.runtimeVersion = assertLabel(`${path}.runtimeVersion`, record.runtimeVersion, CATALOG_EVIDENCE_TEXT_MAX);
  }
  if (record.adapterVersion !== undefined) {
    if (!Number.isInteger(record.adapterVersion) || (record.adapterVersion as number) < 1) {
      throw new CatalogEvidenceError(`${path}.adapterVersion`, "must be a positive integer");
    }
    parsed.adapterVersion = record.adapterVersion as number;
  }
  if (record.scopeRef !== undefined) parsed.scopeRef = assertScopeRef(`${path}.scopeRef`, record.scopeRef);
  if (record.resolvedModel !== undefined) {
    parsed.resolvedModel = assertLabel(`${path}.resolvedModel`, record.resolvedModel, CATALOG_EVIDENCE_TEXT_MAX);
  }
  if (record.context !== undefined) {
    const context = assertExactKeys(`${path}.context`, record.context, CONTEXT_KEYS);
    const native = assertPositiveWindow(`${path}.context.native`, context.native);
    const maximum = assertPositiveWindow(`${path}.context.maximum`, context.maximum);
    const effective = assertPositiveWindow(`${path}.context.effective`, context.effective);
    // Semantic consistency, not just types: a window that exceeds its own
    // maximum is not a bound anyone can act on.
    if (native !== null && maximum !== null && native > maximum) {
      throw new CatalogEvidenceError(`${path}.context`, "native exceeds maximum");
    }
    if (effective !== null && maximum !== null && effective > maximum) {
      throw new CatalogEvidenceError(`${path}.context`, "effective exceeds maximum");
    }
    parsed.context = {
      ...(context.native !== undefined ? { native } : {}),
      ...(context.maximum !== undefined ? { maximum } : {}),
      ...(context.effective !== undefined ? { effective } : {}),
      ...(context.method !== undefined
        ? { method: assertLabel(`${path}.context.method`, context.method, CATALOG_EVIDENCE_TEXT_MAX) }
        : {}),
    };
  }
  if (record.effort !== undefined) {
    const effort = assertExactKeys(`${path}.effort`, record.effort, EFFORT_KEYS);
    let choices: string[] | undefined;
    if (effort.choices !== undefined) {
      if (!Array.isArray(effort.choices)) throw new CatalogEvidenceError(`${path}.effort.choices`, "must be an array");
      if (effort.choices.length > CATALOG_EVIDENCE_MAX_LIST) {
        throw new CatalogEvidenceError(`${path}.effort.choices`, `exceeds ${CATALOG_EVIDENCE_MAX_LIST} entries`);
      }
      choices = effort.choices.map((entry, index) =>
        assertLabel(`${path}.effort.choices[${index}]`, entry, CATALOG_EVIDENCE_LIST_ITEM_MAX)
      );
      if (new Set(choices).size !== choices.length) {
        throw new CatalogEvidenceError(`${path}.effort.choices`, "must be unique");
      }
    }
    const selectionDefault = effort.selectionDefault === undefined
      ? undefined
      : assertLabel(`${path}.effort.selectionDefault`, effort.selectionDefault, CATALOG_EVIDENCE_LIST_ITEM_MAX);
    if (selectionDefault !== undefined && choices && !choices.includes(selectionDefault)) {
      throw new CatalogEvidenceError(`${path}.effort`, "selectionDefault is not among choices");
    }
    parsed.effort = {
      ...(choices ? { choices } : {}),
      ...(selectionDefault !== undefined ? { selectionDefault } : {}),
      ...(effort.method !== undefined
        ? { method: assertLabel(`${path}.effort.method`, effort.method, CATALOG_EVIDENCE_TEXT_MAX) }
        : {}),
    };
  }
  if (record.note !== undefined) {
    parsed.note = assertFreeText(`${path}.note`, record.note, CATALOG_EVIDENCE_NOTE_MAX);
  }
  return parsed;
}

/** Validate a whole row's evidence list. */
export function parseCatalogEvidenceList(path: string, raw: unknown): ParsedCatalogEvidence[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new CatalogEvidenceError(path, "must be an array");
  if (raw.length > CATALOG_EVIDENCE_MAX_RECORDS) {
    throw new CatalogEvidenceError(path, `exceeds ${CATALOG_EVIDENCE_MAX_RECORDS} records`);
  }
  return raw.map((entry, index) => parseCatalogEvidenceRecord(`${path}[${index}]`, entry));
}

export function assertCatalogDescription(path: string, raw: unknown): string {
  return assertFreeText(path, raw, CATALOG_DESCRIPTION_MAX);
}

/**
 * Semantic ordering for an evidence list. Order is NOT an authority — two rows
 * carrying the same records in a different order are the same row — so records
 * sort by their stable identity before checksum/diff.
 */
export function sortCatalogEvidence<T extends { kind: string; source: string; observedAt?: string }>(
  records: ReadonlyArray<T>
): T[] {
  // kind/source/observedAt first so the rendered order stays human-meaningful,
  // then the FULL canonical serialization as the final tiebreaker. Without that
  // last term the order is not total: two valid records that agree on the three
  // primary keys but differ elsewhere kept their input order, so the transport
  // order of an evidence array leaked into the content checksum, the per-row
  // diff, and the reduction-confirmation fingerprint.
  return [...records]
    .map((record) => ({ record, key: canonicalJson(record) }))
    .sort((a, b) =>
      a.record.kind.localeCompare(b.record.kind) ||
      a.record.source.localeCompare(b.record.source) ||
      (a.record.observedAt ?? "").localeCompare(b.record.observedAt ?? "") ||
      a.key.localeCompare(b.key)
    )
    .map((entry) => entry.record);
}

/**
 * Deterministic serialization: object keys sorted at every depth, so property
 * insertion order can never change a checksum. Arrays keep their order (it is
 * meaningful for models and effort choices); evidence is pre-sorted by
 * {@link sortCatalogEvidence} where semantic order is wanted.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

/** Keys whose values are observation noise, not catalog substance. */
const VOLATILE_KEYS = new Set(["observedAt", "fetchedAt"]);

/**
 * Canonical serialization with volatile observation timestamps removed.
 *
 * This is the reduction-confirmation identity. Two independent observations of
 * the same reduced catalog differ only in when they were taken, so including
 * `observedAt`/`fetchedAt` would give them different fingerprints and NO
 * reduction could ever be confirmed by repetition.
 */
export function substantiveJson(value: unknown): string {
  return JSON.stringify(stripVolatile(value));
}

function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined || VOLATILE_KEYS.has(key)) continue;
      out[key] = stripVolatile(source[key]);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Exact-key closure for the WHOLE normalized candidate graph.
//
// Closing only description/evidence left the rest of the graph open: undeclared
// keys at candidate, scope, model, context, modalities, effort, choice and
// binding level all crossed the bridge and were persisted inside schema 1. The
// key sets below are the complete, provider-neutral shape; anything else is a
// rejection, at every nesting level.
// ---------------------------------------------------------------------------

const CANDIDATE_KEYS = [
  "schemaVersion", "scope", "models", "source", "sourceVersion",
  "adapterVersion", "cliVersion", "fetchedAt",
] as const;
const SCOPE_KEYS = [
  "fingerprint", "provider", "credentialProfile", "backend", "project", "region", "policy",
] as const;
const MODEL_KEYS = [
  "id", "runtimeId", "displayName", "description", "evidence", "aliases", "default",
  "context", "modalities", "visionMode", "availability", "lifecycle", "serviceTiers",
  "effort", "pricingCategory", "compatibility", "applicationMode", "bindings",
] as const;
const MODEL_CONTEXT_KEYS = ["native", "maximum", "effective"] as const;
const MODALITIES_KEYS = ["input", "output"] as const;
const MODEL_EFFORT_KEYS = ["mechanism", "configId", "choices", "selectionDefault"] as const;
const EFFORT_CHOICE_KEYS = ["id", "raw"] as const;
const BINDING_KEYS = ["model", "effort", "rawModel", "rawEffort"] as const;

/**
 * Reject any key the normalized shape does not declare, everywhere in the graph.
 *
 * Shape only: this never inspects what a value MEANS, so it stays free of any
 * provider vocabulary. Semantic validation (required fields, uniqueness, raw
 * binding coverage) remains core's `validateCandidate`; content screening
 * remains {@link parseCatalogEvidenceList}.
 *
 * Applied before a bridge returns a candidate AND before core persists or loads
 * one, because a remote host is not a trust boundary we can defer past.
 */
export function assertClosedCatalogShape(candidate: unknown): void {
  const root = assertExactKeys("candidate", candidate, CANDIDATE_KEYS);
  assertExactKeys("candidate.scope", root.scope, SCOPE_KEYS);
  if (!Array.isArray(root.models)) {
    throw new CatalogEvidenceError("candidate.models", "must be an array");
  }
  root.models.forEach((raw, index) => {
    const path = `candidate.models[${index}]`;
    const model = assertExactKeys(path, raw, MODEL_KEYS);
    if (model.context !== undefined) {
      assertExactKeys(`${path}.context`, model.context, MODEL_CONTEXT_KEYS);
    }
    if (model.modalities !== undefined) {
      assertExactKeys(`${path}.modalities`, model.modalities, MODALITIES_KEYS);
    }
    if (model.effort !== undefined) {
      const effort = assertExactKeys(`${path}.effort`, model.effort, MODEL_EFFORT_KEYS);
      if (effort.choices !== undefined) {
        if (!Array.isArray(effort.choices)) {
          throw new CatalogEvidenceError(`${path}.effort.choices`, "must be an array");
        }
        effort.choices.forEach((choice, choiceIndex) =>
          assertExactKeys(`${path}.effort.choices[${choiceIndex}]`, choice, EFFORT_CHOICE_KEYS)
        );
      }
    }
    if (model.bindings !== undefined) {
      if (!Array.isArray(model.bindings)) {
        throw new CatalogEvidenceError(`${path}.bindings`, "must be an array");
      }
      model.bindings.forEach((binding, bindingIndex) =>
        assertExactKeys(`${path}.bindings[${bindingIndex}]`, binding, BINDING_KEYS)
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Declared-VALUE validation for the whole candidate graph.
//
// Exact-key closure only says which keys may exist. Without value validation a
// declared field still accepted anything: an object where a version string
// belongs, a fractional context window, 5,000 aliases, or an e-mail address and
// an `~/.ssh` path inside a scope field — all of which then crossed the bridge
// and were serialized into a schema-1 snapshot.
//
// Everything here is shape/format/content policy only. No provider vocabulary.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

/** Cardinality ceilings. Generous for real providers, fatal for a flood. */
export const CATALOG_MAX_MODELS = 512;
export const CATALOG_MAX_ALIASES = 32;
export const CATALOG_MAX_EFFORT_CHOICES = 64;
export const CATALOG_MAX_BINDINGS = 4_096;
export const CATALOG_MAX_MODALITIES = 16;
export const CATALOG_MAX_SERVICE_TIERS = 16;
/** No real context window is larger than this; anything above is nonsense. */
export const CATALOG_MAX_CONTEXT_TOKENS = 100_000_000;

const VISION_MODES = ["native", "tool", "none"];
const AVAILABILITY = ["available", "unavailable"];
const LIFECYCLES = ["stable", "preview", "deprecated", "retired"];
const APPLICATION_MODES = ["live", "reload", "freshSession"];
const EFFORT_MECHANISMS = ["meta", "configOption", "spawnArgs", "modelBaked", "none"];

/** Absolute or home-relative filesystem path, in any field. */
const ABSOLUTE_PATH = /(^|[\s"'(=])(?:[a-zA-Z]:[\\/]|\/|~\/|\.\.\/)/;

function fail(path: string, detail: string): never {
  throw new CatalogEvidenceError(path, detail);
}

/** A required scalar string that must not be an object/array/number. */
function requireLabel(path: string, value: unknown, max = CATALOG_EVIDENCE_TEXT_MAX): string {
  if (typeof value !== "string") {
    fail(path, `must be a string (got ${Array.isArray(value) ? "array" : typeof value})`);
  }
  return assertLabelValue(path, value, max);
}

function optionalLabel(path: string, value: unknown, max = CATALOG_EVIDENCE_TEXT_MAX): string | undefined {
  if (value === undefined) return undefined;
  return requireLabel(path, value, max);
}

function optionalNullableLabel(path: string, value: unknown, max = CATALOG_EVIDENCE_TEXT_MAX): void {
  if (value === undefined || value === null) return;
  requireLabel(path, value, max);
}

/** Shared label policy: bounded, charset-constrained, content-screened. */
function assertLabelValue(path: string, value: string, max: number): string {
  if (!value.length) fail(path, "must not be empty");
  if (value.length > max) fail(path, `exceeds ${max} characters`);
  if (!LABEL_CHARSET.test(value)) fail(path, "contains characters not allowed in an identifier");
  if (ABSOLUTE_PATH.test(value)) fail(path, "must not contain a filesystem path");
  const unsafe = looksUnsafeForCatalog(value, false);
  if (unsafe) fail(path, `rejected content (${unsafe})`);
  return value;
}

/** Human display text: wider than a label, still screened for secrets and PII. */
function requireDisplayText(path: string, value: unknown, max: number): string {
  if (typeof value !== "string") {
    fail(path, `must be a string (got ${Array.isArray(value) ? "array" : typeof value})`);
  }
  if (!value.length) fail(path, "must not be empty");
  if (value.length > max) fail(path, `exceeds ${max} characters`);
  if (ABSOLUTE_PATH.test(value)) fail(path, "must not contain a filesystem path");
  const unsafe = looksUnsafeForCatalog(value, true);
  if (unsafe) fail(path, `rejected content (${unsafe})`);
  return value;
}

/** A context window: finite, integral, positive, and not absurd. */
function requireContextValue(path: string, value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number") fail(path, `must be a number or null (got ${typeof value})`);
  if (!Number.isFinite(value)) fail(path, "must be finite");
  if (!Number.isInteger(value)) fail(path, "must be an integer");
  if (value <= 0) fail(path, "must be positive");
  if (value > CATALOG_MAX_CONTEXT_TOKENS) fail(path, `exceeds ${CATALOG_MAX_CONTEXT_TOKENS}`);
  return value;
}

function requireEnum(path: string, value: unknown, allowed: ReadonlyArray<string>): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(path, `must be one of ${allowed.join(" | ")}`);
  }
  return value;
}

function requireBoundedList(
  path: string,
  value: unknown,
  max: number,
  itemMax: number,
  opts: { requireNonEmpty?: boolean } = {}
): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (opts.requireNonEmpty && value.length === 0) fail(path, "must not be empty");
  if (value.length > max) fail(path, `exceeds ${max} entries`);
  const items = value.map((entry, index) => requireLabel(`${path}[${index}]`, entry, itemMax));
  if (new Set(items).size !== items.length) fail(path, "must be unique");
  return items;
}

/**
 * Scope identity fields carry operator-supplied values that are LEGITIMATELY
 * host-shaped in production — a credential config directory, a base URL. They
 * are sanitized rather than rejected: rejecting would fail every real refresh
 * and take the catalog cold, while keeping the raw value would persist a home
 * path into a durable snapshot that is then transported and rendered.
 *
 * A value that is already a safe identifier is kept verbatim. Anything else is
 * replaced by a stable, non-reversible reference. Scope DISTINCTNESS is
 * preserved because the reference is a function of the original value — and the
 * scope `fingerprint` itself is computed by the adapter from the raw values
 * before this runs, so semantic scope identity is untouched either way.
 */
export function sanitizeScopeIdentifier(value: string): string {
  const safe =
    value.length > 0 &&
    value.length <= CATALOG_EVIDENCE_TEXT_MAX &&
    LABEL_CHARSET.test(value) &&
    !ABSOLUTE_PATH.test(value) &&
    !looksUnsafeForCatalog(value, false);
  if (safe) return value;
  return `ref:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

const HEX_FINGERPRINT = /^[a-f0-9]{64}$/;

/**
 * Validate every DECLARED value in the candidate. PURE — it never mutates.
 *
 * Mutating here was wrong: adapters memoize their scope object (and
 * `asRemoteCatalogAdapter` memoizes the whole candidate), and the service
 * deep-freezes what it publishes, so a second refresh would write to a frozen
 * object. {@link normalizeCatalogCandidate} produces the sanitized COPY that is
 * actually transported and persisted, and this assertion then holds that copy
 * to the strict policy — so a raw unsafe value can never reach a snapshot, and
 * a direct `validateCandidate` on a hostile candidate still refuses it.
 */
export function assertCatalogValues(candidate: unknown): void {
  const root = candidate as Record<string, unknown>;
  if (!root || typeof root !== "object" || Array.isArray(root)) fail("candidate", "must be an object");

  if (!Number.isInteger(root.schemaVersion)) fail("candidate.schemaVersion", "must be an integer");
  if (!Number.isInteger(root.adapterVersion) || (root.adapterVersion as number) < 1) {
    fail("candidate.adapterVersion", "must be a positive integer");
  }
  requireLabel("candidate.source", root.source);
  optionalLabel("candidate.sourceVersion", root.sourceVersion);
  optionalLabel("candidate.cliVersion", root.cliVersion);
  if (typeof root.fetchedAt !== "string" || !Number.isFinite(Date.parse(root.fetchedAt))) {
    fail("candidate.fetchedAt", "must be an ISO-8601 timestamp");
  }

  const scope = root.scope as Record<string, unknown>;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) fail("candidate.scope", "must be an object");
  if (typeof scope.fingerprint !== "string" || !scope.fingerprint.length) {
    fail("candidate.scope.fingerprint", "must be a non-empty string");
  }
  if (!HEX_FINGERPRINT.test(scope.fingerprint)) {
    assertLabelValue("candidate.scope.fingerprint", scope.fingerprint, CATALOG_EVIDENCE_TEXT_MAX);
  }
  requireLabel("candidate.scope.provider", scope.provider);
  for (const field of SCOPE_IDENTITY_FIELDS) {
    const value = scope[field];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      fail(`candidate.scope.${field}`, `must be a string (got ${Array.isArray(value) ? "array" : typeof value})`);
    }
    // Strict here: by the time anything is validated it has been normalized, so
    // a surviving path/PII/credential value means it bypassed the boundary.
    assertLabelValue(`candidate.scope.${field}`, value, CATALOG_EVIDENCE_TEXT_MAX);
  }

  const models = root.models;
  if (!Array.isArray(models)) fail("candidate.models", "must be an array");
  if (models.length > CATALOG_MAX_MODELS) fail("candidate.models", `exceeds ${CATALOG_MAX_MODELS} entries`);
  models.forEach((raw, index) => assertModelValues(`candidate.models[${index}]`, raw));
}

function assertModelValues(path: string, raw: unknown): void {
  const model = raw as Record<string, unknown>;
  if (!model || typeof model !== "object" || Array.isArray(model)) fail(path, "must be an object");

  requireLabel(`${path}.id`, model.id);
  requireLabel(`${path}.runtimeId`, model.runtimeId);
  requireDisplayText(`${path}.displayName`, model.displayName, CATALOG_EVIDENCE_TEXT_MAX);
  if (typeof model.default !== "boolean") fail(`${path}.default`, "must be a boolean");
  requireBoundedList(`${path}.aliases`, model.aliases, CATALOG_MAX_ALIASES, CATALOG_EVIDENCE_TEXT_MAX);
  requireEnum(`${path}.visionMode`, model.visionMode, VISION_MODES);
  requireEnum(`${path}.availability`, model.availability, AVAILABILITY);
  requireEnum(`${path}.lifecycle`, model.lifecycle, LIFECYCLES);
  requireEnum(`${path}.applicationMode`, model.applicationMode, APPLICATION_MODES);
  requireBoundedList(`${path}.serviceTiers`, model.serviceTiers, CATALOG_MAX_SERVICE_TIERS, CATALOG_EVIDENCE_TEXT_MAX);
  optionalNullableLabel(`${path}.pricingCategory`, model.pricingCategory);
  optionalNullableLabel(`${path}.compatibility`, model.compatibility);

  const context = model.context as Record<string, unknown>;
  if (!context || typeof context !== "object" || Array.isArray(context)) fail(`${path}.context`, "must be an object");
  const native = requireContextValue(`${path}.context.native`, context.native);
  const maximum = requireContextValue(`${path}.context.maximum`, context.maximum);
  const effective = requireContextValue(`${path}.context.effective`, context.effective);
  if (native !== null && maximum !== null && native > maximum) {
    fail(`${path}.context`, "native exceeds maximum");
  }
  if (effective !== null && maximum !== null && effective > maximum) {
    fail(`${path}.context`, "effective exceeds maximum");
  }

  const modalities = model.modalities as Record<string, unknown>;
  if (!modalities || typeof modalities !== "object" || Array.isArray(modalities)) {
    fail(`${path}.modalities`, "must be an object");
  }
  requireBoundedList(`${path}.modalities.input`, modalities.input, CATALOG_MAX_MODALITIES, CATALOG_EVIDENCE_LIST_ITEM_MAX, { requireNonEmpty: true });
  requireBoundedList(`${path}.modalities.output`, modalities.output, CATALOG_MAX_MODALITIES, CATALOG_EVIDENCE_LIST_ITEM_MAX, { requireNonEmpty: true });

  const effort = model.effort as Record<string, unknown>;
  if (!effort || typeof effort !== "object" || Array.isArray(effort)) fail(`${path}.effort`, "must be an object");
  const mechanism = requireEnum(`${path}.effort.mechanism`, effort.mechanism, EFFORT_MECHANISMS);
  const configId = optionalLabel(`${path}.effort.configId`, effort.configId, CATALOG_EVIDENCE_LIST_ITEM_MAX);
  if (mechanism === "configOption" && !configId) {
    fail(`${path}.effort.configId`, "is required when mechanism is configOption");
  }
  if (!Array.isArray(effort.choices)) fail(`${path}.effort.choices`, "must be an array");
  if (!effort.choices.length) fail(`${path}.effort.choices`, "must not be empty");
  if (effort.choices.length > CATALOG_MAX_EFFORT_CHOICES) {
    fail(`${path}.effort.choices`, `exceeds ${CATALOG_MAX_EFFORT_CHOICES} entries`);
  }
  const choiceIds = effort.choices.map((choice, index) => {
    const entry = choice as Record<string, unknown>;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`${path}.effort.choices[${index}]`, "must be an object");
    }
    optionalLabel(`${path}.effort.choices[${index}].raw`, entry.raw, CATALOG_EVIDENCE_LIST_ITEM_MAX);
    return requireLabel(`${path}.effort.choices[${index}].id`, entry.id, CATALOG_EVIDENCE_LIST_ITEM_MAX);
  });
  if (new Set(choiceIds).size !== choiceIds.length) fail(`${path}.effort.choices`, "ids must be unique");
  const selectionDefault = requireLabel(
    `${path}.effort.selectionDefault`, effort.selectionDefault, CATALOG_EVIDENCE_LIST_ITEM_MAX
  );
  if (!choiceIds.includes(selectionDefault)) {
    fail(`${path}.effort.selectionDefault`, "is not among the declared choices");
  }

  if (!Array.isArray(model.bindings)) fail(`${path}.bindings`, "must be an array");
  if (model.bindings.length > CATALOG_MAX_BINDINGS) {
    fail(`${path}.bindings`, `exceeds ${CATALOG_MAX_BINDINGS} entries`);
  }
  model.bindings.forEach((binding, index) => {
    const entry = binding as Record<string, unknown>;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      fail(`${path}.bindings[${index}]`, "must be an object");
    }
    requireLabel(`${path}.bindings[${index}].model`, entry.model);
    requireLabel(`${path}.bindings[${index}].effort`, entry.effort, CATALOG_EVIDENCE_LIST_ITEM_MAX);
    requireLabel(`${path}.bindings[${index}].rawModel`, entry.rawModel);
    optionalLabel(`${path}.bindings[${index}].rawEffort`, entry.rawEffort, CATALOG_EVIDENCE_LIST_ITEM_MAX);
  });
}

/** Scope fields that legitimately carry operator/host-shaped values. */
export const SCOPE_IDENTITY_FIELDS = [
  "credentialProfile", "backend", "project", "region", "policy",
] as const;

/**
 * Produce the candidate that is actually transported and persisted: scope
 * identity fields sanitized into safe references, evidence in canonical total
 * order, everything else validated. Never mutates its input, and only copies
 * the parts it must change.
 *
 * Run at BOTH boundaries — before a bridge returns, and before core persists or
 * loads — so a raw home path, e-mail address, or credential can never reach a
 * durable schema-1 snapshot even though the raw value is a legitimate thing for
 * an adapter to have computed locally.
 */
export function normalizeCatalogCandidate<T>(candidate: T): T {
  assertClosedCatalogShape(candidate);
  const root = candidate as unknown as Record<string, unknown>;
  const scope = root.scope as Record<string, unknown>;
  let nextScope: Record<string, unknown> | undefined;
  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    if (typeof scope.fingerprint === "string" && !HEX_FINGERPRINT.test(scope.fingerprint)) {
      const safe = sanitizeScopeIdentifier(scope.fingerprint);
      if (safe !== scope.fingerprint) nextScope = { ...scope, fingerprint: safe };
    }
    for (const field of SCOPE_IDENTITY_FIELDS) {
      const value = (nextScope ?? scope)[field];
      if (typeof value !== "string") continue;
      const safe = sanitizeScopeIdentifier(value);
      if (safe !== value) nextScope = { ...(nextScope ?? scope), [field]: safe };
    }
  }

  const models = root.models;
  let nextModels: unknown[] | undefined;
  if (Array.isArray(models)) {
    models.forEach((raw, index) => {
      const model = raw as Record<string, unknown>;
      if (!model || typeof model !== "object" || Array.isArray(model)) return;
      if (model.evidence === undefined) return;
      const ordered = sortCatalogEvidence(
        parseCatalogEvidenceList(`${String(model.id)}.evidence`, model.evidence)
      );
      const before = model.evidence as unknown[];
      const changed =
        !Array.isArray(before) ||
        before.length !== ordered.length ||
        ordered.some((record, i) => canonicalJson(record) !== canonicalJson(before[i]));
      if (!changed) return;
      nextModels ??= [...models];
      nextModels[index] = { ...model, evidence: ordered };
    });
  }

  const normalized = (nextScope || nextModels
    ? { ...root, ...(nextScope ? { scope: nextScope } : {}), ...(nextModels ? { models: nextModels } : {}) }
    : root) as unknown as T;
  assertCatalogValues(normalized);
  assertCatalogDescriptionsAndEvidence(normalized);
  return normalized;
}

/** Description/evidence content policy, applied to the normalized candidate. */
function assertCatalogDescriptionsAndEvidence(candidate: unknown): void {
  const models = (candidate as Record<string, unknown>).models;
  if (!Array.isArray(models)) return;
  for (const raw of models) {
    const model = raw as Record<string, unknown>;
    const id = typeof model?.id === "string" ? model.id : "(unknown)";
    if (model.description !== undefined) assertCatalogDescription(`${id}.description`, model.description);
    if (model.evidence !== undefined) parseCatalogEvidenceList(`${id}.evidence`, model.evidence);
  }
}
