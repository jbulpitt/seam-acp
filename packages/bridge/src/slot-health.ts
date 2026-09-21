import type { ChildProcess } from "node:child_process";

/**
 * What the bridge can say about its slots, as facts it directly observes (#442).
 *
 * Pure and exported so the frame shape is testable without standing up a slot
 * manager — the handler that used to build this inline had no test at all, and
 * four mutations to it survived a full suite.
 *
 * No `midTurn`: the bridge forwards bytes and never parses ACP, so it cannot
 * observe a turn beginning or ending. Reporting one would mean inferring it
 * from "stdin arrived, stdout has not", which re-derives a fact seam-acp holds
 * authoritatively. `lastStdinMsAgo` is given instead, so the owner can make
 * that judgement from evidence rather than from the bridge's guess.
 */
export interface BridgeSlotHealthFrame {
  slot: number;
  alive: boolean;
  pid: number | null;
  /** Null, never 0, when the event has never been observed. */
  lastStdoutMsAgo: number | null;
  lastStdinMsAgo: number | null;
}

export function slotHealthSnapshot(
  slots: ReadonlyMap<number, Pick<ChildProcess, "exitCode" | "signalCode" | "killed" | "pid">>,
  lastStdoutAt: ReadonlyMap<number, number>,
  lastStdinAt: ReadonlyMap<number, number>,
  now: number
): BridgeSlotHealthFrame[] {
  const since = (at: number | undefined): number | null =>
    at === undefined ? null : Math.max(0, now - at);
  return [...slots.entries()].map(([slot, child]) => ({
    slot,
    // Liveness, not an opinion about the turn: no exit code and no signal
    // means the OS still has this process.
    alive: child.exitCode === null && child.signalCode === null && !child.killed,
    pid: child.pid ?? null,
    lastStdoutMsAgo: since(lastStdoutAt.get(slot)),
    lastStdinMsAgo: since(lastStdinAt.get(slot)),
  }));
}

