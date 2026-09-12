/**
 * What makes resuming an interrupted turn WRONG (#302).
 *
 * This used to be a SHA-256 over the selection plus every `CODEX_|OPENAI_|…`
 * environment value and the contents of `~/.codex/auth.json` and
 * `config.toml`. Both of those drift for reasons that have nothing to do with
 * where the work belongs: `auth.json` rotates on token refresh, `config.toml`
 * changed at 11:55 UTC on 2026-09-10 and permanently orphaned five attempts
 * created earlier the same morning. A digest never returns to a previous
 * value, so any such drift stranded suspended work forever.
 *
 * So this records only the fields whose change would make a resume land in the
 * wrong place, and it records them as PLAIN VALUES rather than a digest, so a
 * refusal can say "thread switched from codex to claude" instead of printing
 * two hex strings that differ for an unstated reason.
 *
 * A rotated credential does not change which session the work belongs to. What
 * bounds a resume is the recorded ACP session id and the provider's own answer
 * when we try to reattach to it — not an ambient fingerprint taken here.
 */

/** The comparable record. Stored verbatim in `turn_attempts.identity`. */
export interface ExecutionIdentity {
  version: 2;
  /** Which adapter the work was addressed to. */
  agent: string;
  /** Local vs a named bridge: a session recorded on one cannot be resumed on another. */
  location: string;
  /** live vs isolated: continuing an isolated worker inside a live thread is a different turn. */
  session: string;
  model: string;
  effort: string;
  cwd: string;
  /** Thread configuration that selects routing, canonicalised. */
  config: string;
}

export interface ExecutionIdentityInput {
  agent?: unknown;
  agentId?: unknown;
  location?: unknown;
  session?: unknown;
  model?: unknown;
  effort?: unknown;
  cwd?: unknown;
  config?: unknown;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return canonicalJson(value);
}

/**
 * Configuration that has not changed must compare equal no matter which call
 * site recorded it. Admission passes the session's raw `configJson` (pretty
 * printed, and carrying `lastContextUsage`), while the resume check passes the
 * parsed object with that key already removed. `text` returned a string
 * verbatim, so those two spellings of an IDENTICAL configuration never matched
 * and every such resume was refused as "thread configuration changed".
 *
 * `lastContextUsage` is a usage statistic that is rewritten after every turn,
 * so leaving it inside the record would make an untouched thread drift out of
 * its own identity. Both concerns are settled here, once, rather than at each
 * caller — the asymmetry is exactly what a per-caller convention produced.
 */
const VOLATILE_CONFIG_KEYS = new Set(["lastContextUsage"]);

function configIdentity(value: unknown): string {
  if (value === null || value === undefined) return "";
  let parsed: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Not JSON: it is some other opaque marker, so compare it verbatim
      // rather than inventing a shape for it.
      return value;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return canonicalJson(parsed);
  const stable = Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter(([key]) => !VOLATILE_CONFIG_KEYS.has(key))
  );
  return canonicalJson(stable);
}

/** Key-sorted JSON so an equal configuration always compares equal. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Build the comparable record. Call sites historically spelled the adapter
 * `agent` or `agentId`; both are accepted so one shape is stored everywhere and
 * comparisons stay meaningful across paths.
 */
export function executionIdentity(input: ExecutionIdentityInput): string {
  const identity: ExecutionIdentity = {
    version: 2,
    agent: text(input.agent ?? input.agentId),
    location: text(input.location),
    session: text(input.session),
    model: text(input.model),
    effort: text(input.effort),
    cwd: text(input.cwd),
    config: configIdentity(input.config),
  };
  return canonicalJson(identity);
}

export type IdentityComparison =
  | { match: true; legacy: boolean }
  | { match: false; field: keyof ExecutionIdentity; reason: string };

export interface LegacyIdentityContext {
  promptStarted: boolean;
  acpSessionId: string | null | undefined;
}

function parse(raw: string): ExecutionIdentity | null {
  try {
    const value = JSON.parse(raw) as Partial<ExecutionIdentity>;
    if (!value || typeof value !== "object" || value.version !== 2) return null;
    return value as ExecutionIdentity;
  } catch {
    return null;
  }
}

const LABEL: Record<Exclude<keyof ExecutionIdentity, "version">, (a: string, b: string) => string> = {
  agent: (a, b) => `thread switched from ${a || "(unset)"} to ${b || "(unset)"}`,
  location: (a, b) => `thread moved from ${a || "(unset)"} to ${b || "(unset)"}`,
  session: (a, b) => `session kind changed from ${a || "(unset)"} to ${b || "(unset)"}`,
  model: (a, b) => `model changed from ${a || "(unset)"} to ${b || "(unset)"}`,
  effort: (a, b) => `effort changed from ${a || "(unset)"} to ${b || "(unset)"}`,
  cwd: (a, b) => `working directory changed from ${a || "(unset)"} to ${b || "(unset)"}`,
  config: () => "thread configuration changed",
};

/**
 * Compare a stored identity with the current one and name the first field that
 * differs, in terms an operator can act on.
 *
 * A stored value that is not a version-2 record is a pre-#302 digest, which
 * cannot say which field differs and whose inputs drifted on their own. It is
 * safe to tolerate only for a prompted attempt carrying a recorded ACP session
 * id: strict session/load either reattaches to that conversation or refuses.
 * A never-prompted legacy attempt has no session id and therefore no equivalent
 * bound; accepting it would replay the original brief under today's selection.
 */
export function compareExecutionIdentity(
  stored: string,
  current: string,
  legacyContext?: LegacyIdentityContext,
): IdentityComparison {
  const before = parse(stored);
  const after = parse(current);
  if (!before) {
    if (legacyContext?.promptStarted && legacyContext.acpSessionId) {
      return { match: true, legacy: true };
    }
    const reason = legacyContext?.promptStarted
      ? "prompted legacy attempt has no recorded ACP session id; it cannot be reattached safely"
      : "never-prompted legacy attempt has no recorded ACP session id; abandon it and resend under the current configuration";
    return { match: false, field: "version", reason };
  }
  if (!after) {
    return { match: false, field: "version", reason: "current execution identity is not a version-2 record" };
  }
  if (stored === current) return { match: true, legacy: false };
  for (const field of Object.keys(LABEL) as Array<Exclude<keyof ExecutionIdentity, "version">>) {
    // Rows written before the spelling was settled hold the raw pretty-printed
    // configJson. Normalising BOTH sides here means those attempts resume on
    // their own rather than needing a migration to rewrite history, and a
    // configuration that genuinely differs still differs after normalising.
    const [a, b] = field === "config"
      ? [configIdentity(before[field]), configIdentity(after[field])]
      : [before[field], after[field]];
    if (a !== b) return { match: false, field, reason: LABEL[field](a, b) };
  }
  return { match: true, legacy: false };
}
