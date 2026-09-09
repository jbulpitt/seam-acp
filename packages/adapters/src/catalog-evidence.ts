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
