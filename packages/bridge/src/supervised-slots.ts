import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { RemoteRecoveryResult, RemoteRecoverySnapshot } from "@seam/adapters";
import {
  ADAPTER_CHILD_PROTOCOL_VERSION,
  adapterChildLine,
  parseAdapterChildOutput,
  type AdapterChildInput,
} from "./adapter-child-protocol.js";
import type { SlotSpawnConfig } from "./rpc.js";
import { SessiondClient } from "./sessiond-client.js";
import type {
  SessiondEvent,
  SessiondListSlotsResult,
  SessiondOutputFrame,
} from "./sessiond-protocol.js";

export interface SupervisedBridgeFrame {
  seq: number;
  type: "data" | "recovery" | "recovery_result" | "exit";
  data?: string;
  recovery?: RemoteRecoverySnapshot;
  recoveryResult?: RemoteRecoveryResult;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  spawnError?: string;
}

interface SlotBinding {
  mode: "idle" | "live" | "buffering";
  buffered: Map<number, SupervisedBridgeFrame>;
  gap?: { afterSeq: number; firstAvailableSeq: number; droppedFrames: number };
  exitSeen?: boolean;
  /**
   * #606: the child behind this binding has exited (or its descriptors died
   * with a previous sessiond). The binding stays so its retained output —
   * including the exit frame that settles the turn it was serving — can still
   * be replayed. It must never be reused for NEW input: `ensure()` respawns.
   *
   * Separate from `exitSeen`, which `replay()` resets to de-duplicate exit
   * frames per consumer cursor. That reset is right for replay and would be
   * wrong here: a replayed death is still a death.
   */
  dead?: boolean;
}

export interface SupervisedSlotsOptions {
  client: SessiondClient;
  copilotCmd: string;
  localCwd: string;
  environment?: NodeJS.ProcessEnv;
  adapterChildPath?: string;
  onFrame(frame: SupervisedBridgeFrame & { slot: number }): void;
  onStderr(slot: number, chunk: Buffer): void;
  onSpawn?(slot: number, pid: number): void;
}

function exactEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function outputFrame(frame: SessiondOutputFrame, parsedOutput?: ReturnType<typeof parseAdapterChildOutput>): SupervisedBridgeFrame | undefined {
  if (frame.stream === "exit") {
    return {
      seq: frame.seq,
      type: "exit",
      code: frame.code ?? null,
      signal: frame.signal ?? null,
    };
  }
  if (frame.stream !== "stdout" || typeof frame.dataBase64 !== "string") return undefined;
  const parsed = parsedOutput ?? parseAdapterChildOutput(Buffer.from(frame.dataBase64, "base64").toString("utf8"));
  if (!parsed) return undefined;
  if (parsed.type === "data") return { seq: frame.seq, type: "data", data: parsed.data };
  if (parsed.type === "recovery") return { seq: frame.seq, type: "recovery", recovery: parsed.recovery };
  if (parsed.type === "recovery_result") {
    return { seq: frame.seq, type: "recovery_result", recoveryResult: parsed.recoveryResult };
  }
  if (parsed.type === "control_result") return undefined;
  const spawnError = parsed.type === "refusal" ? parsed.reason : parsed.spawnError;
  return { seq: frame.seq, type: "exit", code: 1, signal: null, spawnError };
}

/**
 * Restartable bridge-side view of sessiond slots (#574).
 *
 * A retained slot accepts input exactly like a freshly spawned one. #584 made
 * retained bindings output-only to avoid an "unknown resend" into a child whose
 * submission state the new control plane could not prove. That protection does
 * not apply here and cost more than it saved:
 *
 * - `recovery-directive.ts` already decides this. Duplicate submission is a
 *   refusal predicate for EPHEMERAL outward-effect work only; persistent
 *   conversations keep their transcript, so a repeat is absorbed, not doubled.
 * - Rung-1 recovery resubmits into a live session on purpose
 *   (`disposition: "continue_same_session"`, `retry.mode: "continue" | "resend"`).
 *   Refusing the same write here contradicted the layer above it.
 * - Resuming a conversation is "continue". That is the normal path, not a hazard.
 *
 * What it actually did was turn "this slot is uncertain" into "this thread can
 * never accept input again", surfaced as a failed turn that discarded the
 * operator's prompt. Uncertainty is not an operating mode.
 */
/**
 * #606: deliver controller input to a slot and REPORT when it cannot land.
 *
 * `writeInput` resolves false for an undeliverable write and rejects when a
 * spawn fails. The bridge used to handle only the rejection, so a resolved
 * false vanished: no exit frame reached the controller, which then waited out
 * its 45s ACP-initialize timeout and blamed installation and authentication.
 * Both outcomes now produce the same immediate, named failure. Exported so the
 * contract is testable; `index.ts` exits on import and cannot be.
 */
export async function forwardInput(
  slots: Pick<SupervisedSlots, "writeInput">,
  slot: number,
  data: string,
  onUndeliverable: (slot: number) => void,
): Promise<void> {
  let delivered = false;
  try {
    delivered = await slots.writeInput(slot, data);
  } catch {
    delivered = false;
  }
  if (!delivered) onUndeliverable(slot);
}

export class SupervisedSlots {
  private readonly bindings = new Map<number, SlotBinding>();
  private readonly configs = new Map<number, SlotSpawnConfig>();
  private readonly queues = new Map<number, Promise<unknown>>();
  private readonly recoveries = new Map<number, RemoteRecoverySnapshot>();
  private readonly controlWaiters = new Map<string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  private readonly adapterChildPath: string;

  constructor(private readonly options: SupervisedSlotsOptions) {
    this.adapterChildPath = options.adapterChildPath
      ?? fileURLToPath(new URL("./adapter-child.js", import.meta.url));
  }

  async rebind(): Promise<SessiondListSlotsResult> {
    const listed = await this.options.client.listSlots();
    for (const health of listed.health) {
      // #606: sessiond keeps entries for exited children, and slot numbers
      // restart near zero on every bridge connection. Binding a dead entry as
      // though it were live meant the first turns after a bridge-only restart
      // collided with it, `ensure()` returned it without spawning, and the
      // write went to a process that no longer existed. Keep it replayable;
      // refuse it for input.
      this.bindings.set(health.slot, {
        mode: "idle",
        buffered: new Map(),
        ...(!health.alive || !health.attached ? { dead: true } : {}),
      });
      // Idle subscription: rebuilds stderr and recovery records from the
      // retained log and keeps them current, without forwarding anything.
      await this.options.client.subscribe({ slot: health.slot, afterSeq: 0 }, (event) => this.onEvent(health.slot, event));
    }
    // Read output expires from the log after a few minutes, so a long turn's
    // recovery record may no longer be there. Ask each live child for it.
    const live = listed.health.filter((health) => health.alive && health.attached);
    await Promise.all(live.map((health) => this.writeControl(health.slot, {
      v: ADAPTER_CHILD_PROTOCOL_VERSION,
      type: "report_recovery",
    }).catch(() => {})));
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && live.some((health) => !this.recoveries.has(health.slot))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return listed;
  }

  configure(slot: number, config: SlotSpawnConfig): void {
    // #606: the controller configures a slot with `rpc("spawn")` before the
    // first ACP frame of a NEW runtime (mux.ts). If the binding under that slot
    // number is dead, this is the declaration that a new child belongs there:
    // drop the dead binding so the next input spawns. sessiond replaces the
    // dead entry on spawn (`spawnSlot`), and the old recovery snapshot described
    // the dead child's submission, not this one's.
    if (this.bindings.get(slot)?.dead) {
      this.bindings.delete(slot);
      this.recoveries.delete(slot);
    }
    this.configs.set(slot, config);
  }

  async listSlots(): Promise<SessiondListSlotsResult> {
    const listed = await this.options.client.listSlots();
    return {
      ...listed,
      health: listed.health.map((entry) => ({
        ...entry,
        ...(this.recoveries.has(entry.slot)
          ? { recovery: this.recoveries.get(entry.slot) }
          : {}),
      })) as SessiondListSlotsResult["health"],
    };
  }

  /** False means UNDELIVERABLE — the child is gone — never "I declined to try".
   * Liveness is the only thing that can refuse a write. Where the slot came from
   * is not a reason: a retained child is as writable as one spawned a moment ago. */
  async writeInput(slot: number, data: string): Promise<boolean> {
    return this.serial(slot, async () => {
      // #606: input for a dead child WITHOUT a fresh configure is a continuation
      // of a session whose process is gone. Spawning a blank child and feeding
      // it mid-session ACP frames would hide that death (#574's "instead of
      // resurrecting the dead slot"). Report it undeliverable; the binding stays
      // so the dead child's exit frame can still be replayed to settle its turn.
      if (this.bindings.get(slot)?.dead) return false;
      await this.ensure(slot);
      try {
        await this.writeControl(slot, {
          v: ADAPTER_CHILD_PROTOCOL_VERSION,
          type: "input",
          dataBase64: Buffer.from(data).toString("base64"),
        });
      } catch {
        // The child died between ensure() and this write. Mark it so the next
        // input respawns rather than writing into the same corpse forever, and
        // return false. The caller MUST report false as undeliverable: #599
        // introduced this return and nothing read it, so a dead slot became a
        // silent 45-second ACP-initialize timeout instead of an immediate error
        // (#606). See `forwardInput`.
        const binding = this.bindings.get(slot);
        if (binding) binding.dead = true;
        return false;
      }
      return true;
    }) as Promise<boolean>;
  }

  async armRecovery(slot: number, input: {
    submissionId: unknown;
    acpSessionId: unknown;
    continuation: unknown;
  }): Promise<RemoteRecoverySnapshot> {
    return this.serial(slot, async () => {
      await this.ensure(slot);
      const requestId = randomUUID();
      const response = this.waitForControl(requestId);
      try {
        await this.writeControl(slot, {
          v: ADAPTER_CHILD_PROTOCOL_VERSION,
          type: "arm_recovery",
          requestId,
          ...input,
        });
      } catch (error) {
        this.cancelControl(requestId);
        throw error;
      }
      return await response as RemoteRecoverySnapshot;
    }) as Promise<RemoteRecoverySnapshot>;
  }

  async disarmRecovery(slot: number, submissionId: unknown): Promise<{ disarmed: boolean }> {
    return this.serial(slot, async () => {
      if (!this.bindings.get(slot)) return { disarmed: false };
      const requestId = randomUUID();
      const response = this.waitForControl(requestId);
      try {
        await this.writeControl(slot, {
          v: ADAPTER_CHILD_PROTOCOL_VERSION,
          type: "disarm_recovery",
          requestId,
          submissionId,
        });
      } catch (error) {
        this.cancelControl(requestId);
        throw error;
      }
      return await response as { disarmed: boolean };
    }) as Promise<{ disarmed: boolean }>;
  }

  /** The controller has read this slot's output through `throughSeq`. */
  async ack(slot: number, throughSeq: number): Promise<void> {
    // A sessiond from before #631 has no ack method; its time bound still applies.
    await this.options.client.ack({ slot, throughSeq }).catch(() => {});
  }

  async kill(slot: number): Promise<void> {
    await this.serial(slot, async () => {
      try {
        await this.options.client.kill({ slot });
      } finally {
        this.bindings.delete(slot);
        this.configs.delete(slot);
        this.recoveries.delete(slot);
      }
    });
  }

  /**
   * Atomically switches the supervisor subscription to the consumer cursor.
   * `activate` is called only after the cmd reply is written to the websocket,
   * so live frames cannot overtake their retained predecessors.
   */
  async replay(slot: number, afterSeq: number): Promise<{
    result: {
      slot: number;
      frames: SupervisedBridgeFrame[];
      gap?: { afterSeq: number; firstAvailableSeq: number; droppedFrames: number };
    };
    activate(): void;
  }> {
    const binding = this.bindings.get(slot);
    if (!binding) throw new Error("replayOutput: slot does not exist");
    binding.mode = "buffering";
    // A prior live delivery may have happened while the websocket was absent.
    // Replay is a new consumer cursor, so the retained terminal frame must be
    // eligible again; duplicate exits within this one replay remain collapsed.
    binding.exitSeen = false;
    binding.buffered.clear();
    binding.gap = undefined;
    await this.options.client.subscribe({ slot, afterSeq }, (event) => this.onEvent(slot, event));
    const frames = [...binding.buffered.values()]
      .filter((frame) => frame.seq > afterSeq)
      .sort((left, right) => left.seq - right.seq);
    const through = frames.at(-1)?.seq ?? afterSeq;
    const result = {
      slot,
      frames,
      ...(binding.gap ? { gap: binding.gap } : {}),
    };
    return {
      result,
      activate: () => {
        const pending = [...binding.buffered.values()]
          .filter((frame) => frame.seq > through)
          .sort((left, right) => left.seq - right.seq);
        binding.buffered.clear();
        binding.mode = "live";
        for (const frame of pending) this.options.onFrame({ slot, ...frame });
      },
    };
  }

  private async ensure(slot: number): Promise<SlotBinding> {
    const existing = this.bindings.get(slot);
    if (existing) return existing;
    const config = this.configs.get(slot);
    if (!config) throw new Error("slot has no spawn configuration");
    const bootstrap = adapterChildLine({
      v: ADAPTER_CHILD_PROTOCOL_VERSION,
      type: "bootstrap",
      copilotCmd: this.options.copilotCmd,
      localCwd: this.options.localCwd,
      slot,
      config,
    });
    const environment = {
      ...exactEnvironment(this.options.environment ?? process.env),
      ...(config.env ?? {}),
    };
    const spawned = await this.options.client.spawn({
      slot,
      executable: process.execPath,
      args: [this.adapterChildPath],
      cwd: config.cwd ?? this.options.localCwd,
      env: environment,
      initialStdinBase64: Buffer.from(bootstrap).toString("base64"),
    });
    this.options.onSpawn?.(slot, spawned.pid);
    const binding: SlotBinding = { mode: "live", buffered: new Map() };
    this.bindings.set(slot, binding);
    await this.options.client.subscribe({ slot, afterSeq: 0 }, (event) => this.onEvent(slot, event));
    return binding;
  }

  private async writeControl(slot: number, message: AdapterChildInput): Promise<void> {
    await this.options.client.write(slot, adapterChildLine(message));
  }

  private onEvent(slot: number, event: SessiondEvent): void {
    const binding = this.bindings.get(slot);
    if (!binding) return;
    if (event.type === "output_gap") {
      binding.gap = event.gap;
      return;
    }
    if (event.frame.stream === "stderr" && event.frame.dataBase64) {
      this.options.onStderr(slot, Buffer.from(event.frame.dataBase64, "base64"));
      return;
    }
    const parsed = event.frame.stream === "stdout" && event.frame.dataBase64
      ? parseAdapterChildOutput(Buffer.from(event.frame.dataBase64, "base64").toString("utf8"))
      : undefined;
    if (parsed?.type === "control_result") {
      const waiter = this.controlWaiters.get(parsed.requestId);
      if (waiter) {
        this.controlWaiters.delete(parsed.requestId);
        clearTimeout(waiter.timer);
        if (parsed.ok) waiter.resolve(parsed.result);
        else waiter.reject(new Error(parsed.error ?? "adapter child command failed"));
      }
      return;
    }
    const frame = outputFrame(event.frame, parsed);
    if (!frame) return;
    if (frame.type === "exit") {
      // #606: without this, a child that exited normally left a binding that
      // `ensure()` would hand back for the next input on the same slot.
      binding.dead = true;
      if (binding.exitSeen) return;
      binding.exitSeen = true;
    }
    if (frame.type === "recovery" && frame.recovery) this.recoveries.set(slot, frame.recovery);
    if (binding.mode === "buffering") binding.buffered.set(frame.seq, frame);
    else if (binding.mode === "live") this.options.onFrame({ slot, ...frame });
  }

  private waitForControl(requestId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controlWaiters.delete(requestId);
        reject(new Error("adapter child command timed out"));
      }, 10_000);
      timer.unref();
      this.controlWaiters.set(requestId, { resolve, reject, timer });
    });
  }

  private cancelControl(requestId: string): void {
    const waiter = this.controlWaiters.get(requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.controlWaiters.delete(requestId);
  }

  private serial<T>(slot: number, task: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(slot) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(task);
    const tracked = next.finally(() => {
      if (this.queues.get(slot) === tracked) this.queues.delete(slot);
    });
    this.queues.set(slot, tracked);
    return next;
  }
}
