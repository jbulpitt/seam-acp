/**
 * Claude Fast-mode protocol facts (#37).
 *
 * Fast is a **serving mode for the already-selected model** — not another
 * model, not an effort level. It trades cost efficiency for latency and is
 * billed against usage credits *outside* subscription limits, so Seam models it
 * as its own explicit opt-in dimension and never as a synthetic `-fast` slug.
 *
 * Only the wire contract lives here (adapters cannot import core). The policy
 * around it — environment kill switch, refusal copy, applied-state reporting —
 * lives in `@seam/core`'s `core/fast-mode.ts`.
 */

/** ACP session config id claude-agent-acp exposes Fast mode under. */
export const FAST_MODE_CONFIG_ID = "fast";
/** Value that enables Fast. Upstream uses `on`/`off`, NOT `true`/`false`. */
export const FAST_MODE_ON = "on";
/** Value that disables Fast. */
export const FAST_MODE_OFF = "off";

/**
 * How an agent exposes Fast mode. A profile declaring this is a *claim of
 * eligibility*, never proof: the live session's `configOptions` is the only
 * authority, because support varies by model AND by wrapper build.
 *
 * Verified live with a zero-token ACP probe (2026-09-03,
 * `scripts/claude-fast-mode-probe.mjs`, clean env):
 *   - `claude-opus-5`   → resolves to opus, advertises `fast`
 *                         (select, `on`/`off`, current `off`; both accepted)
 *   - `claude-opus-4-8` → resolves to itself, advertises `fast` (same shape)
 *   - `claude-sonnet-5` → resolves to sonnet, does NOT advertise it
 *   - `default` (ALIAS) → depends on what the wrapper resolves it to that
 *                         session: observed advertising `fast` when it resolved
 *                         to Opus 5, and NOT advertising it when it resolved to
 *                         Sonnet. Never treat the alias as a capability.
 */
export interface FastModeDescriptor {
  /** ACP session config id (`fast`). */
  readonly configId: string;
  /** Value that enables it (`on`). */
  readonly onValue: string;
  /** Value that disables it (`off`). */
  readonly offValue: string;
}

/** The descriptor every direct-Anthropic Claude profile declares. */
export const CLAUDE_FAST_MODE: FastModeDescriptor = {
  configId: FAST_MODE_CONFIG_ID,
  onValue: FAST_MODE_ON,
  offValue: FAST_MODE_OFF,
};
