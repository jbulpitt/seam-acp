/**
 * A short-retention output log with per-consumer cursors (#444).
 *
 * `muxSend` returned early when the socket was not OPEN — no buffer, no replay
 * — while stdin *toward* the agent was queued and replayed through
 * `stdinQueue`/`flushQueues`. So the agent kept working through a blip and
 * every frame it produced was thrown away. That asymmetry is the bug.
 *
 * ## Why a log and not pub/sub
 *
 * A push to a disconnected subscriber is lost, which is exactly the current
 * failure, and pub/sub *with* persistence is a buffer with extra machinery.
 * With one primary consumer there is no fan-out to justify it. Here the
 * consumer holds a cursor, disconnection needs no special case at all — the
 * cursor simply stops advancing — and catch-up is "read from where you were".
 *
 * ## Retention is deliberately short
 *
 * The complete record already exists on disk for every agent family (Claude
 * 1.2 GB, Codex 13 GB across 557 sessions, Grok 2.9 GB). This buffers minutes,
 * not history. Past the window the log says so with an explicit gap rather
 * than quietly returning a later range: a silent discontinuity splices two
 * unrelated points of a JSON-RPC stream together and is blast radius 5, while
 * a visible gap the caller can act on is 2.
 *
 * ## Trimming may never depend on an acknowledgment
 *
 * Four of eight hosts cannot be updated through the rollout tooling, so a new
 * bridge will talk to an old seam-acp that never acks. If acks were the only
 * way memory came back, that pairing would grow without bound on hosts we
 * cannot fix. Acks only ever *accelerate* trimming; the age and byte bounds
 * are what actually guarantee it.
 */

/** One buffered outbound frame, with the sequence its consumer cursors on. */
export interface OutputLogFrame {
  seq: number;
  /** Epoch ms when the bridge observed it — the age bound reads this. */
  at: number;
  /** Frame payload as it would be sent, minus `slot`/`seq`. */
  type: string;
  payload: Record<string, unknown>;
  /** Byte cost charged against the retention budget. */
  bytes: number;
}

export interface OutputLogReplay {
  frames: OutputLogFrame[];
  /**
   * Set when the requested cursor is older than anything retained. Never
   * omitted in favour of silently returning what is left — the caller has to
   * be able to tell "here is the rest" from "some of it is gone".
   */
  gap?: { afterSeq: number; firstAvailableSeq: number; droppedFrames: number };
}

export interface OutputLogOptions {
  /** Total retained bytes across all slots. */
  maxBytes?: number;
  /** Frames older than this are dropped regardless of acknowledgment. */
  maxAgeMs?: number;
  /** Per-slot cap, so one noisy agent cannot evict every other slot. */
  maxFramesPerSlot?: number;
}

/**
 * Defaults sized for "minutes, then fall back to the transcript". 8 MiB across
 * all slots and 5 minutes; a slot is additionally capped at 4,000 frames so a
 * single chatty agent cannot consume the whole budget and silently evict the
 * others' replay windows.
 */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_MAX_FRAMES_PER_SLOT = 4_000;

interface SlotLog {
  frames: OutputLogFrame[];
  /** Highest seq ever dropped, so a gap can be reported precisely. */
  droppedThrough: number;
  droppedCount: number;
}

export interface OutputLog {
  append(slot: number, type: string, payload: Record<string, unknown>, now?: number): number;
  since(slot: number, afterSeq: number, now?: number): OutputLogReplay;
  ack(slot: number, throughSeq: number): void;
  dropSlot(slot: number): void;
  /** Diagnostics only. */
  stats(): { slots: number; frames: number; bytes: number };
}

export function createOutputLog(options: OutputLogOptions = {}): OutputLog {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxFramesPerSlot = options.maxFramesPerSlot ?? DEFAULT_MAX_FRAMES_PER_SLOT;

  const logs = new Map<number, SlotLog>();
  // Sequences are per slot: a consumer cursors on one slot's stream, and a
  // global counter would make a cursor jump whenever an unrelated slot spoke.
  const nextSeq = new Map<number, number>();
  let totalBytes = 0;

  function slotLog(slot: number): SlotLog {
    let log = logs.get(slot);
    if (!log) {
      log = { frames: [], droppedThrough: 0, droppedCount: 0 };
      logs.set(slot, log);
    }
    return log;
  }

  function dropFront(log: SlotLog): void {
    const frame = log.frames.shift();
    if (!frame) return;
    totalBytes -= frame.bytes;
    log.droppedThrough = Math.max(log.droppedThrough, frame.seq);
    log.droppedCount += 1;
  }

  function enforceBounds(now: number): void {
    // Age first: stale frames are worthless to a consumer that is minutes
    // behind, and dropping them may make the byte bound moot.
    for (const log of logs.values()) {
      while (log.frames.length && now - log.frames[0]!.at > maxAgeMs) dropFront(log);
      while (log.frames.length > maxFramesPerSlot) dropFront(log);
    }
    // Then bytes, oldest-first across slots, so pressure is shared rather than
    // falling entirely on whichever slot happens to be examined first.
    while (totalBytes > maxBytes) {
      let oldest: SlotLog | undefined;
      for (const log of logs.values()) {
        if (!log.frames.length) continue;
        if (!oldest || log.frames[0]!.at < oldest.frames[0]!.at) oldest = log;
      }
      if (!oldest) break;
      dropFront(oldest);
    }
  }

  return {
    append(slot, type, payload, now = Date.now()) {
      const seq = (nextSeq.get(slot) ?? 0) + 1;
      nextSeq.set(slot, seq);
      const log = slotLog(slot);
      const bytes = JSON.stringify(payload).length;
      log.frames.push({ seq, at: now, type, payload, bytes });
      totalBytes += bytes;
      enforceBounds(now);
      return seq;
    },

    since(slot, afterSeq, now = Date.now()) {
      enforceBounds(now);
      const log = logs.get(slot);
      if (!log) return { frames: [] };
      const frames = log.frames.filter((f) => f.seq > afterSeq);
      // A gap exists only when frames the caller has NOT seen were dropped.
      // A cursor at or beyond `droppedThrough` has already consumed them.
      if (log.droppedThrough > afterSeq) {
        return {
          frames,
          gap: {
            afterSeq,
            firstAvailableSeq: frames[0]?.seq ?? (nextSeq.get(slot) ?? 0) + 1,
            droppedFrames: log.droppedCount,
          },
        };
      }
      return { frames };
    },

    ack(slot, throughSeq) {
      const log = logs.get(slot);
      if (!log) return;
      // Acks accelerate trimming; they are never the only thing that trims.
      // An old seam-acp that never acks must still be bounded.
      while (log.frames.length && log.frames[0]!.seq <= throughSeq) {
        const frame = log.frames.shift()!;
        totalBytes -= frame.bytes;
        // These frames really are gone, so record it. Mutation testing caught
        // the earlier version, which deliberately did NOT — on the theory that
        // an acked frame can never be missed. That is only true for the
        // consumer that acked: a cursor RESET back before `throughSeq` would
        // have been handed the later frames with no indication that anything
        // preceded them, which is the silent discontinuity this whole design
        // exists to prevent.
        //
        // It costs nothing in the normal case, because that consumer's cursor
        // is at or beyond `throughSeq` and `since()` compares against it.
        log.droppedThrough = Math.max(log.droppedThrough, frame.seq);
      }
    },

    dropSlot(slot) {
      const log = logs.get(slot);
      if (log) for (const frame of log.frames) totalBytes -= frame.bytes;
      logs.delete(slot);
      nextSeq.delete(slot);
    },

    stats() {
      let frames = 0;
      for (const log of logs.values()) frames += log.frames.length;
      return { slots: logs.size, frames, bytes: totalBytes };
    },
  };
}

/**
 * Split a raw stdout chunk into complete lines, keeping any partial tail (#444).
 *
 * stdout was forwarded as raw `Buffer` chunks, so a reconnect could splice a
 * partial JSON line into a line-delimited JSON-RPC stream and the consumer
 * would parse garbage. Framing by line before forwarding means a frame is
 * always a whole message.
 *
 * `maxLineBytes` bounds the held tail: a chunk stream with no newline at all
 * would otherwise grow the residual without limit. On overflow the tail is
 * surrendered as-is rather than dropped, because truncating a JSON-RPC line
 * silently is the very discontinuity this exists to prevent — the consumer's
 * parse-failure counter then sees it.
 */
export function createLineFramer(maxLineBytes = 8 * 1024 * 1024) {
  let residual = "";
  return {
    /** Complete lines (newline included) from this chunk. */
    push(chunk: string): string[] {
      residual += chunk;
      if (residual.length > maxLineBytes) {
        const overflow = residual;
        residual = "";
        return [overflow];
      }
      const lines: string[] = [];
      let index = residual.indexOf("\n");
      while (index !== -1) {
        lines.push(residual.slice(0, index + 1));
        residual = residual.slice(index + 1);
        index = residual.indexOf("\n");
      }
      return lines;
    },
    /** Whatever is held back, for flushing when the process exits. */
    flush(): string | null {
      if (!residual) return null;
      const tail = residual;
      residual = "";
      return tail;
    },
    pending(): number {
      return residual.length;
    },
  };
}
