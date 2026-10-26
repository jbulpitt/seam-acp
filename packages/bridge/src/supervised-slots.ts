import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { threadEnvironment, type BridgeSessionSnapshot, type RemoteRecoveryResult, type RemoteRecoverySnapshot } from "@seam/adapters";
import {
  ADAPTER_CHILD_PROTOCOL_VERSION,
  adapterChildLine,
  parseAdapterChildOutput,
  type AdapterChildInput,
} from "./adapter-child-protocol.js";
import type { SlotSpawnConfig } from "./rpc.js";
import type { PendingRequestIdentity, PendingResponse, PermissionSnapshot } from "./pending-permissions.js";
import { SessiondClient, SessiondClientError } from "./sessiond-client.js";
import type {
  SessiondEvent,
  SessiondListSlotsParams,
  SessiondListSlotsResult,
  SessiondOutputFrame,
} from "./sessiond-protocol.js";

export interface SupervisedBridgeFrame {
  seq: number;
  type: "data" | "stderr" | "recovery" | "recovery_result" | "session" | "exit";
  data?: string;
  recovery?: RemoteRecoverySnapshot;
  recoveryResult?: RemoteRecoveryResult;
  session?: BridgeSessionSnapshot;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  spawnError?: string;
}

interface SlotBinding {
  mode: "idle" | "live" | "buffering";
  buffered: Map<number, SupervisedBridgeFrame>;
  gap?: { afterSeq: number; firstAvailableSeq: number; droppedFrames: number };
  exitSeen?: boolean;
  /** Dead bindings retain output; only a fresh configure permits a replacement child.
   * Unlike exitSeen, this survives replay cursor resets. */
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
  if (frame.stream === "stderr" && typeof frame.dataBase64 === "string") {
    return { seq: frame.seq, type: "stderr", data: Buffer.from(frame.dataBase64, "base64").toString("utf8") };
  }
  if (frame.stream !== "stdout" || typeof frame.dataBase64 !== "string") return undefined;
  const parsed = parsedOutput ?? parseAdapterChildOutput(Buffer.from(frame.dataBase64, "base64").toString("utf8"));
  if (!parsed) return undefined;
  if (parsed.type === "data") return { seq: frame.seq, type: "data", data: parsed.data };
  if (parsed.type === "session") return { seq: frame.seq, type: "session", session: parsed.session };
  if (parsed.type === "recovery") return { seq: frame.seq, type: "recovery", recovery: parsed.recovery };
  if (parsed.type === "recovery_result") {
    return { seq: frame.seq, type: "recovery_result", recoveryResult: parsed.recoveryResult };
  }
  if (parsed.type === "control_result") return undefined;
  const spawnError = parsed.type === "refusal" ? parsed.reason : parsed.spawnError;
  return { seq: frame.seq, type: "exit", code: 1, signal: null, spawnError };
}

/** Report undeliverable writes as well as spawn failures to the controller. */
export async function forwardInput(
  slots: Pick<SupervisedSlots, "writeInput"> & Partial<Pick<SupervisedSlots, "undeliverableReason">>,
  slot: number,
  data: string,
  onUndeliverable: (slot: number, reason: string) => void,
): Promise<void> {
  let delivered = false;
  let reason: string | undefined;
  try {
    delivered = await slots.writeInput(slot, data);
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  if (!delivered) onUndeliverable(slot, reason ?? slots.undeliverableReason?.(slot) ?? "cause not recorded");
}

export class SupervisedSlots {
  private readonly bindings = new Map<number, SlotBinding>();
  private readonly configs = new Map<number, SlotSpawnConfig>();
  private readonly queues = new Map<number, Promise<unknown>>();
  private readonly recoveries = new Map<number, RemoteRecoverySnapshot>();
  private readonly sessions = new Map<number, BridgeSessionSnapshot>();
  private readonly controlWaiters = new Map<string, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  private readonly undeliverable = new Map<number, string>();
  private readonly adapterChildPath: string;

  constructor(private readonly options: SupervisedSlotsOptions) {
    this.adapterChildPath = options.adapterChildPath
      ?? fileURLToPath(new URL("./adapter-child.js", import.meta.url));
  }

  async rebind(): Promise<SessiondListSlotsResult> {
    const listed = await this.options.client.listSlots();
    for (const health of listed.health) {
      // Dead slots remain replayable but cannot accept input.
      this.bindings.set(health.slot, {
        mode: "idle",
        buffered: new Map(),
        ...(!health.alive ? { dead: true } : {}),
      });
      // Idle subscription: rebuilds stderr and recovery records from the
      // retained log and keeps them current, without forwarding anything.
      try {
        await this.options.client.subscribe({ slot: health.slot, afterSeq: 0 }, (event) => this.onEvent(health.slot, event));
      } catch (error) {
        if (!(error instanceof SessiondClientError) || error.code !== "slot_not_alive") throw error;
        this.undeliverable.set(health.slot, error.message);
        console.error(`[bridge] slot ${health.slot} disabled: ${error.message}`);
      }
    }
    // Read output expires from the log after a few minutes, so a long turn's
    // recovery record may no longer be there. Ask each live child for it.
    const live = listed.health.filter((health) => health.alive && health.attached);
    await Promise.all(live.map((health) => this.writeControl(health.slot, {
      v: ADAPTER_CHILD_PROTOCOL_VERSION,
      type: "report_recovery",
    }).catch(() => {})));
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && live.some((health) => !this.recoveries.has(health.slot) && !this.sessions.has(health.slot))) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return listed;
  }

  configure(slot: number, config: SlotSpawnConfig): void {
    // Configure marks a new runtime; input alone must not resurrect a dead child.
    if (this.bindings.get(slot)?.dead) {
      this.bindings.delete(slot);
      this.recoveries.delete(slot);
      this.sessions.delete(slot);
    }
    this.configs.set(slot, config);
  }

  async listSlots(params: SessiondListSlotsParams = {}): Promise<SessiondListSlotsResult & {
    health: Array<SessiondListSlotsResult["health"][number] & { session?: BridgeSessionSnapshot; recovery?: RemoteRecoverySnapshot }>;
  }> {
    const listed = await this.options.client.listSlots(params);
    return {
      ...listed,
      health: listed.health.map((entry) => ({
        ...entry,
        ...(this.recoveries.has(entry.slot)
          ? { recovery: this.recoveries.get(entry.slot) }
          : {}),
        ...(this.sessions.has(entry.slot) ? { session: this.sessions.get(entry.slot) } : {}),
      })),
    };
  }

  /** False means the write could not land; callers must report the cause. */
  async writeInput(slot: number, data: string): Promise<boolean> {
    return this.serial(slot, async () => {
      // Mid-session ACP input cannot initialize a replacement child.
      // Retain the dead binding so its exit remains replayable.
      if (this.bindings.get(slot)?.dead) {
        if (!this.undeliverable.has(slot)) this.undeliverable.set(slot, "the slot's process has already exited");
        return false;
      }
      await this.ensure(slot);
      try {
        await this.writeControl(slot, {
          v: ADAPTER_CHILD_PROTOCOL_VERSION,
          type: "input",
          dataBase64: Buffer.from(data).toString("base64"),
        });
      } catch (error) {
        this.undeliverable.set(slot, `sessiond refused a ${data.length}-byte write (${error instanceof Error ? error.message : String(error)})`);
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
      const previousSnapshot = this.recoveries.get(slot);
      const requestId = randomUUID();
      const response = this.waitForControl(requestId);
      try {
        await this.writeControl(slot, { v: ADAPTER_CHILD_PROTOCOL_VERSION, type: "report_recovery" });
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
      const result = await response as { disarmed: boolean };
      if (!result.disarmed) {
        const snapshot = this.recoveries.get(slot);
        if (!snapshot || snapshot === previousSnapshot || snapshot.submissionId !== submissionId || snapshot.phase !== "exhausted"
          || snapshot.errorKind !== "auth_required" || snapshot.disposition !== "none"
          || snapshot.terminalReason !== "budget_exhausted") return result;
        // Old children cannot disarm terminal auth failures. Retire only that ended prompt.
        await this.options.client.kill({ slot });
        const deadline = Date.now() + 10_000;
        while ((await this.options.client.listSlots()).health.some(row => row.slot === slot && row.alive)) {
          if (Date.now() >= deadline) throw new Error(`terminal auth child in slot ${slot} did not exit after disarm`);
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const binding = this.bindings.get(slot);
        if (binding) binding.dead = true;
      }
      this.recoveries.delete(slot);
      return { disarmed: true };
    }) as Promise<{ disarmed: boolean }>;
  }

  async reconcileRecovery(slot: number, input: { submissionId: unknown; acpSessionId: unknown }):
    Promise<{ state: "owned" } | { state: "missing"; cause: string; retainChild?: true }> {
    return this.serial(slot, async () => {
      const health = (await this.options.client.listSlots()).health.find(row => row.slot === slot);
      if (!health || !health.alive) {
        return { state: "missing", cause: `bridge slot ${slot} has no live process` };
      }
      if (!health.attached) return { state: "owned" };
      // Ask the surviving owner for a cached terminal result before reconciling.
      await this.writeControl(slot, { v: ADAPTER_CHILD_PROTOCOL_VERSION, type: "report_recovery" });
      const snapshot = this.recoveries.get(slot);
      if (!snapshot?.reconcileSupported) {
        // Retained pre-rollout children already acknowledge an arm with no input.
        // A host-restart record keeps this away from their initialize/load path.
        if (snapshot?.phase !== "armed" || snapshot.submissionId !== input.submissionId
          || snapshot.acpSessionId !== input.acpSessionId || health.resumePending !== false) return { state: "owned" };
        const requestId = randomUUID();
        const response = this.waitForControl(requestId);
        try {
          await this.writeControl(slot, { v: ADAPTER_CHILD_PROTOCOL_VERSION,
            type: "disarm_recovery", requestId, submissionId: input.submissionId });
        } catch (error) { this.cancelControl(requestId); throw error; }
        const disarmed = (await response as { disarmed: boolean }).disarmed;
        const fresh = this.recoveries.get(slot);
        const owner = (await this.options.client.listSlots()).health.find(row => row.slot === slot);
        if (!disarmed && !(fresh?.phase === "armed" && fresh.submissionId === input.submissionId
          && fresh.acpSessionId === input.acpSessionId && owner?.pid === health.pid
          && owner.alive && owner.attached && owner.resumePending === false)) return { state: "owned" };
        this.recoveries.delete(slot);
        this.sessions.delete(slot);
        return { state: "missing", cause: `bridge slot ${slot} armed recovery but never received a complete session/prompt for this submission`,
          retainChild: true };
      }
      const requestId = randomUUID();
      const response = this.waitForControl(requestId);
      try {
        await this.writeControl(slot, { v: ADAPTER_CHILD_PROTOCOL_VERSION,
          type: "reconcile_recovery", requestId, ...input });
      } catch (error) {
        this.cancelControl(requestId);
        throw error;
      }
      return await response as { state: "owned" } | { state: "missing"; cause: string };
    });
  }

  async permissionControl(slot: number, type: "permission_status" | "answer_permission",
    permission: PendingRequestIdentity, answer?: PendingResponse): Promise<PermissionSnapshot> {
    return this.serial(slot, async () => {
      if (!this.bindings.get(slot) || this.bindings.get(slot)?.dead) return {
        state: "gone", pid: 0, detail: "The original agent process is no longer alive.",
      };
      const requestId = randomUUID();
      const response = this.waitForControl(requestId);
      try {
        await this.writeControl(slot, { v: ADAPTER_CHILD_PROTOCOL_VERSION, type, requestId, permission,
          ...(answer ? { response: answer } : {}) });
      } catch (error) {
        this.cancelControl(requestId);
        throw error;
      }
      return await response as PermissionSnapshot;
    }) as Promise<PermissionSnapshot>;
  }

  /** Why the last write to this slot could not be delivered. */
  undeliverableReason(slot: number): string | undefined {
    return this.undeliverable.get(slot);
  }

  /** The controller has read this slot's output through `throughSeq`. */
  async ack(slot: number, throughSeq: number): Promise<void> {
    // Older supervisors lack ack; their time-based retention still applies.
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

  /** Activate after the command reply so live frames follow retained output. */
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
    // A new consumer cursor permits its retained exit, then deduplicates within this replay.
    binding.exitSeen = false;
    binding.buffered.clear();
    binding.gap = undefined;
    await this.options.client.subscribe({ slot, afterSeq }, (event) => this.onEvent(slot, event));
    // Transport acknowledgement can precede durable turn completion.
    if (!binding.dead) await this.writeControl(slot, {
      v: ADAPTER_CHILD_PROTOCOL_VERSION, type: "report_recovery", replayPermissions: true,
    });
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
      ...threadEnvironment(config.threadIdentity),
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
      binding.dead = true;
      if (binding.exitSeen) return;
      binding.exitSeen = true;
    }
    if (frame.type === "recovery" && frame.recovery) this.recoveries.set(slot, frame.recovery);
    if (frame.type === "session" && frame.session) this.sessions.set(slot, frame.session);
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

  /** Join received slot operations, including input arriving during a transfer. */
  async finishTransfers(): Promise<void> {
    while (this.queues.size > 0) await Promise.allSettled([...this.queues.values()]);
  }

  private serial<T>(slot: number, task: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(slot) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(task);
    // The caller handles `next`; this bookkeeping copy must not become an
    // unhandled rejection that exits the whole bridge.
    const tracked = next.finally(() => {
      if (this.queues.get(slot) === tracked) this.queues.delete(slot);
    });
    tracked.catch(() => undefined);
    this.queues.set(slot, tracked);
    return next;
  }
}
