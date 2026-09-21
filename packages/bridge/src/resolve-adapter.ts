/**
 * Which adapter serves a slot — and what happens when the answer is "none" (#468).
 *
 * ## The defect
 *
 * `resolveSlotAdapter` returned `undefined` for an `agentId` this bridge does
 * not hold, and `spawnAgent` then fell through to the copilot legacy branch.
 * The requested agent was not spawned, nothing failed, and copilot ran the
 * work. The turn succeeded and the output came from an agent nobody asked for.
 *
 * That is blast radius 5 — silently wrong — which the manifesto ranks below
 * failing outright. It also quietly undid a licensing boundary: Copilot is
 * licensed to FHR, and a constraint enforced by pinning at dispatch time was
 * being unpicked by a fallthrough at spawn time.
 *
 * A second path did the same thing: `adapters.size === 1` returned that
 * adapter for ANY `agentId`, matching or not. A host with one adapter would
 * answer every request with it.
 *
 * ## The rule
 *
 * A stated `agentId` is a requirement, not a hint. If this bridge cannot serve
 * it, the slot is refused and says so. Refusing one slot is blast radius 3
 * against the 5 it replaces, and an unknown id is a configuration error an
 * operator needs to see rather than one that quietly resolves itself.
 *
 * The single-adapter convenience survives only where it is genuinely a
 * convenience: when no id is stated at all. It may no longer override one.
 *
 * ## Why this is a separate module
 *
 * `index.ts` is the CLI entrypoint and `process.exit(1)`s on import, so
 * nothing in it can be reached by a test. #442, #444 and #456 each paid for
 * that lesson with mutations that survived a full suite. The decisions live
 * here; `index.ts` keeps the call.
 */
import type { AgentAdapter } from "@seam/adapters";
import type { SlotSpawnConfig } from "./rpc.js";

export type AdapterResolution =
  /** Serve the slot with this adapter. A `copilot` id still routes to the
   *  legacy inline path, exactly as before. */
  | { kind: "adapter"; adapter: AgentAdapter }
  /** No id was stated and no single adapter applies: the historical
   *  copilot legacy path, unchanged. */
  | { kind: "legacy" }
  /** An id was stated that this bridge cannot serve. Never substitute. */
  | { kind: "unknown"; agentId: string; available: string[] };

export function resolveSlotAdapter(
  adapters: Map<string, AgentAdapter>,
  slotCfg?: SlotSpawnConfig,
): AdapterResolution {
  const id = slotCfg?.agentId;

  if (id) {
    const adapter = adapters.get(id);
    // A stated id that this bridge holds. Note this is checked BEFORE the
    // single-adapter rule below, so a lone adapter can never answer for a
    // different id than the one asked for.
    if (adapter) return { kind: "adapter", adapter };
    return { kind: "unknown", agentId: id, available: [...adapters.keys()].sort() };
  }

  // Nothing was asked for. One adapter is then unambiguous, and an old
  // seam-acp that sends no `agentId` at all must keep working.
  if (adapters.size === 1) {
    const only = [...adapters.values()][0];
    if (only) return { kind: "adapter", adapter: only };
  }
  return { kind: "legacy" };
}

/**
 * Thrown rather than returned so it cannot be ignored by a caller that only
 * pattern-matches the happy path — the shape of mistake that produced the bug.
 */
export class UnknownAgentError extends Error {
  readonly agentId: string;
  readonly available: readonly string[];
  constructor(agentId: string, available: readonly string[]) {
    super(unknownAgentMessage(agentId, available));
    this.name = "UnknownAgentError";
    this.agentId = agentId;
    this.available = available;
  }
}

/**
 * The refusal an operator reads. It names what was asked for and what this
 * host can actually serve, because "unknown agent" without the inventory
 * sends someone to the wrong machine to look.
 */
export function unknownAgentMessage(agentId: string, available: readonly string[]): string {
  const held = available.length ? available.join(", ") : "none";
  return (
    `this bridge cannot serve agent "${agentId}" (holds: ${held}). ` +
    `Refusing the slot rather than substituting another agent.`
  );
}

/**
 * The `exit` frame payload for a slot that could not be spawned.
 *
 * Non-zero by construction: a slot that never started did not succeed, and an
 * old seam-acp reads `code` alone — so the refusal still registers as a
 * stopped slot there, which is the whole point. `spawnError` is additive and
 * carries the reason for anyone who looks.
 */
export function spawnRefusalFrame(err: unknown): { code: number; spawnError: string } {
  return { code: 1, spawnError: err instanceof Error ? err.message : String(err) };
}
