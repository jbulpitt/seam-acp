/**
 * A bounded stderr ring for bridge-spawned agents (#456).
 *
 * ## The defect
 *
 * Agent children are spawned `["pipe","pipe","pipe"]` and the bridge attaches
 * a handler only to `stdout`. A Node readable with no consumer stays paused,
 * so the kernel pipe buffer fills — 64 KiB on Linux — and the child blocks on
 * its next write to fd 2. It then presents as a turn that stops producing
 * output with the process still alive, which is indistinguishable at the
 * seam-acp layer from a transport stall or a hung agent. That is the exact
 * signature #443 exists to detect, so detection built on top of an undrained
 * pipe would be measuring a symptom this file causes.
 *
 * Draining is what prevents the stall. The ring is what makes the bytes worth
 * something: the local path (`agent-runtime.ts`) can say *why* an agent died
 * via `stderrTail`, and the bridge path could not, because it never captured a
 * byte.
 *
 * ## Why the bridge and not each adapter
 *
 * Adapters are shared between the local and bridge paths, and on the local
 * path `agent-runtime.ts` already attaches its own `data` handler. A drain
 * inside `profile.spawn()` would put two consumers and two rings on one
 * stream, which is the same fact derived in two places — the pattern this
 * epic exists to remove, not a way to fix it.
 *
 * The existing precedent also points here rather than there. The local drain
 * lives in the *runtime* layer, not in the profiles, and the bridge's slot
 * manager is that layer on the bridge path: it already owns stdout routing,
 * the exit frame, and (since #444) the output log. stderr is the same class of
 * fact as stdout, and splitting them across two layers is what produces the
 * asymmetries this epic keeps finding. Draining here also fixes every adapter
 * at once, including any added later, which a per-adapter drain cannot promise.
 *
 * ## Bounded by bytes AND lines
 *
 * A single 10 MB stderr line is one line, so a line cap alone bounds nothing.
 * The local ring keeps 100 entries with no byte bound at all — and it pushes
 * whole chunks rather than lines, so its "~100 lines" is really ~100 chunks.
 * Both bounds are enforced here.
 */

/** Total retained bytes. Small: this rides on an exit frame. */
const DEFAULT_MAX_BYTES = 8 * 1024;
/** Line cap, mirroring the local path's retention depth. */
const DEFAULT_MAX_LINES = 100;

export interface StderrRingOptions {
  maxBytes?: number;
  maxLines?: number;
}

export interface StderrRing {
  /** Feed a raw chunk from fd 2. Calling this at all is what unblocks the child. */
  push(chunk: string | Buffer): void;
  /**
   * The retained tail, oldest first. Prefixed with an explicit marker when
   * anything was dropped — a truncated diagnostic that does not say it is
   * truncated invites a wrong conclusion from a partial stack trace.
   */
  tail(): string;
  stats(): { bytes: number; lines: number; droppedBytes: number };
}

export function createStderrRing(options: StderrRingOptions = {}): StderrRing {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;

  /** Complete lines, without their trailing newline. */
  const lines: string[] = [];
  /** Bytes held in `lines`, counting one newline per line. */
  let lineBytes = 0;
  /** A line the agent has not finished writing yet. */
  let partial = "";
  let droppedBytes = 0;

  function dropOldest(): void {
    const gone = lines.shift();
    if (gone === undefined) return;
    lineBytes -= gone.length + 1;
    droppedBytes += gone.length + 1;
  }

  /** Keep the END of an oversized line: the last thing written before a death
   *  is the part that says what killed it. */
  function truncateHead(text: string, limit: number): string {
    if (text.length <= limit) return text;
    droppedBytes += text.length - limit;
    return text.slice(text.length - limit);
  }

  function enforce(): void {
    while (lines.length > maxLines) dropOldest();
    // A single line can exceed the whole budget on its own, so dropping whole
    // lines is not sufficient — bound the survivor too.
    while (lines.length > 1 && lineBytes + partial.length > maxBytes) dropOldest();
    if (lines.length === 1 && lines[0]!.length + 1 > maxBytes) {
      const kept = truncateHead(lines[0]!, Math.max(0, maxBytes - 1));
      lineBytes = kept.length + 1;
      lines[0] = kept;
    }
    if (partial.length > maxBytes) partial = truncateHead(partial, maxBytes);
    // With the partial bounded and at most one line retained, this only bites
    // when both are near the cap.
    while (lines.length > 0 && lineBytes + partial.length > maxBytes) dropOldest();
  }

  return {
    push(chunk) {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (!text) return;
      partial += text;
      let index = partial.indexOf("\n");
      while (index !== -1) {
        const line = partial.slice(0, index);
        partial = partial.slice(index + 1);
        lines.push(line);
        lineBytes += line.length + 1;
        index = partial.indexOf("\n");
      }
      enforce();
    },

    tail() {
      const body = [...lines, ...(partial ? [partial] : [])].join("\n");
      // Nothing written and nothing dropped: genuinely no diagnostic, and the
      // caller omits the field rather than sending an empty claim.
      if (!body && droppedBytes === 0) return "";
      // Stated, never implied — the same rule #444's gap marker follows. This
      // holds even when the body is empty: "we dropped 40 KB and kept none of
      // it" is a fact worth having, and reporting nothing would be the silent
      // discontinuity the marker exists to prevent.
      return droppedBytes > 0
        ? `[stderr truncated: ${droppedBytes} earlier bytes dropped]${body ? `\n${body}` : ""}`
        : body;
    },

    stats() {
      return {
        bytes: lineBytes + partial.length,
        lines: lines.length + (partial ? 1 : 0),
        droppedBytes,
      };
    },
  };
}

/**
 * Attach the drain. Separate from the ring so the wiring itself is testable:
 * `index.ts` is the CLI entrypoint and `process.exit(1)`s on import, so
 * anything left inline there has no coverage — the lesson #442 and #444 both
 * paid for.
 *
 * `stderr` is null when the child inherited fd 2. There is nothing to drain
 * then. Every bridge agent, including copilot, is spawned with a pipe, and
 * this handler is what keeps that pipe from filling.
 */
export function attachStderrDrain(
  child: { stderr?: NodeJS.ReadableStream | null },
  ring: StderrRing,
): boolean {
  if (!child.stderr) return false;
  child.stderr.on("data", (chunk: Buffer | string) => ring.push(chunk));
  return true;
}

/**
 * Build the `exit` frame payload, including the stderr tail when — and only
 * when — the exit was abnormal.
 *
 * `abnormal` matches `agent-runtime.ts` exactly, deliberately: two definitions
 * of "died badly" that disagree would make the local and bridge paths report
 * different causes for the same death.
 *
 * Mixed-version: `stderrTail` is additive. An old seam-acp reads `code` off
 * this frame and ignores the rest. A new consumer must read an ABSENT
 * `stderrTail` as "not reported" — an old bridge never sends one — and never
 * as "the agent died silently"; that is the same `null`-versus-`0` distinction
 * #442 drew for the health fields.
 */
export function exitFramePayload(
  code: number | null,
  signal: NodeJS.Signals | string | null,
  ring?: StderrRing,
): Record<string, unknown> {
  const abnormal = (code !== 0 && code !== null) || signal != null;
  const tail = abnormal ? ring?.tail() : undefined;
  return {
    code: code ?? 1,
    // #516: the controller used to replace every remote signal with null.
    // Keep clean/code-only frames byte-identical for old peers, but preserve a
    // signal when the child-owning host actually observed one.
    ...(signal ? { signal } : {}),
    ...(tail ? { stderrTail: tail } : {}),
  };
}

/**
 * Per-slot ownership of the above, so the lifecycle is covered by tests.
 *
 * Mutation testing killed 14/14 mutations of the ring while every mutation of
 * the equivalent logic left inline in `index.ts` survived — including deleting
 * the drain outright, which is this entire story silently undone. That file is
 * the CLI entrypoint and `process.exit(1)`s on import, so nothing in it can be
 * imported by a test. #442 and #444 each hit this, so the decisions live here
 * and `index.ts` keeps only the call.
 */
export interface StderrRegistry {
  /** Create a slot's ring and start draining. Safe on a null stderr. */
  attach(slot: number, child: { stderr?: NodeJS.ReadableStream | null }): void;
  /** Build the slot's exit payload and release its ring. */
  exitPayload(
    slot: number,
    code: number | null,
    signal: NodeJS.Signals | string | null,
  ): Record<string, unknown>;
  /** Forget a slot without reporting — used when seam-acp asked for the kill. */
  drop(slot: number): void;
  size(): number;
}

export function createStderrRegistry(options: StderrRingOptions = {}): StderrRegistry {
  const rings = new Map<number, StderrRing>();
  return {
    attach(slot, child) {
      const ring = createStderrRing(options);
      rings.set(slot, ring);
      attachStderrDrain(child, ring);
    },
    exitPayload(slot, code, signal) {
      const payload = exitFramePayload(code, signal, rings.get(slot));
      rings.delete(slot);
      return payload;
    },
    drop(slot) {
      rings.delete(slot);
    },
    size() {
      return rings.size;
    },
  };
}
