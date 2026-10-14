/** Shared Fast policy: live capability, descriptor-owned reset, observed state. */
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

/** Claude's paid-credit warning. Codex uses its own quota/credit notice. */
export const FAST_MODE_COST_WARNING =
  "Fast mode prioritizes latency over cost efficiency and consumes paid usage " +
  "credits outside your subscription limits.";

export function fastModeCostWarning(descriptor?: FastModeDescriptor): string {
  return descriptor?.applicationMode === "live"
    ? "Fast mode prioritizes latency and increases usage. Codex uses more subscription quota or purchased credits."
    : FAST_MODE_COST_WARNING;
}

/** Shown wherever changing Fast is about to drop conversation context. */
export const FAST_MODE_RESET_NOTICE =
  "Changing Fast mode starts a fresh Claude session — this thread's conversation " +
  "context is dropped so an established conversation is never silently repriced.";

/**
 * What actually happened to Fast on a live session. `applied` is deliberately
 * nullable: `null` means "not determined on this session", which differs from
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
    `Refused: agent "${agentId}" does not declare a Fast-mode option. Nothing was changed.`
  );
}

/**
 * The refusal text for a live session that did not advertise `fast`. This is
 * the model/session-level check — the reason a slug is never enough.
 */
export function fastModeUnsupportedRefusal(
  agentId: string,
  model: string,
  advertised: ReadonlyArray<string> = [],
  configId = FAST_MODE_CONFIG_ID
): string {
  if (configId !== FAST_MODE_CONFIG_ID) {
    return `Refused: the live ${agentId}/${model} session does not advertise config id "${configId}" for this model, so Fast mode is unavailable.`;
  }
  return (
    `Refused: the live ${agentId}/${model} session does not advertise config id ` +
    `"${FAST_MODE_CONFIG_ID}", so Fast mode cannot be enabled for it. ` +
    (advertised.length ? `Advertised values: ${advertised.join(", ")}. ` : "") +
    `Pin a model that offers Fast (verified: claude-opus-5, claude-opus-4-8). ` +
    `Note the "default" alias is resolved by the wrapper at session start, so ` +
    `whether it offers Fast depends on what it resolves to that time.`
  );
}

/**
 * The one thing worse than an unverified Fast session is an unverified Fast
 * session we FAILED to discard: it may still be serving and billing Fast while
 * every surface reads `off`. That is never a success — it is a critical,
 * user-visible condition with a concrete recovery action.
 */
export function fastModeRetirementFailure(detail: string): string {
  return (
    `🚨 Fast mode was rolled back, but the session it may have enabled could NOT ` +
    `be discarded (${detail}). That session may still be serving — and billing — ` +
    `Fast mode even though this thread now reads "off". Run \`/seam config reset\` ` +
    `in that thread to force a clean session before sending another turn.`
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
  if (input.descriptor.configId === FAST_MODE_CONFIG_ID && isFastModeDisabledByEnv(input.env ?? process.env)) {
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
  configId?: string;
}): FastModeSettlement {
  if (input.outcome?.applied === true) return { ok: true };
  // Rolling the flag back is not enough when we never OBSERVED the session
  // land on `off`: an accepted-but-unechoed enable may genuinely have put the
  // live session into Fast, which would keep billing while the UI reads off.
  // Only a positively observed `applied: false` proves otherwise; `null`
  // (undetermined) and a missing outcome do not. The session in question was
  // just forged and holds no user context, so discarding it costs nothing.
  const observedOff = input.outcome?.applied === false;
  const refusal =
    input.outcome?.error ??
    fastModeUnsupportedRefusal(input.agentId, input.model, input.advertised ?? [], input.configId);
  return {
    ok: false,
    retireSession: !observedOff,
    refusal: observedOff
      ? refusal
      : `${refusal} The replacement session was discarded because it could not be ` +
        `confirmed Fast-free; the next turn starts a clean one with Fast off.`,
  };
}

export type FastModeSettlement =
  | { ok: true }
  | {
      ok: false;
      refusal: string;
      /**
       * True when the just-created session must ALSO be retired, because we
       * could not observe it landing on `off` and it may therefore be serving
       * (and billing) Fast despite the persisted flag now reading false.
       */
      retireSession: boolean;
    };

/** Claude changes require a fresh session; live descriptors preserve context. */
export function fastModeNeedsFreshSession(input: {
  descriptor?: FastModeDescriptor;
  /** Fast state after the pending change. */
  nextFastMode: boolean;
  fastModeChanged: boolean;
  modelChanged?: boolean;
  agentChanged?: boolean;
  locationChanged?: boolean;
}): boolean {
  if (input.descriptor?.applicationMode === "live") return false;
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
  if (!outcome.requested && outcome.applied === null && outcome.error) return "off requested · not applied";
  if (!outcome.requested) return undefined;
  if (outcome.applied === null) return `${FAST_MODE_ON} requested · not applied`;
  return `${FAST_MODE_ON} requested · ${FAST_MODE_OFF} applied`;
}
