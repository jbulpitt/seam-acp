/**
 * What to do with a hang report the bridge already measured (#443).
 *
 * The bridge holds the child. `unanswered` means that process did not write a
 * JSON-RPC response onto its own stdout. `not_progressing` means that host's
 * kernel saw this pid's TCP send queue fail to drain. This module does not
 * re-derive either fact from how long seam-acp has been waiting: a quiet turn
 * is only the reason to ask. A missing report — old bridge, command timeout,
 * websocket down — is the link failing, and the turn is left alone.
 */

export const HANG_SILENCE_MS = 60_000;

export interface HangProbeReport {
  probe: "answered" | "unanswered" | "closed";
  providerSocket: "progressing" | "not_progressing" | "unavailable";
}

export type HangAction = "leave" | "retry" | "restart";

const PROBES = new Set<HangProbeReport["probe"]>(["answered", "unanswered", "closed"]);
const SOCKETS = new Set<HangProbeReport["providerSocket"]>(["progressing", "not_progressing", "unavailable"]);

/** A malformed reply is no opinion. Guessing "hung" from it would restart a
 *  live turn because a field was missing. */
export function readHangProbeReport(value: unknown): HangProbeReport | null {
  if (!value || typeof value !== "object") return null;
  const probe = (value as { probe?: unknown }).probe;
  const providerSocket = (value as { providerSocket?: unknown }).providerSocket;
  if (typeof probe !== "string" || !PROBES.has(probe as HangProbeReport["probe"])) return null;
  if (typeof providerSocket !== "string" || !SOCKETS.has(providerSocket as HangProbeReport["providerSocket"])) return null;
  return {
    probe: probe as HangProbeReport["probe"],
    providerSocket: providerSocket as HangProbeReport["providerSocket"],
  };
}

/** Per runtime, not per turn. A child that has never answered a probe has
 *  not shown that this method is implemented. One 3s miss is not a wedge:
 *  these CLIs are single-threaded, and synchronous work during a long tool
 *  call blocks the event loop past the probe timeout. */
export interface HangProbeHistory {
  supported: boolean;
  consecutiveUnanswered: number;
}

export function freshHangHistory(): HangProbeHistory {
  return { supported: false, consecutiveUnanswered: 0 };
}

/**
 * #307: each branch refuses one outcome and leaves the others running.
 *
 * - `restart` — this runtime has answered a probe before, and then missed
 *   two in a row. Deleting the "answered before" gate kills an agent that
 *   drops unknown methods on every quiet minute. Deleting the second-miss
 *   gate kills a child for one 3s stall during ordinary CPU work. One slot.
 *   It does not run on `closed`: that death already has an owner.
 * - `retry` — the event loop answered and the kernel says the peer is not
 *   taking data. Deleting it leaves that turn hung on a dead provider
 *   connection. It does not run on `unavailable`, which is every Mac and
 *   every process with no TCP socket of its own.
 * - `leave` — one miss, a runtime that has never answered, a working
 *   socket, or no report. The turn keeps going.
 */
export function decideHang(report: HangProbeReport | null, history: HangProbeHistory): HangAction {
  if (!report || report.probe === "closed") return "leave";
  if (report.probe === "answered") {
    history.supported = true;
    history.consecutiveUnanswered = 0;
    return report.providerSocket === "not_progressing" ? "retry" : "leave";
  }
  // unanswered. A runtime that has never produced a probe response is not
  // wedged; the probe is unsupported until one answer proves otherwise.
  if (!history.supported) return "leave";
  history.consecutiveUnanswered += 1;
  return history.consecutiveUnanswered >= 2 ? "restart" : "leave";
}

/**
 * Ask once the turn has been quiet for `silenceMs`, then again after each
 * further quiet window if the answer was "still working". Stops when the
 * turn ends or the caller aborts. Never probes an idle runtime: `inFlight`
 * is the seam-acp fact "a prompt is outstanding", which the bridge does not
 * have and must not invent.
 */
export async function watchRemoteHang(opts: {
  silenceMs: number;
  signal: AbortSignal;
  lastActivityAt: () => number;
  inFlight: () => boolean;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  probe: () => Promise<HangProbeReport | null>;
  /** Called for retry and restart. The watch keeps going afterwards so a
   *  retried attempt that goes quiet again is probed again. Restart is
   *  expected to abort the signal by ending the turn. */
  onAction?: (action: Exclude<HangAction, "leave">) => void | Promise<void>;
}): Promise<void> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const history = freshHangHistory();
  while (!opts.signal.aborted && opts.inFlight()) {
    const quietFor = now() - opts.lastActivityAt();
    if (quietFor < opts.silenceMs) {
      await sleep(opts.silenceMs - quietFor, opts.signal);
      continue;
    }
    if (opts.signal.aborted || !opts.inFlight()) return;
    const action = decideHang(await opts.probe().catch(() => null), history);
    if (action !== "leave") await opts.onAction?.(action);
    if (opts.signal.aborted || !opts.inFlight()) return;
    await sleep(opts.silenceMs, opts.signal);
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
