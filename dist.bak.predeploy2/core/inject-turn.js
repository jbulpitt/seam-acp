/**
 * Types for `Orchestrator.injectTurn` — the single primitive for running an
 * agent turn **programmatically** (no Discord user message behind it).
 *
 * Three call paths grew independently — the scheduled-prompt runner, the
 * premium-compaction fan-out, and the normal live turn — and all bottom out at
 * `AgentRuntime.prompt()`. They differ only in (a) how the session is acquired,
 * (b) where output is routed, and (c) teardown. `injectTurn` owns that
 * lifecycle once so the seam-MCP work (handoff / forward / report-back) has one
 * entry point instead of three near-copies.
 *
 * The types live here rather than in `orchestrator.ts` so callers outside the
 * Discord platform layer can depend on the contract without importing the
 * 6.5k-line orchestrator.
 */
/** Discriminate the two `InjectTarget` shapes. `agentId` exists only on
 *  `SessionRecord`; `ChannelRef` is `{ platform, id, parentId? }`. */
export function isSessionRecord(target) {
    return "agentId" in target;
}
//# sourceMappingURL=inject-turn.js.map