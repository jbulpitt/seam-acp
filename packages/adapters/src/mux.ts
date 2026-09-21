/**
 * Resilient multiplexed transport over a shared WebSocket.
 * Extracted into @seam/adapters (PR2); copilot-remote profiles were removed in PR0.
 */
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessByStdio } from "node:child_process";
import type {
  Readable as NodeReadable,
  Writable as NodeWritable,
} from "node:stream";
import { WebSocket } from "ws";
import type { EventFrame, HelloFrame, RpcReplyFrame } from "./command-bus.js";
import { PROTOCOL_VERSION } from "./command-bus.js";

/**
 * How long spawn() will wait for a bridge connection before emitting an error
 * (just under AgentRuntime's 45 s START_TIMEOUT_MS so errors are actionable).
 */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Bridge liveness (#427).
 *
 * A half-open socket — TCP gone with no FIN or RST, the ordinary outcome
 * through a proxy or tunnel — leaves `readyState === OPEN` on both ends
 * forever. `rpc()`'s offline guard passes, the frame goes into the void, and
 * the caller waits out the generic 30s timeout. Nothing ever closes the socket,
 * so the client's (correct) reconnect-on-close never fires and the thread is
 * dead permanently.
 *
 * Liveness is inferred from traffic the bridge ALREADY sends before any probe
 * is issued. The client pings every 25s, and `ws` answers an inbound ping at
 * protocol level, so on a healthy connection the server hears something at
 * least that often and these timers cost nothing.
 *
 * The active probe exists only for the case inference cannot cover: a client
 * that is quiet and does not ping. Terminating on silence alone would kill such
 * a connection even though it is healthy — the exact failure mode that would be
 * worse than the bug. Asking first turns "no evidence" into "we asked and got
 * nothing", which is a different and much safer claim.
 */
const LIVENESS_SILENCE_MS = 35_000;
/**
 * Grace for the probe to be answered. Sized against the client's 25s ping
 * rather than chosen: 35s tolerates one entirely missed ping plus jitter, and
 * the extra 10s tolerates a slow round trip on a path that is merely
 * congested. Two consecutive missed pings AND an unanswered probe is the bar
 * for calling a socket dead — worst case ~50s, after which the client's
 * existing 5s reconnect makes the thread usable again inside a minute.
 */
const LIVENESS_PROBE_GRACE_MS = 10_000;
/** Sweep granularity. Cheap: one timer per attached bridge socket. */
const LIVENESS_TICK_MS = 5_000;

/**
 * #444: consecutive unparseable frames before the stream is declared corrupt.
 * One is a glitch worth counting; three in a row without a single good frame
 * between them means the framing itself is wrong, and continuing to drop
 * messages silently is the failure this replaces.
 */
const MAX_CONSECUTIVE_PARSE_FAILURES = 3;

/**
 * A bridge RPC that failed because the peer is gone, as distinct from an
 * operation that is merely slow (#427).
 *
 * The two used to be indistinguishable — both surfaced as
 * `rpc 'spawn' timed out after 30s` — which sent every investigation towards
 * "why is spawn slow" when the answer was "the connection died 30 seconds ago".
 * The bridge's spawn handler does pure config work and launches nothing, so a
 * 30s wait there was never measuring slowness.
 */
/**
 * What the bridge directly observes about one slot (#442).
 *
 * Deliberately has no `midTurn`. The bridge is a byte mux: it forwards frames
 * and never parses ACP, so it cannot see a `session/prompt` begin or end. It
 * would have to INFER mid-turn from "stdin arrived and stdout has not", which
 * is the mistake the manifesto names — when the authoritative fact exists
 * somewhere, do not re-derive it somewhere else. seam-acp holds that fact.
 *
 * So the bridge reports what it can see, and `lastStdinMsAgo` is the piece
 * that makes the seam-acp-side judgement possible: silence since input is
 * suspicious, silence with no input is just idle.
 */
export interface BridgeSlotHealth {
  slot: number;
  alive: boolean;
  pid: number | null;
  /** Null when the bridge has never observed the event, never 0. */
  lastStdoutMsAgo: number | null;
  lastStdinMsAgo: number | null;
}

export class BridgeUnreachableError extends Error {
  readonly bridgeUnreachable = true;
  /**
   * Was the call already on the wire when the transport died?
   *
   * This is the distinction a caller must not get wrong. The bridge's `spawn`
   * handler configures the slot and returns, so a request that reached it may
   * have been fully APPLIED even though the reply could never come back — the
   * bridge answers on the socket it was asked on, and that socket is gone.
   *
   *   false — never sent. The outcome is known: nothing happened.
   *   true  — sent, fate unknown. Safe to retry only if the operation is
   *           idempotent; callers must not infer the slot is unconfigured.
   *
   * No retry policy is imposed here. #421/#424 own how callers degrade, and a
   * third policy buried in the transport would be invisible to both.
   */
  readonly outcomeUnknown: boolean;
  constructor(message: string, outcomeUnknown: boolean) {
    super(message);
    this.name = "BridgeUnreachableError";
    this.outcomeUnknown = outcomeUnknown;
  }
}

// ---------------------------------------------------------------------------
// Multiplexed message protocol
// ---------------------------------------------------------------------------
// Every WS message in both directions is a JSON object:
//   { slot: number, type: "data" | "kill" | "exit", data?: string, code?: number }
//
//   "data"  — ACP payload (UTF-8 text)
//   "kill"  — seam-acp → bridge: terminate the agent for this slot
//   "exit"  — bridge → seam-acp: agent exited (with exit code)
//
// This lets a single WS connection serve multiple concurrent sessions.

interface MuxMsg {
  slot?: number;
  /** #444: per-slot output sequence. Absent from an older bridge. */
  seq?: number;
  type:
    | "data"
    | "kill"
    | "exit"
    | "cmd"
    | "cmd_reply"
    | "hello"
    | "hello_ack"
    | "rpc"
    | "rpc_reply"
    | "event"
    | "ping"
    | "pong"
    | "bridge_hello";
  data?: string;
  code?: number;
  cmdId?: string;
  action?: string;
  payload?: any;
  error?: string;
  v?: number;
  id?: string;
  agentId?: string;
  method?: string;
  params?: unknown;
  result?: unknown;
  ok?: boolean;
  instanceId?: string;
  bridgeId?: string;
  protocolVersion?: number;
  name?: string;
}

interface SlotEntry {
  stdout: PassThrough;
  fake: FakeProcess;
  /** ACP chunks buffered while the bridge is offline or waiting for rpc spawn. */
  stdinQueue: string[];
  killed: boolean;
  /** When true, queue stdin even if the WS is open (rpc spawn not yet acked). */
  holdStdin: boolean;
}

/** Optional mux.spawn() argument. Local `profile.spawn(model?, effort?)` is unchanged. */
export interface MuxSpawnOpts {
  /**
   * Queue stdin (even on an open WS) until `releaseStdin(slot)`. Used so
   * `rpc("spawn", …)` can fill `slotConfigs` before the first ACP `data` frame.
   */
  holdStdinUntilReady?: boolean;
}

/** Fake child returned by `mux.spawn()`. `slot` is the mux slot id. */
export type MuxChild = ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable> & {
  readonly slot: number;
};

type FakeProcess = EventEmitter & {
  stdin: NodeWritable;
  stdout: NodeReadable;
  stderr: NodeReadable;
  readonly killed: boolean;
  kill(): void;
};

// ---------------------------------------------------------------------------
// Shared mux logic
// ---------------------------------------------------------------------------

/**
 * Creates a multiplexed session manager over a shared WebSocket.
 *
 * - `attach(ws)` — called whenever a new bridge WS arrives; replaces the old one.
 * - `spawn(opts?)` — allocates a slot and returns a fake ChildProcess with
 *   `.slot`; stdin/stdout are routed through the shared WS. Pass
 *   `{ holdStdinUntilReady: true }` to queue stdin until `releaseStdin(slot)`
 *   so `rpc("spawn")` can configure the slot before the first `data` frame.
 *
 * When the bridge is offline, stdin data is queued and flushed on reconnect.
 * Fake processes survive bridge reconnects transparently.
 */
export function makeMux(opts: {
  id: string;
  onBridgeConnect?: () => void;
  onHello?: (hello: HelloFrame) => void;
  onEvent?: (event: EventFrame) => void;
  onDisconnect?: () => void;
  /** #444: observed when a frame cannot be parsed. Diagnostics only. */
  onParseFailure?: (consecutive: number) => void;
  /**
   * #444: observed when replay reports output that was lost to retention.
   * Surfaced rather than hidden — a consumer that cannot tell "here is the
   * rest" from "some of it is gone" splices unrelated stream points together.
   */
  onOutputGap?: (
    slot: number,
    gap: { afterSeq: number; firstAvailableSeq: number; droppedFrames: number }
  ) => void;
  /**
   * #442: per-slot health as the BRIDGE observed it, delivered on every
   * same-instance reconnect probe. Facts only — liveness and silence — with
   * no verdict attached, because whether silence means a stuck turn depends
   * on whether a prompt is outstanding, and that fact lives in seam-acp.
   */
  onSlotHealth?: (health: readonly BridgeSlotHealth[]) => void;
  /** #427: fired when liveness terminates a socket, before `close`. */
  onLivenessTimeout?: () => void;
  /**
   * #427: liveness timings, overridable so a test can drive the REAL monitor
   * on real timers in milliseconds instead of waiting out the production
   * window. Production never sets this.
   */
  liveness?: { silenceMs?: number; graceMs?: number; tickMs?: number };
}) {
  let bridgeWs: WebSocket | null = null;
  let lastBridgeInstanceId: string | undefined;
  let nextSlot = 0;
  const slots = new Map<number, SlotEntry>();
  /** Timeout handles for spawn() calls waiting for the bridge to come online. */
  const bridgeWaiters: Array<{ slot: number; timeout: ReturnType<typeof setTimeout> }> = [];
  const pendingCmds = new Map<string, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  const pendingRpcs = new Map<string, { resolve: (val: unknown) => void; reject: (err: Error) => void }>();

  function send(msg: MuxMsg) {
    if (bridgeWs?.readyState === WebSocket.OPEN) {
      bridgeWs.send(JSON.stringify(msg));
    }
  }

  function flushQueues() {
    for (const [slot, entry] of slots) {
      if (!entry.killed && !entry.holdStdin && entry.stdinQueue.length > 0) {
        for (const text of entry.stdinQueue.splice(0)) {
          send({ slot, type: "data", data: text });
        }
      }
    }
  }

  function releaseStdin(slot: number): void {
    const entry = slots.get(slot);
    if (!entry) return;
    entry.holdStdin = false;
    if (entry.killed) return;
    if (bridgeWs?.readyState === WebSocket.OPEN && entry.stdinQueue.length > 0) {
      for (const text of entry.stdinQueue.splice(0)) {
        send({ slot, type: "data", data: text });
      }
    }
  }

  /**
   * Settle everything waiting on a socket that can no longer answer (#427).
   *
   * `pendingRpcs` and `pendingCmds` were each settled in exactly two places:
   * a matching reply frame, or their own 30s timer. Neither `close` nor
   * `error` nor `attach()`'s replacement of the incumbent touched them — so
   * every call in flight across an ORDINARY reconnect was orphaned and burned
   * the full 30s before failing with `rpc '<m>' timed out after 30s`. With a
   * 5s reconnect delay and Mac sleep, wifi blips and cloudflared restarts,
   * that is routine rather than exotic: the transport is known dead at close
   * time and we waited half a minute anyway.
   *
   * Everything settled here is `outcomeUnknown: true` — it was on the wire.
   */
  function settleInFlight(why: string): void {
    for (const [id, { reject }] of [...pendingRpcs]) {
      pendingRpcs.delete(id);
      reject(new BridgeUnreachableError(why, true));
    }
    for (const [id, { reject }] of [...pendingCmds]) {
      pendingCmds.delete(id);
      reject(new BridgeUnreachableError(why, true));
    }
  }

  /**
   * #444: how far this consumer has consumed each slot's output stream.
   *
   * This is the entire disconnection story. The cursor is durable across
   * sockets, so a drop does not need handling — it just stops advancing — and
   * catch-up is "ask for everything after where I was".
   */
  const outputCursor = new Map<number, number>();
  /**
   * #444: `catch { return; }` silently dropped an unparseable frame, so a
   * corrupt stream degraded into missing messages nobody could see. Counted
   * instead: isolated corruption is tolerated, repetition means the stream is
   * no longer trustworthy and limping on is worse than restarting.
   */
  let parseFailures = 0;

  function attach(newWs: WebSocket) {
    // Replace the old bridge connection.
    if (bridgeWs && bridgeWs !== newWs) {
      // #427: the incumbent's replies can never arrive once it is replaced —
      // the bridge answers on the socket it was asked on. Settled HERE rather
      // than in the old socket's `close` handler, because by the time that
      // fires `bridgeWs` already points at the new socket and the handler's
      // `bridgeWs === newWs` identity guard (correctly) skips it.
      settleInFlight("Remote bridge reconnected before the reply arrived.");
      if (bridgeWs.readyState === WebSocket.OPEN) {
        bridgeWs.close(1001, "replaced by new bridge connection");
      }
    }
    bridgeWs = newWs;

    // Notify listener that a fresh bridge connection arrived.
    opts.onBridgeConnect?.();

    // All pending spawn() calls can now proceed.
    for (const { timeout } of bridgeWaiters.splice(0)) {
      clearTimeout(timeout);
    }

    // Send any stdin that arrived while the bridge was offline.
    flushQueues();

    // #427: per-SOCKET liveness. Scoped to this connection on purpose — there
    // is one mux per bridge id, so what this refuses is exactly one bridge's
    // websocket. The hub, every other bridge, and all local agents keep
    // working; the only consequence is that THIS bridge is forced to notice it
    // is gone and reconnect, which is what it would already do if the socket
    // had closed honestly.
    const silenceMs = opts.liveness?.silenceMs ?? LIVENESS_SILENCE_MS;
    const graceMs = opts.liveness?.graceMs ?? LIVENESS_PROBE_GRACE_MS;
    const tickMs = opts.liveness?.tickMs ?? LIVENESS_TICK_MS;
    let lastSeenAt = Date.now();
    let probeSentAt: number | null = null;
    const sawTraffic = (): void => {
      lastSeenAt = Date.now();
      probeSentAt = null;
    };
    // Any inbound frame is liveness evidence, and `ws` emits `ping`/`pong`
    // separately from `message` — the client's existing 25s ping arrives here
    // and is answered by the library, so a healthy connection never reaches the
    // probe below.
    newWs.on("ping", sawTraffic);
    newWs.on("pong", sawTraffic);

    // Liveness needs a socket that can be PROBED. `attach()` also accepts
    // minimal stand-ins (tests, and any future non-ws transport), and a monitor
    // that assumed the full API turned one missing method into a throw inside
    // attach — taking down the connection it was meant to protect. What is
    // refused when these are absent is liveness detection for that one socket;
    // message routing, RPC, spawn and the close/error settlement all continue.
    const canProbe = typeof (newWs as { ping?: unknown }).ping === "function"
      && typeof (newWs as { terminate?: unknown }).terminate === "function";
    const liveness = canProbe ? setInterval(() => {
      try {
        if (newWs.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        if (probeSentAt !== null) {
          if (now - probeSentAt >= graceMs) {
            opts.onLivenessTimeout?.();
            // terminate(), not close(): close() writes a frame and waits for a
            // reply that a half-open peer will never send, which is the same
            // hang one level down. terminate() destroys the socket locally and
            // fires `close`, which is the event the client's reconnect needs.
            newWs.terminate();
          }
          return;
        }
        if (now - lastSeenAt >= silenceMs) {
          probeSentAt = now;
          newWs.ping();
        }
      } catch {
        // A throwing timer would take down the process for one bad socket.
      }
    }, tickMs) : null;
    if (liveness && typeof liveness.unref === "function") liveness.unref();
    const stopLiveness = (): void => { if (liveness) clearInterval(liveness); };
    // `on`, not `once`: the stand-ins above implement only `on`, and
    // clearInterval is idempotent so a repeat call costs nothing.
    newWs.on("close", stopLiveness);
    newWs.on("error", stopLiveness);

    newWs.on("message", (raw) => {
      sawTraffic();
      let msg: MuxMsg;
      try {
        msg = JSON.parse(raw.toString()) as MuxMsg;
        // A good frame means the stream recovered; corruption must be
        // consecutive to count as corruption.
        parseFailures = 0;
      } catch {
        parseFailures += 1;
        opts.onParseFailure?.(parseFailures);
        if (parseFailures >= MAX_CONSECUTIVE_PARSE_FAILURES) {
          // Not a frame we lost — a stream we can no longer read. Every slot
          // on it is evicted so their runtimes restart, rather than each
          // waiting out a timeout on messages that will never parse.
          parseFailures = 0;
          for (const [slot, entry] of [...slots]) {
            if (entry.killed) continue;
            entry.killed = true;
            entry.stdout.push(null);
            entry.fake.emit("exit", 1, null);
            slots.delete(slot);
          }
          newWs.terminate();
        }
        return;
      }

      // Bridge announces its instance ID on every connect (`hello` is the
      // typed bus frame; `bridge_hello` remains accepted for the slot-mux
      // eviction path). If it changed, the bridge process restarted and all
      // its agent slots are gone — emit exit events so runtimes are evicted.
      if (msg.type === "hello" || msg.type === "bridge_hello") {
        const newId = msg.instanceId;
        const isNewInstance = !!(newId && lastBridgeInstanceId && newId !== lastBridgeInstanceId);

        if (isNewInstance) {
          for (const [slot, entry] of slots) {
            if (!entry.killed) {
              // Tell the new bridge process to kill any agent it spawned for
              // this slot (flushQueues may have already sent stdin to it).
              send({ slot, type: "kill" });
              entry.killed = true;
              entry.stdout.push(null);
              entry.fake.emit("exit", 1, null);
            }
          }
          slots.clear();
        }
        lastBridgeInstanceId = newId;

        // For same-instance reconnects (WS drop/reconnect without bridge restart),
        // probe which slots are still live. Any seam-acp slot the bridge no longer
        // knows about had its turn complete (or was lost) while the WS was down —
        // evict it immediately so the turn fails fast rather than waiting for the
        // turn timeout.
        if (!isNewInstance && slots.size > 0) {
          void sendCmd("listSlots", {}).then((reply: {
            slots: number[];
            health?: BridgeSlotHealth[];
          }) => {
            // #442: an older bridge sends no `health`, which means "no
            // opinion" — never "unhealthy". Eviction still keys on the slot
            // list exactly as before, so a mixed-version fleet behaves today's
            // way rather than a new way nobody has tested.
            const health = Array.isArray(reply.health) ? reply.health : [];
            // A slot the bridge lists but reports dead is evicted too: the
            // list says "I have an entry", `alive` says "the process is
            // gone", and the second is the stronger statement.
            const deadOnBridge = new Set<number>(
              health.filter((h) => h && h.alive === false).map((h) => h.slot)
            );
            const liveOnBridge = new Set<number>(
              reply.slots.filter((slot) => !deadOnBridge.has(slot))
            );
            if (health.length) opts.onSlotHealth?.(health);
            // #444: catch up on output produced while the socket was down.
            // Runs after eviction so a slot the bridge no longer has is not
            // asked to replay. Fire-and-forget per slot: an OLD bridge rejects
            // `replayOutput` as an unknown action, and that rejection means
            // "no replay available" — the same behaviour as today, which is
            // what keeps a mixed-version fleet safe.
            for (const [slot, entry] of [...slots]) {
              if (entry.killed || !liveOnBridge.has(slot)) continue;
              const afterSeq = outputCursor.get(slot) ?? 0;
              void sendCmd("replayOutput", { slot, afterSeq }).then((reply: {
                slot?: number;
                frames?: Array<{ seq?: number; type?: string; data?: string; code?: number }>;
                gap?: { afterSeq: number; firstAvailableSeq: number; droppedFrames: number };
              }) => {
                const live = slots.get(slot);
                if (!live || live.killed) return;
                // The gap is reported BEFORE the frames it precedes, so a
                // consumer sees the discontinuity in the right order rather
                // than discovering it after acting on what followed.
                if (reply?.gap) opts.onOutputGap?.(slot, reply.gap);
                for (const frame of reply?.frames ?? []) {
                  if (frame.type === "data" && typeof frame.data === "string") {
                    if (typeof frame.seq === "number") outputCursor.set(slot, frame.seq);
                    live.stdout.push(frame.data);
                  } else if (frame.type === "exit") {
                    live.killed = true;
                    slots.delete(slot);
                    live.stdout.push(null);
                    live.fake.emit("exit", frame.code ?? 1, null);
                  }
                }
                const through = outputCursor.get(slot);
                // Acks only accelerate the bridge's trimming; its age and byte
                // bounds are what actually reclaim memory.
                if (through) void sendCmd("ackOutput", { slot, throughSeq: through }).catch(() => {});
              }).catch(() => { /* old bridge: no replay, behave as today */ });
            }
            for (const [slot, entry] of [...slots]) {
              if (!entry.killed && !liveOnBridge.has(slot)) {
                send({ slot, type: "kill" });
                entry.killed = true;
                entry.stdout.push(null);
                entry.fake.emit("exit", 1, null);
                slots.delete(slot);
              }
            }
          }).catch(() => { /* bridge may not support listSlots — ignore */ });
        }

        if (msg.type === "hello") {
          opts.onHello?.(msg as unknown as HelloFrame);
        }
        return;
      }

      if (msg.type === "rpc_reply" && msg.id) {
        const handler = pendingRpcs.get(msg.id);
        if (handler) {
          pendingRpcs.delete(msg.id);
          const reply = msg as unknown as RpcReplyFrame;
          if (!reply.ok || reply.error) {
            handler.reject(new Error(reply.error ?? "rpc failed"));
          } else {
            handler.resolve(reply.result);
          }
        }
        return;
      }

      if (msg.type === "event") {
        opts.onEvent?.(msg as unknown as EventFrame);
        return;
      }

      if (msg.type === "pong" || msg.type === "ping") {
        if (msg.type === "ping") {
          send({ type: "pong", v: PROTOCOL_VERSION } as MuxMsg);
        }
        return;
      }

      if (msg.type === "cmd_reply" && msg.cmdId) {
        const handler = pendingCmds.get(msg.cmdId);
        if (handler) {
          pendingCmds.delete(msg.cmdId);
          if (msg.error) {
            handler.reject(new Error(msg.error));
          } else {
            handler.resolve(msg.payload);
          }
        }
        return;
      }

      if (msg.slot === undefined) return;
      const entry = slots.get(msg.slot);
      if (!entry || entry.killed) return;

      if (msg.type === "data" && msg.data !== undefined) {
        // #444: advance only on frames that carry one. An old bridge sends no
        // `seq`, which leaves the cursor at 0 and simply means "never ask for
        // replay" — today's behaviour exactly.
        if (typeof msg.seq === "number") outputCursor.set(msg.slot, msg.seq);
        entry.stdout.push(msg.data);
      } else if (msg.type === "exit") {
        entry.killed = true;
        slots.delete(msg.slot);
        entry.stdout.push(null);
        entry.fake.emit("exit", msg.code ?? 1, null);
      }
    });

    // #427: a dead socket must fail its in-flight RPCs NOW, with a reason that
    // says the peer is gone. Leaving them to expire at the generic 30s default
    // is what made a dead connection look like a slow operation.
    newWs.on("close", () => {
      stopLiveness();
      if (bridgeWs === newWs) {
        bridgeWs = null;
        settleInFlight("Remote bridge connection closed before the reply arrived.");
        opts.onDisconnect?.();
      }
    });

    newWs.on("error", () => {
      stopLiveness();
      if (bridgeWs === newWs) {
        bridgeWs = null;
        settleInFlight("Remote bridge connection failed before the reply arrived.");
        opts.onDisconnect?.();
      }
    });
  }

  function spawn(spawnOpts?: MuxSpawnOpts): MuxChild {
    const slot = nextSlot++;
    const stdinPT = new PassThrough();
    const stdoutPT = new PassThrough();
    const stderrPT = new PassThrough();
    const emitter = new EventEmitter();
    const stdinQueue: string[] = [];
    let killed = false;

    const fake = Object.assign(emitter, {
      slot,
      stdin: stdinPT as NodeWritable,
      stdout: stdoutPT as NodeReadable,
      stderr: stderrPT as NodeReadable,
      get killed() {
        return killed;
      },
      kill() {
        if (killed) return;
        killed = true;
        const entry = slots.get(slot);
        if (entry) entry.killed = true;
        slots.delete(slot);
        send({ slot, type: "kill" });
        stdinPT.destroy();
        stdoutPT.push(null);
      },
    }) as FakeProcess & { slot: number };

    slots.set(slot, {
      stdout: stdoutPT,
      fake,
      stdinQueue,
      killed: false,
      holdStdin: spawnOpts?.holdStdinUntilReady === true,
    });

    stdinPT.on("data", (chunk: Buffer) => {
      const entry = slots.get(slot);
      if (!entry || entry.killed) return;
      const text = chunk.toString("utf8");
      if (bridgeWs?.readyState === WebSocket.OPEN && !entry.holdStdin) {
        // Flush any previously buffered data first.
        for (const queued of entry.stdinQueue.splice(0)) {
          send({ slot, type: "data", data: queued });
        }
        send({ slot, type: "data", data: text });
      } else {
        entry.stdinQueue.push(text);
      }
    });

    // If bridge isn't online yet, start a connect timeout.
    if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
      const timeout = setTimeout(() => {
        const idx = bridgeWaiters.findIndex((w) => w.slot === slot);
        if (idx >= 0) bridgeWaiters.splice(idx, 1);
        if (!killed) {
          fake.emit(
            "error",
            new Error(
              `Remote agent '${opts.id}' did not connect within ${CONNECT_TIMEOUT_MS / 1000}s. ` +
                `Ensure the bridge script is running and pointed at this server.`
            )
          );
        }
      }, CONNECT_TIMEOUT_MS);
      if (typeof timeout.unref === "function") timeout.unref();
      bridgeWaiters.push({ slot, timeout });
    }

    return fake as unknown as MuxChild;
  }

  async function sendCmd(action: string, payload: any): Promise<any> {
    if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
      // Same type as a mid-flight death, so callers classify one thing.
      throw new BridgeUnreachableError(
        "Remote bridge is offline. Make sure the bridge is running.",
        // Nothing left this process, so the outcome is not in doubt.
        false
      );
    }
    const cmdId = Math.random().toString(36).substring(2, 15);
    return new Promise((resolve, reject) => {
      pendingCmds.set(cmdId, { resolve, reject });
      const timeout = setTimeout(() => {
        if (pendingCmds.has(cmdId)) {
          pendingCmds.delete(cmdId);
          reject(new Error(`Command '${action}' timed out after 15s`));
        }
      }, 15000);
      if (typeof timeout.unref === "function") timeout.unref();

      send({ type: "cmd", cmdId, action, payload });
    });
  }

  function sendFrame(msg: Record<string, unknown>): void {
    send(msg as unknown as MuxMsg);
  }

  async function rpc(
    method: string,
    params: unknown,
    optsRpc: { agentId?: string; timeoutMs?: number } = {}
  ): Promise<unknown> {
    if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
      // Same type as a mid-flight death, so callers classify one thing.
      // Nothing left this process, so the outcome is not in doubt.
      throw new BridgeUnreachableError(
        "Remote bridge is offline. Make sure the bridge is running.",
        false
      );
    }
    const id = Math.random().toString(36).substring(2, 15);
    const timeoutMs = optsRpc.timeoutMs ?? 30_000;
    return new Promise((resolve, reject) => {
      pendingRpcs.set(id, { resolve, reject });
      const timeout = setTimeout(() => {
        if (pendingRpcs.has(id)) {
          pendingRpcs.delete(id);
          reject(new Error(`rpc '${method}' timed out after ${timeoutMs / 1000}s`));
        }
      }, timeoutMs);
      if (typeof timeout.unref === "function") timeout.unref();
      send({
        v: PROTOCOL_VERSION,
        type: "rpc",
        id,
        method,
        params,
        ...(optsRpc.agentId ? { agentId: optsRpc.agentId } : {}),
      } as MuxMsg);
    });
  }

  function helloAck(accepted: boolean, error?: string): void {
    send({
      v: PROTOCOL_VERSION,
      type: "hello_ack",
      protocolVersion: PROTOCOL_VERSION,
      accepted,
      ...(error ? { error } : {}),
    } as MuxMsg);
  }

  function connected(): boolean {
    return !!bridgeWs && bridgeWs.readyState === WebSocket.OPEN;
  }

  return { attach, spawn, sendCmd, rpc, sendFrame, helloAck, connected, releaseStdin };
}
