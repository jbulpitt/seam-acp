import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import { createLineFramer, createOutputLog, type OutputLog, type OutputLogOptions } from "./output-log.js";
import {
  SESSIOND_PROTOCOL_VERSION,
  type SessiondEvent,
  type SessiondKillParams,
  type SessiondListSlotsResult,
  type SessiondOutputFrame,
  type SessiondReplayOutputParams,
  type SessiondAckParams,
  type SessiondReplayOutputResult,
  type SessiondRequest,
  type SessiondResponse,
  type SessiondSlotHealth,
  type SessiondSpawnParams,
  type SessiondSubscribeParams,
  type SessiondWireMessage,
  type SessiondWriteParams,
} from "./sessiond-protocol.js";

const MAX_WIRE_BYTES = 12 * 1024 * 1024;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const ORPHAN_TERM_GRACE_MS = 500;
const ORPHAN_KILL_GRACE_MS = 500;

interface ProcessIdentity {
  pid: number;
  pgid: number;
  /** Kernel/ps process start stamp. Paired with pid to defeat PID reuse. */
  started: string;
}

interface PersistedSlot {
  slot: number;
  pid: number | null;
  identity?: ProcessIdentity;
  status: "live" | "dead";
  lastStdoutAt?: number;
  lastStdinAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

interface PersistedState {
  version: 1;
  slots: PersistedSlot[];
}

interface SlotEntry {
  slot: number;
  child?: ChildProcessWithoutNullStreams;
  pid: number | null;
  identity?: ProcessIdentity;
  attached: boolean;
  lastStdoutAt?: number;
  lastStdinAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  orphanReason?: SessiondSlotHealth["orphanReason"];
  stdoutFramer?: ReturnType<typeof createLineFramer>;
}

interface ConnectionState {
  socket: Socket;
  subscriptions: Set<number>;
  input: Buffer;
}

export interface SessiondServerOptions {
  socketPath: string;
  statePath: string;
  outputLog?: OutputLogOptions;
}

class SessiondError extends Error {
  constructor(
    readonly code: NonNullable<SessiondResponse["error"]>["code"],
    message: string,
    readonly processCode?: string,
    readonly syscall?: string,
  ) {
    super(message);
  }
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new SessiondError("invalid_request", `${label} must be a non-negative integer`);
  }
  return Number(value);
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SessiondError("invalid_request", "params must be an object");
  }
  return value as Record<string, unknown>;
}

function noNul(value: string, label: string): string {
  if (value.includes("\0")) throw new SessiondError("invalid_request", `${label} contains NUL`);
  return value;
}

function parseSpawnParams(raw: unknown): SessiondSpawnParams {
  const value = plainRecord(raw);
  const slot = safeInteger(value.slot, "slot");
  if (typeof value.executable !== "string" || !path.isAbsolute(value.executable)) {
    throw new SessiondError("invalid_request", "spawn executable must be absolute");
  }
  if (typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)) {
    throw new SessiondError("invalid_request", "spawn cwd must be absolute");
  }
  if (!Array.isArray(value.args) && value.args !== undefined) {
    throw new SessiondError("invalid_request", "spawn args must be an array");
  }
  const args = (value.args ?? []).map((arg, index) => {
    if (typeof arg !== "string") throw new SessiondError("invalid_request", `spawn arg ${index} must be a string`);
    return noNul(arg, `spawn arg ${index}`);
  });
  if (!value.env || typeof value.env !== "object" || Array.isArray(value.env)) {
    throw new SessiondError("invalid_request", "spawn env must be an object");
  }
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value.env as Record<string, unknown>)) {
    if (!key || key.includes("=") || key.includes("\0") || typeof item !== "string") {
      throw new SessiondError("invalid_request", "spawn env contains an invalid entry");
    }
    env[key] = noNul(item, `spawn env ${key}`);
  }
  if (value.initialStdinBase64 !== undefined && typeof value.initialStdinBase64 !== "string") {
    throw new SessiondError("invalid_request", "spawn initialStdinBase64 must be a string");
  }
  return {
    slot,
    executable: noNul(value.executable, "spawn executable"),
    args,
    cwd: noNul(value.cwd, "spawn cwd"),
    env,
    ...(typeof value.initialStdinBase64 === "string"
      ? { initialStdinBase64: value.initialStdinBase64 }
      : {}),
  };
}

function parseWriteParams(raw: unknown): SessiondWriteParams {
  const value = plainRecord(raw);
  if (typeof value.dataBase64 !== "string") {
    throw new SessiondError("invalid_request", "write dataBase64 must be a string");
  }
  return { slot: safeInteger(value.slot, "slot"), dataBase64: value.dataBase64 };
}

function parseCursorParams(raw: unknown): SessiondSubscribeParams | SessiondReplayOutputParams {
  const value = plainRecord(raw);
  return {
    slot: safeInteger(value.slot, "slot"),
    afterSeq: safeInteger(value.afterSeq, "afterSeq"),
  };
}

function parseAckParams(raw: unknown): SessiondAckParams {
  const value = plainRecord(raw);
  return { slot: safeInteger(value.slot, "slot"), throughSeq: safeInteger(value.throughSeq, "throughSeq") };
}

const ALLOWED_SIGNALS = new Set<NodeJS.Signals>(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);

function parseKillParams(raw: unknown): SessiondKillParams {
  const value = plainRecord(raw);
  const signal = value.signal === undefined ? "SIGTERM" : value.signal;
  if (typeof signal !== "string" || !ALLOWED_SIGNALS.has(signal as NodeJS.Signals)) {
    throw new SessiondError("invalid_request", "kill signal is not allowed");
  }
  return { slot: safeInteger(value.slot, "slot"), signal: signal as NodeJS.Signals };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Read a portable pid-reuse guard. `ps` exists on both Linux and macOS hosts,
 * and a detached Node child is its own process-group leader. A pid alone is
 * never enough authority to signal after a supervisor crash.
 */
export function readSessiondProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!processExists(pid)) return undefined;
  if (process.platform === "linux") {
    try {
      // `/proc/<pid>/stat` fields after comm begin at field 3. pgrp is field 5
      // and starttime is field 22. Splitting after the LAST ')' handles spaces
      // and parentheses in comm without treating a process name as structure.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close === -1) return undefined;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      const pgid = Number(fields[2]);
      const startTicks = fields[19];
      if (!Number.isSafeInteger(pgid) || !startTicks) return undefined;
      return { pid, pgid, started: `linux:${startTicks}` };
    } catch {
      return undefined;
    }
  }
  try {
    const raw = execFileSync("/bin/ps", ["-p", String(pid), "-o", "pid=", "-o", "pgid=", "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 8 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = /^(\d+)\s+(\d+)\s+(.+)$/.exec(raw);
    if (!match || Number(match[1]) !== pid) return undefined;
    return { pid, pgid: Number(match[2]), started: match[3]!.trim().replace(/\s+/g, " ") };
  } catch {
    return undefined;
  }
}

function sameIdentity(left: ProcessIdentity | undefined, right: ProcessIdentity | undefined): boolean {
  return !!left && !!right && left.pid === right.pid && left.pgid === right.pgid && left.started === right.started;
}

function encode(message: SessiondWireMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function writeWire(socket: Socket, message: SessiondWireMessage): void {
  if (!socket.destroyed && socket.writable) socket.write(encode(message));
}

function outputFrame(frame: { seq: number; at: number; type: string; payload: Record<string, unknown> }): SessiondOutputFrame {
  return {
    seq: frame.seq,
    at: frame.at,
    stream: frame.type as SessiondOutputFrame["stream"],
    ...(typeof frame.payload.dataBase64 === "string" ? { dataBase64: frame.payload.dataBase64 } : {}),
    ...(frame.type === "exit" ? {
      code: typeof frame.payload.code === "number" || frame.payload.code === null
        ? frame.payload.code as number | null
        : null,
      signal: typeof frame.payload.signal === "string" || frame.payload.signal === null
        ? frame.payload.signal as NodeJS.Signals | null
        : null,
    } : {}),
  };
}

async function waitUntilGone(identity: ProcessIdentity, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!sameIdentity(identity, readSessiondProcessIdentity(identity.pid))) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !sameIdentity(identity, readSessiondProcessIdentity(identity.pid));
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("sessiond runtime directory must be a real directory");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("sessiond runtime directory has the wrong owner");
  }
  if ((stat.mode & 0o077) !== 0) throw new Error("sessiond runtime directory must be mode 0700");
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isSocket() || stat.isSymbolicLink()) {
    throw new Error("sessiond socket path exists and is not a socket");
  }
  await new Promise<void>((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      reject(new Error("another seam-sessiond is already listening"));
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
      else reject(error);
    });
  });
  await fs.unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

export class SessiondServer {
  private readonly slots = new Map<number, SlotEntry>();
  private readonly connections = new Set<ConnectionState>();
  private readonly outputLog: OutputLog;
  private readonly server: net.Server;
  private readonly backpressured = new Set<number>();
  private persistQueue: Promise<void> = Promise.resolve();
  private started = false;

  constructor(private readonly options: SessiondServerOptions) {
    this.outputLog = createOutputLog(options.outputLog);
    this.server = net.createServer((socket) => this.accept(socket));
  }

  async start(): Promise<void> {
    if (this.started) return;
    await assertPrivateDirectory(path.dirname(this.options.socketPath));
    await assertPrivateDirectory(path.dirname(this.options.statePath));
    await this.recoverPersistedSlots();
    await removeStaleSocket(this.options.socketPath);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.options.socketPath, () => {
        this.server.off("error", onError);
        resolve();
      });
    });
    await fs.chmod(this.options.socketPath, 0o600);
    this.started = true;
  }

  /**
   * Stop only the control socket when `terminateChildren` is false. Production
   * signals use true; false exists for crash/restart tests and leaves exactly
   * the state a successor must recover. A client disconnect never calls this.
   */
  async close(options: { terminateChildren?: boolean } = {}): Promise<void> {
    const ownedSocket = this.started;
    if (options.terminateChildren) {
      const live = [...this.slots.values()].filter((entry) => entry.attached && this.entryAlive(entry));
      for (const entry of this.slots.values()) {
        if (entry.attached && this.entryAlive(entry)) entry.child?.kill("SIGTERM");
      }
      await Promise.all(live.map(async (entry) => {
        const deadline = Date.now() + ORPHAN_TERM_GRACE_MS;
        while (this.entryAlive(entry) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
        if (this.entryAlive(entry)) {
          entry.child?.kill("SIGKILL");
          const killDeadline = Date.now() + ORPHAN_KILL_GRACE_MS;
          while (this.entryAlive(entry) && Date.now() < killDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }));
    }
    for (const connection of this.connections) connection.socket.destroy();
    this.connections.clear();
    if (this.started) {
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
      this.started = false;
    }
    if (ownedSocket) {
      await fs.unlink(this.options.socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await this.persistQueue;
  }

  private accept(socket: Socket): void {
    const connection: ConnectionState = { socket, subscriptions: new Set(), input: Buffer.alloc(0) };
    this.connections.add(connection);
    socket.on("data", (chunk: Buffer) => this.receive(connection, chunk));
    socket.on("error", () => undefined);
    socket.on("close", () => {
      // Link loss proves nothing about the child. Drop only this subscriber;
      // every slot and descriptor remains owned by sessiond.
      this.connections.delete(connection);
    });
  }

  private receive(connection: ConnectionState, chunk: Buffer): void {
    connection.input = Buffer.concat([connection.input, chunk]);
    if (connection.input.length > MAX_WIRE_BYTES && connection.input.indexOf(0x0a) === -1) {
      connection.socket.destroy();
      return;
    }
    let newline = connection.input.indexOf(0x0a);
    while (newline !== -1) {
      const line = connection.input.subarray(0, newline);
      connection.input = connection.input.subarray(newline + 1);
      if (line.length > MAX_WIRE_BYTES) {
        connection.socket.destroy();
        return;
      }
      if (line.length) void this.handleLine(connection, line.toString("utf8"));
      newline = connection.input.indexOf(0x0a);
    }
  }

  private async handleLine(connection: ConnectionState, line: string): Promise<void> {
    let request: SessiondRequest;
    try {
      request = JSON.parse(line) as SessiondRequest;
      if (request.v !== SESSIOND_PROTOCOL_VERSION || typeof request.id !== "string" || !request.id) {
        throw new SessiondError("invalid_request", "invalid protocol version or request id");
      }
      const payload = await this.dispatch(connection, request);
      writeWire(connection.socket, { v: SESSIOND_PROTOCOL_VERSION, id: request.id, ok: true, payload });
    } catch (error) {
      const id = (() => {
        try {
          const parsed = JSON.parse(line) as { id?: unknown };
          return typeof parsed.id === "string" && parsed.id ? parsed.id : "invalid";
        } catch {
          return "invalid";
        }
      })();
      const known = error instanceof SessiondError ? error : new SessiondError("internal_error", "sessiond request failed");
      writeWire(connection.socket, {
        v: SESSIOND_PROTOCOL_VERSION,
        id,
        ok: false,
        error: {
          code: known.code,
          message: known.message,
          ...(known.processCode ? { processCode: known.processCode } : {}),
          ...(known.syscall ? { syscall: known.syscall } : {}),
        },
      });
    }
  }

  private async dispatch(connection: ConnectionState, request: SessiondRequest): Promise<unknown> {
    switch (request.method) {
      case "spawn": return this.spawnSlot(parseSpawnParams(request.params));
      case "write": return this.writeSlot(parseWriteParams(request.params));
      case "subscribe": return this.subscribe(connection, parseCursorParams(request.params));
      case "kill": return this.killSlot(parseKillParams(request.params));
      case "listSlots": return this.listSlots();
      case "replayOutput": return this.replayOutput(parseCursorParams(request.params));
      case "ack": {
        const params = parseAckParams(request.params);
        this.outputLog.ack(params.slot, params.throughSeq);
        return { slot: params.slot };
      }
      default: throw new SessiondError("invalid_request", "unknown sessiond method");
    }
  }

  private async spawnSlot(params: SessiondSpawnParams): Promise<{ slot: number; pid: number }> {
    const existing = this.slots.get(params.slot);
    if (existing && this.entryAlive(existing)) {
      throw new SessiondError("slot_exists", "spawn refused: slot already has a live process");
    }
    if (existing) {
      this.slots.delete(params.slot);
      this.outputLog.dropSlot(params.slot);
    }

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(params.executable, params.args ?? [], {
        cwd: params.cwd,
        env: params.env,
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const cause = error as NodeJS.ErrnoException;
      throw new SessiondError(
        "spawn_failed",
        "spawn failed before a child was created",
        cause.code,
        "spawn",
      );
    }
    // #583: ENOENT is asynchronous. Attach BOTH the permanent absorber and
    // the typed admission listener synchronously, before the first await. The
    // raw Node error contains path + spawnargs, so it must never escape this
    // supervisor boundary; one failed slot is refused and all others run.
    child.on("error", () => undefined);
    const admitted = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (error: NodeJS.ErrnoException) => reject(new SessiondError(
        "spawn_failed",
        "spawn failed before the child became ready",
        error.code,
        "spawn",
      )));
    });
    try {
      await admitted;
    } catch (error) {
      throw error;
    }
    const pid = child.pid;
    if (!pid) {
      child.kill("SIGKILL");
      throw new SessiondError("spawn_failed", "spawn returned no child pid");
    }
    const identity = readSessiondProcessIdentity(pid);
    if (!identity || identity.pgid !== pid) {
      // Without a pid-reuse guard a successor could kill an unrelated process.
      // Refuse only this spawn; the daemon and every other slot keep working.
      child.kill("SIGKILL");
      throw new SessiondError("spawn_failed", "spawned child identity could not be verified");
    }
    const entry: SlotEntry = {
      slot: params.slot,
      child,
      pid,
      identity,
      attached: true,
      stdoutFramer: createLineFramer(),
    };
    this.slots.set(params.slot, entry);
    this.attachChild(entry, child);
    if (params.initialStdinBase64 !== undefined) {
      let initial: Buffer;
      try {
        initial = Buffer.from(params.initialStdinBase64, "base64");
        if (initial.toString("base64") !== params.initialStdinBase64) throw new Error("invalid base64");
      } catch {
        child.kill("SIGKILL");
        throw new SessiondError("invalid_request", "spawn initialStdinBase64 is invalid");
      }
      if (initial.length > MAX_WRITE_BYTES) {
        child.kill("SIGKILL");
        throw new SessiondError("invalid_request", "spawn initial stdin exceeds the 8 MiB limit");
      }
      try {
        child.stdin.write(initial);
      } catch {
        child.kill("SIGKILL");
        throw new SessiondError("write_failed", "spawn bootstrap failed before bytes were accepted");
      }
    }
    await this.persist();
    return { slot: params.slot, pid };
  }

  private attachChild(entry: SlotEntry, child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer) => {
      entry.lastStdoutAt = Date.now();
      for (const line of entry.stdoutFramer?.push(chunk.toString()) ?? []) {
        this.publish(entry.slot, "stdout", { dataBase64: Buffer.from(line).toString("base64") }, entry.lastStdoutAt);
      }
    });
    // The supervisor must drain fd 2 even while no control plane is attached;
    // otherwise a full pipe blocks the child and manufactures a hang.
    child.stderr.on("data", (chunk: Buffer) => {
      this.publish(entry.slot, "stderr", { dataBase64: chunk.toString("base64") });
    });
    child.on("error", () => {
      // The exit event is the authoritative terminal record when it follows.
      // If it does not, retain a dead entry rather than leaking raw OS detail.
      if (this.entryAlive(entry)) return;
      entry.exitCode = child.exitCode;
      entry.signal = child.signalCode as NodeJS.Signals | null;
      void this.persist().catch(() => undefined);
    });
    child.on("exit", (code, signal) => {
      const tail = entry.stdoutFramer?.flush();
      if (tail) this.publish(entry.slot, "stdout", { dataBase64: Buffer.from(tail).toString("base64") });
      entry.exitCode = code;
      entry.signal = signal as NodeJS.Signals | null;
      this.backpressured.delete(entry.slot);
      this.publish(entry.slot, "exit", { code, signal });
      void this.persist().catch(() => undefined);
    });
  }

  private publish(slot: number, stream: SessiondOutputFrame["stream"], payload: Record<string, unknown>, now = Date.now()): void {
    const seq = this.outputLog.append(slot, stream, payload, now);
    const frame = outputFrame({ seq, at: now, type: stream, payload });
    const event: SessiondEvent = { v: SESSIOND_PROTOCOL_VERSION, type: "output", slot, frame, replay: false };
    for (const connection of this.connections) {
      if (connection.subscriptions.has(slot)) writeWire(connection.socket, event);
    }
  }

  private writeSlot(params: SessiondWriteParams): { slot: number; acceptedBytes: number; backpressured: boolean } {
    const entry = this.slots.get(params.slot);
    if (!entry) throw new SessiondError("slot_not_found", "write refused: slot does not exist");
    if (!entry.attached || !this.entryAlive(entry) || !entry.child?.stdin.writable) {
      throw new SessiondError("slot_not_alive", "write refused: slot has no attached live process");
    }
    if (this.backpressured.has(params.slot)) {
      throw new SessiondError("write_failed", "write refused: slot stdin is backpressured");
    }
    let data: Buffer;
    try {
      if (params.dataBase64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(params.dataBase64)) {
        throw new Error("invalid base64");
      }
      data = Buffer.from(params.dataBase64, "base64");
      if (data.toString("base64") !== params.dataBase64) {
        // Buffer's decoder is deliberately forgiving; the protocol is not.
        throw new Error("invalid base64");
      }
    } catch {
      throw new SessiondError("invalid_request", "write dataBase64 is invalid");
    }
    if (data.length > MAX_WRITE_BYTES) throw new SessiondError("invalid_request", "write exceeds the 8 MiB limit");
    try {
      const writable = entry.child.stdin.write(data);
      entry.lastStdinAt = Date.now();
      if (!writable) {
        this.backpressured.add(params.slot);
        entry.child.stdin.once("drain", () => this.backpressured.delete(params.slot));
      }
      return { slot: params.slot, acceptedBytes: data.length, backpressured: !writable };
    } catch {
      throw new SessiondError("write_failed", "write failed before bytes were accepted");
    }
  }

  private subscribe(connection: ConnectionState, params: SessiondSubscribeParams): { slot: number; subscribed: true; throughSeq: number } {
    if (!this.slots.has(params.slot)) throw new SessiondError("slot_not_found", "subscribe refused: slot does not exist");
    // Registration, replay, and acknowledgement happen in one event-loop turn.
    // A child event cannot interleave, so the consumer observes retained frames
    // first and every later live frame exactly once on this connection.
    connection.subscriptions.add(params.slot);
    const replay = this.outputLog.since(params.slot, params.afterSeq);
    if (replay.gap) {
      writeWire(connection.socket, {
        v: SESSIOND_PROTOCOL_VERSION,
        type: "output_gap",
        slot: params.slot,
        gap: replay.gap,
      });
    }
    let throughSeq = params.afterSeq;
    for (const retained of replay.frames) {
      throughSeq = retained.seq;
      writeWire(connection.socket, {
        v: SESSIOND_PROTOCOL_VERSION,
        type: "output",
        slot: params.slot,
        frame: outputFrame(retained),
        replay: true,
      });
    }
    return { slot: params.slot, subscribed: true, throughSeq };
  }

  private killSlot(params: SessiondKillParams): { slot: number; signalled: boolean; alreadyDead: boolean } {
    const entry = this.slots.get(params.slot);
    if (!entry) throw new SessiondError("slot_not_found", "kill refused: slot does not exist");
    if (!this.entryAlive(entry)) return { slot: params.slot, signalled: false, alreadyDead: true };
    const signal = params.signal ?? "SIGTERM";
    let signalled = false;
    if (entry.attached && entry.child) {
      signalled = entry.child.kill(signal);
    } else if (entry.identity && sameIdentity(entry.identity, readSessiondProcessIdentity(entry.identity.pid))) {
      try {
        process.kill(-entry.identity.pgid, signal);
        signalled = true;
      } catch {
        signalled = false;
      }
    }
    if (!signalled) throw new SessiondError("slot_not_alive", "kill could not signal the recorded process");
    return { slot: params.slot, signalled: true, alreadyDead: false };
  }

  private listSlots(): SessiondListSlotsResult {
    const now = Date.now();
    const health = [...this.slots.values()].map((entry): SessiondSlotHealth => ({
      slot: entry.slot,
      alive: this.entryAlive(entry),
      pid: entry.pid,
      lastStdoutMsAgo: entry.lastStdoutAt === undefined ? null : Math.max(0, now - entry.lastStdoutAt),
      lastStdinMsAgo: entry.lastStdinAt === undefined ? null : Math.max(0, now - entry.lastStdinAt),
      attached: entry.attached,
      ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
      ...(entry.signal !== undefined ? { signal: entry.signal } : {}),
      ...(entry.orphanReason ? { orphanReason: entry.orphanReason } : {}),
    }));
    return { slots: health.map((entry) => entry.slot), health };
  }

  private replayOutput(params: SessiondReplayOutputParams): SessiondReplayOutputResult {
    if (!this.slots.has(params.slot)) throw new SessiondError("slot_not_found", "replay refused: slot does not exist");
    const replay = this.outputLog.since(params.slot, params.afterSeq);
    return {
      slot: params.slot,
      frames: replay.frames.map(outputFrame),
      ...(replay.gap ? { gap: replay.gap } : {}),
    };
  }

  private entryAlive(entry: SlotEntry): boolean {
    if (entry.attached && entry.child) {
      // `ChildProcess.killed` means only that kill() successfully sent a
      // signal. A TERM-ignoring child is still alive until exitCode/signalCode
      // changes, and listSlots must report that fact rather than intent.
      return entry.child.exitCode === null && entry.child.signalCode === null;
    }
    return !!entry.identity && sameIdentity(entry.identity, readSessiondProcessIdentity(entry.identity.pid));
  }

  private async recoverPersistedSlots(): Promise<void> {
    let parsed: PersistedState;
    try {
      parsed = JSON.parse(await fs.readFile(this.options.statePath, "utf8")) as PersistedState;
      if (parsed.version !== 1 || !Array.isArray(parsed.slots)) throw new Error("invalid state");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("sessiond state file is invalid");
    }

    const verified: Array<{ entry: SlotEntry; identity: ProcessIdentity }> = [];
    for (const record of parsed.slots) {
      const entry: SlotEntry = {
        slot: record.slot,
        pid: record.pid,
        identity: record.identity,
        attached: false,
        lastStdoutAt: record.lastStdoutAt,
        lastStdinAt: record.lastStdinAt,
        exitCode: record.exitCode,
        signal: record.signal,
      };
      this.slots.set(entry.slot, entry);
      if (record.status !== "live") continue;
      if (!record.identity || !record.pid) {
        entry.orphanReason = "identity_unverifiable";
        entry.pid = null;
        continue;
      }
      const observed = readSessiondProcessIdentity(record.pid);
      if (!observed) {
        entry.orphanReason = "supervisor_restarted";
        entry.exitCode = null;
        entry.signal = null;
      } else if (!sameIdentity(record.identity, observed)) {
        entry.orphanReason = "identity_mismatch";
        entry.pid = null;
        entry.exitCode = null;
        entry.signal = null;
      } else {
        verified.push({ entry, identity: record.identity });
      }
    }

    // A supervisor crash destroyed these slots' descriptors. The exact
    // pid+pgid+start stamp is positive ownership evidence; only those process
    // groups are reaped. An unverifiable record is reported, never signalled.
    const escalated = new Set<number>();
    for (const { identity } of verified) {
      try { process.kill(-identity.pgid, "SIGTERM"); } catch { /* already gone */ }
    }
    await Promise.all(verified.map(({ identity }) => waitUntilGone(identity, ORPHAN_TERM_GRACE_MS)));
    for (const { identity } of verified) {
      if (!sameIdentity(identity, readSessiondProcessIdentity(identity.pid))) continue;
      try { process.kill(-identity.pgid, "SIGKILL"); } catch { /* already gone */ }
      escalated.add(identity.pid);
    }
    await Promise.all(verified.map(({ identity }) => waitUntilGone(identity, ORPHAN_KILL_GRACE_MS)));
    for (const { entry, identity } of verified) {
      entry.orphanReason = "supervisor_restarted";
      if (!sameIdentity(identity, readSessiondProcessIdentity(identity.pid))) {
        entry.exitCode = null;
        entry.signal = escalated.has(identity.pid) ? "SIGKILL" : "SIGTERM";
      }
    }
    await this.persist();
  }

  private persist(): Promise<void> {
    this.persistQueue = this.persistQueue.then(async () => {
      const state: PersistedState = {
        version: 1,
        slots: [...this.slots.values()].map((entry) => ({
          slot: entry.slot,
          pid: entry.pid,
          ...(entry.identity ? { identity: entry.identity } : {}),
          status: this.entryAlive(entry) ? "live" : "dead",
          ...(entry.lastStdoutAt !== undefined ? { lastStdoutAt: entry.lastStdoutAt } : {}),
          ...(entry.lastStdinAt !== undefined ? { lastStdinAt: entry.lastStdinAt } : {}),
          ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
          ...(entry.signal !== undefined ? { signal: entry.signal } : {}),
        })),
      };
      const temporary = `${this.options.statePath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.options.statePath);
      await fs.chmod(this.options.statePath, 0o600);
    });
    return this.persistQueue;
  }
}
