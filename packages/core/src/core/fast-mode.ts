/**
 * Claude Fast mode policy (#37) — the one place that knows what Fast *means*
 * for a Seam thread. Wire constants live in `@seam/adapters`; this module owns
 * eligibility, the environment kill switch, refusal copy, and applied-state
 * reporting.
 *
 * Fast is a **serving mode for the already-selected model**, not another model
 * and not an effort level. It trades cost efficiency for latency and is billed
 * against usage credits *outside* subscription limits. It is therefore an
 * explicit, opt-in, per-thread **session-start** dimension: it never rides
 * along on a model pick and there are no synthetic `-fast` slugs.
 *
 * Three rules this module exists to keep honest:
 *
 * 1. **Never infer support from a model slug.** Fast support is a property of
 *    the *live session's* `configOptions`, nothing else. Zero-token probes
 *    (`scripts/claude-fast-mode-probe.mjs`) show why: pinned Opus ids
 *    (`claude-opus-5`, `claude-opus-4-8`) advertise config id `fast` as a
 *    select over `on`/`off`, Sonnet does not, and the `default` **alias** has
 *    been observed BOTH ways — advertising Fast when it resolved to Opus 5, and
 *    not advertising it when it resolved to Sonnet. An alias is not a model, so
 *    nothing here may key off the requested slug.
 * 2. **Apply only to a fresh session.** Enabling Fast inside an established
 *    conversation can charge the whole accumulated context at Fast rates, so a
 *    change of this setting forces a new ACP session before it takes effect.
 * 3. **Never confirm what was not applied.** An unsupported session, an
 *    unsupported agent, or the environment kill switch produces a refusal, not
 *    a green check.
 */
import {
  FAST_MODE_CONFIG_ID,
  FAST_MODE_OFF,
  FAST_MODE_ON,
  type FastModeDescriptor,
} from "@seam/adapters";

export {
  FAST_MODE_CONFIG_ID,
  FAST_MODE_ON,
  FAST_MODE_OFF,
  type FastModeDescriptor,
};

/**
 * Upstream kill switch honored by claude-agent-acp. When set, the wrapper drops
 * the `fast` config option entirely (verified live), so Seam must refuse an
 * enable request outright rather than persist a setting that can never apply.
 */
export const FAST_MODE_DISABLE_ENV = "CLAUDE_CODE_DISABLE_FAST_MODE";

/** Shown wherever a user turns Fast on. Fast is not covered by the plan. */
export const FAST_MODE_COST_WARNING =
  "Fast mode prioritizes latency over cost efficiency and consumes paid usage " +
  "credits outside your subscription limits.";

/** Shown wherever changing Fast is about to drop conversation context. */
export const FAST_MODE_RESET_NOTICE =
  "Changing Fast mode starts a fresh Claude session — this thread's conversation " +
  "context is dropped so an established conversation is never silently repriced.";

/**
 * What actually happened to Fast on a live session. `applied` is deliberately
 * nullable: `null` means "not determined on this session" (e.g. a resumed
 * session, which Seam never re-enables Fast on), which is different from
 * "determined to be off".
 */
export interface FastModeOutcome {
  requested: boolean;
  applied: boolean | null;
  /** Present only when `requested` could not be honored. */
  error?: string;
}

/** True when the upstream environment kill switch is set. */
export function isFastModeDisabledByEnv(
  env: Record<string, string | undefined> = process.env
): boolean {
  const raw = env[FAST_MODE_DISABLE_ENV];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no";
}

/** The refusal text for an enable blocked by the environment kill switch. */
export function fastModeEnvRefusal(): string {
  return (
    `Refused: Fast mode is disabled for this deployment by ${FAST_MODE_DISABLE_ENV}. ` +
    `Unset that environment variable and restart the bot to make Fast available. ` +
    `Nothing was changed.`
  );
}

/** The refusal text for an agent that has no Fast-mode concept at all. */
export function fastModeAgentRefusal(agentId: string): string {
  return (
    `Refused: Fast mode is a Claude-only serving mode; agent "${agentId}" does not ` +
    `support it. Nothing was changed.`
  );
}

/**
 * The refusal text for a live session that did not advertise `fast`. This is
 * the model/session-level check — the reason a slug is never enough.
 */
export function fastModeUnsupportedRefusal(
  agentId: string,
  model: string,
  advertised: ReadonlyArray<string> = []
): string {
  return (
    `Refused: the live ${agentId}/${model} session does not advertise config id ` +
    `"${FAST_MODE_CONFIG_ID}", so Fast mode cannot be enabled for it. ` +
    (advertised.length ? `Advertised values: ${advertised.join(", ")}. ` : "") +
    `Pin a model that offers Fast (verified: claude-opus-5, claude-opus-4-8). ` +
    `Note the "default" alias is resolved by the wrapper at session start, so ` +
    `whether it offers Fast depends on what it resolves to that time.`
  );
}

/** Canonical `on` / `off` label used by every Fast surface. */
export function fastModeLabel(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return "unknown";
  return value ? FAST_MODE_ON : FAST_MODE_OFF;
}

/**
 * Whether a request is even eligible before touching a runtime: the agent must
 * declare Fast and the environment must not have killed it. Session-level
 * support is checked separately against live `configOptions`.
 */
export function checkFastModeEligibility(input: {
  requested: boolean;
  agentId: string;
  descriptor: FastModeDescriptor | undefined;
  env?: Record<string, string | undefined>;
}): { ok: true } | { ok: false; error: string } {
  // Turning Fast OFF is always allowed: `off` is the default state, so an
  // unsupported agent is already there and the write is a harmless no-op.
  if (!input.requested) return { ok: true };
  if (!input.descriptor) {
    return { ok: false, error: fastModeAgentRefusal(input.agentId) };
  }
  if (isFastModeDisabledByEnv(input.env ?? process.env)) {
    return { ok: false, error: fastModeEnvRefusal() };
  }
  return { ok: true };
}

/**
 * The ONE rule both mutation surfaces use to decide whether a persisted
 * `fast = true` survives contact with the live session (#37).
 *
 * `/seam config edit` and `configure_thread` each own their own I/O (persist,
 * roll back, report), but the *decision* lives here so the next rule change
 * cannot land in only one of them — which is exactly how the two drifted apart
 * once already.
 *
 * A missing outcome, `applied: false`, and `applied: null` (undetermined) all
 * fail: the contract is "never confirm what was not applied", so anything short
 * of an observed `true` rolls back.
 */
export function settleFastMode(input: {
  outcome: FastModeOutcome | undefined;
  agentId: string;
  model: string;
  advertised?: ReadonlyArray<string>;
}): { ok: true } | { ok: false; refusal: string } {
  if (input.outcome?.applied === true) return { ok: true };
  return {
    ok: false,
    refusal:
      input.outcome?.error ??
      fastModeUnsupportedRefusal(input.agentId, input.model, input.advertised ?? []),
  };
}

/**
 * Whether a pending change needs a FRESH session before Fast can be trusted.
 *
 * Fast is validated per session AND per model: Opus advertises it, Sonnet does
 * not. So changing the model (or agent, or host) under an active Fast setting
 * has to re-run the capability check on a new session, even though the Fast
 * setting itself did not change.
 */
export function fastModeNeedsFreshSession(input: {
  /** Fast state after the pending change. */
  nextFastMode: boolean;
  fastModeChanged: boolean;
  modelChanged?: boolean;
  agentChanged?: boolean;
  locationChanged?: boolean;
}): boolean {
  if (input.fastModeChanged) return true;
  if (!input.nextFastMode) return false;
  return (
    input.modelChanged === true ||
    input.agentChanged === true ||
    input.locationChanged === true
  );
}

/**
 * One-line runtime state for the status/identity card: what was asked for and
 * what the session actually ended up with. Returns undefined when there is
 * nothing worth showing (Fast off and never requested), so ordinary turns are
 * not cluttered with an "off" badge.
 */
export function describeFastModeOutcome(
  outcome: FastModeOutcome | undefined
): string | undefined {
  if (!outcome) return undefined;
  if (outcome.applied === true) return FAST_MODE_ON;
  if (!outcome.requested) return undefined;
  if (outcome.applied === null) return `${FAST_MODE_ON} requested · not applied`;
  return `${FAST_MODE_ON} requested · ${FAST_MODE_OFF} applied`;
}
