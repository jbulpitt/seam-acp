import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, openSync, closeSync, readFileSync } from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createOutputLog, type OutputLog, type OutputLogOptions } from "./output-log.js";
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
import {
  SLOT_HOLDER_PROTOCOL_VERSION,
  type SlotHolderFrame,
  type SlotHolderInput,
  type SlotHolderOutput,
} from "./slot-holder-protocol.js";

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
  /** The slot holder's socket (#631). Absent for pre-holder records. */
  socketPath?: string;
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
  /** The supervised child's pid, as reported to clients. */
  pid: number | null;
  /** The slot holder's identity: it owns the child and its stdio. */
  identity?: ProcessIdentity;
  socketPath?: string;
  link?: Socket;
  /** True while this sessiond is connected to the slot's holder. */
  attached: boolean;
  /** The holder reported the child's exit. */
  exited?: boolean;
  lastSeq: number;
  replies: Map<string, (message: SlotHolderOutput) => void>;
  lastStdoutAt?: number;
  lastStdinAt?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  orphanReason?: SessiondSlotHealth["orphanReason"];
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
  /** The slot holder entry point; tests run it from source. */
  holderPath?: string;
}

function defaultHolderPath(): string {
  return process.env.SEAM_SLOT_HOLDER_PATH
    ?? fileURLToPath(new URL("./slot-holder.js", import.meta.url));
}

function holderMessage(message: SlotHolderInput): string {
  return `${JSON.stringify(message)}\n`;
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
  private closing = false;

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
   * Stop this supervisor. Slots keep running in their holders and the next
   * sessiond reconnects to them (#631). `terminateChildren` ends every slot;
   * only tests use it, to clean up.
   */
  async close(options: { terminateChildren?: boolean } = {}): Promise<void> {
    const ownedSocket = this.started;
    this.closing = true;
    if (options.terminateChildren) {
      const live = [...this.slots.values()].filter((entry) => this.holderAlive(entry));
      for (const entry of live) {
        try { process.kill(-entry.identity!.pgid, "SIGTERM"); } catch { /* gone */ }
      }
      await Promise.all(live.map(async (entry) => {
        if (!await waitUntilGone(entry.identity!, ORPHAN_TERM_GRACE_MS)) {
          try { process.kill(-entry.identity!.pgid, "SIGKILL"); } catch { /* gone */ }
          await waitUntilGone(entry.identity!, ORPHAN_KILL_GRACE_MS);
        }
      }));
    }
    for (const entry of this.slots.values()) entry.link?.destroy();
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
        // The holder keeps unread output across a sessiond restart; let it go.
        const entry = this.slots.get(params.slot);
        entry?.link?.write(holderMessage({ v: SLOT_HOLDER_PROTOCOL_VERSION, type: "ack", throughSeq: params.throughSeq }));
        return { slot: params.slot };
      }
      default: throw new SessiondError("invalid_request", "unknown sessiond method");
    }
  }

  private slotsDirectory(): string {
    return path.join(path.dirname(this.options.socketPath), "slots");
  }

  private async spawnSlot(params: SessiondSpawnParams): Promise<{ slot: number; pid: number }> {
    const existing = this.slots.get(params.slot);
    if (existing && this.entryAlive(existing)) {
      throw new SessiondError("slot_exists", "spawn refused: slot already has a live process");
    }
    if (existing) {
      // A finished holder may still be waiting to hand over the exit.
      if (existing.identity && this.holderAlive(existing)) {
        try { process.kill(existing.identity.pid, "SIGTERM"); } catch { /* gone */ }
      }
      existing.link?.destroy();
      this.slots.delete(params.slot);
      this.outputLog.dropSlot(params.slot);
    }
    let initial: Buffer | undefined;
    if (params.initialStdinBase64 !== undefined) {
      initial = Buffer.from(params.initialStdinBase64, "base64");
      if (initial.toString("base64") !== params.initialStdinBase64) {
        throw new SessiondError("invalid_request", "spawn initialStdinBase64 is invalid");
      }
      if (initial.length > MAX_WRITE_BYTES) {
        throw new SessiondError("invalid_request", "spawn initial stdin exceeds the 8 MiB limit");
      }
    }

    // The holder owns the child's stdio so the child outlives this process.
    // Its own output goes to a private per-slot log for diagnosis.
    const directory = this.slotsDirectory();
    await assertPrivateDirectory(directory);
    const socketPath = path.join(directory, `${params.slot}-${randomUUID().slice(0, 8)}.sock`);
    const logFd = openSync(path.join(directory, `${params.slot}.log`), "a", 0o600);
    let holder;
    try {
      holder = spawn(process.execPath, [this.options.holderPath ?? defaultHolderPath(), socketPath], {
        cwd: "/",
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
          ...(process.env.SEAM_SLOT_HOLDER_PATH ? { SEAM_SLOT_HOLDER_PATH: process.env.SEAM_SLOT_HOLDER_PATH } : {}) },
        detached: true,
        shell: false,
        stdio: ["ignore", logFd, logFd],
      });
    } catch (error) {
      throw new SessiondError("spawn_failed", "spawn failed before a child was created",
        (error as NodeJS.ErrnoException).code, "spawn");
    } finally {
      closeSync(logFd);
    }
    holder.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      holder.once("spawn", resolve);
      holder.once("error", (error: NodeJS.ErrnoException) => reject(new SessiondError(
        "spawn_failed", "spawn failed before the child became ready", error.code, "spawn")));
    });
    holder.unref();
    const holderPid = holder.pid;
    const identity = holderPid ? readSessiondProcessIdentity(holderPid) : undefined;
    if (!holderPid || !identity || identity.pgid !== holderPid) {
      // Without a pid-reuse guard a successor could signal an unrelated process.
      if (holderPid) try { process.kill(-holderPid, "SIGKILL"); } catch { /* gone */ }
      throw new SessiondError("spawn_failed", "spawned child identity could not be verified");
    }
    const entry: SlotEntry = {
      slot: params.slot,
      pid: null,
      identity,
      socketPath,
      attached: false,
      lastSeq: 0,
      replies: new Map(),
    };
    this.slots.set(params.slot, entry);
    const abandon = (error: SessiondError): never => {
      try { process.kill(-identity.pgid, "SIGKILL"); } catch { /* gone */ }
      entry.link?.destroy();
      this.slots.delete(params.slot);
      throw error;
    };
    if (!await this.connectHolder(entry, 5_000)) {
      abandon(new SessiondError("spawn_failed", "the slot holder did not start"));
    }
    const result = await this.holderRequest(entry, "spawn_result", {
      v: SLOT_HOLDER_PROTOCOL_VERSION,
      type: "spawn",
      executable: params.executable,
      args: params.args ?? [],
      cwd: params.cwd,
      env: params.env,
    }).catch(() => undefined);
    if (!result || result.type !== "spawn_result" || !result.ok || !result.pid) {
      const code = result?.type === "spawn_result" ? result.code : undefined;
      abandon(new SessiondError("spawn_failed", "spawn failed before the child became ready", code, "spawn"));
    }
    entry.pid = (result as { pid: number }).pid;
    if (initial) {
      const written = await this.holderWrite(entry, initial).catch(() => false);
      if (!written) abandon(new SessiondError("write_failed", "spawn bootstrap failed before bytes were accepted"));
    }
    await this.persist();
    return { slot: params.slot, pid: entry.pid! };
  }

  /** Connect (or reconnect) to a slot's holder and resume its stream. */
  private async connectHolder(entry: SlotEntry, timeoutMs: number): Promise<boolean> {
    const socketPath = entry.socketPath;
    if (!socketPath) return false;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const socket = await new Promise<Socket | undefined>((resolve) => {
        const attempt = net.createConnection(socketPath);
        attempt.once("connect", () => resolve(attempt));
        attempt.once("error", () => { attempt.destroy(); resolve(undefined); });
      });
      if (socket) {
        this.bindHolderSocket(entry, socket);
        const ack = await this.holderRequest(entry, "hello_ack",
          { v: SLOT_HOLDER_PROTOCOL_VERSION, type: "hello", afterSeq: entry.lastSeq }).catch(() => undefined);
        if (ack?.type === "hello_ack") {
          if (ack.pid) entry.pid = ack.pid;
          entry.attached = true;
          entry.orphanReason = undefined;
          return true;
        }
        socket.destroy();
      }
      if (Date.now() >= deadline || !this.holderAlive(entry)) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private bindHolderSocket(entry: SlotEntry, socket: Socket): void {
    entry.link?.destroy();
    entry.link = socket;
    let input = "";
    socket.on("data", (chunk: Buffer) => {
      input += chunk.toString();
      let newline: number;
      while ((newline = input.indexOf("\n")) !== -1) {
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        let message: SlotHolderOutput;
        try {
          message = JSON.parse(line) as SlotHolderOutput;
        } catch {
          continue;
        }
        if (message.type === "frame") this.onHolderFrame(entry, message.frame);
        else {
          const key = message.type === "write_result" ? `write:${message.id}` : message.type;
          const reply = entry.replies.get(key);
          if (reply) {
            entry.replies.delete(key);
            reply(message);
          }
        }
      }
    });
    socket.on("error", () => undefined);
    socket.on("drain", () => this.backpressured.delete(entry.slot));
    socket.on("close", () => {
      if (entry.link !== socket) return;
      entry.link = undefined;
      entry.attached = false;
      for (const reply of entry.replies.values()) reply({ v: SLOT_HOLDER_PROTOCOL_VERSION, type: "write_result", id: "", ok: false });
      entry.replies.clear();
      void this.afterHolderLoss(entry);
    });
  }

  /** The link dropped. A live holder is reconnected; a gone one is a dead slot. */
  private async afterHolderLoss(entry: SlotEntry): Promise<void> {
    if (this.closing || this.slots.get(entry.slot) !== entry) return;
    if (this.holderAlive(entry)) {
      if (await this.connectHolder(entry, 10_000)) return;
    }
    if (!entry.exited) {
      // The holder died without reporting the child's exit (killed with it).
      entry.exited = true;
      entry.exitCode = entry.exitCode ?? null;
      entry.signal = entry.signal ?? null;
      this.publish(entry.slot, { seq: entry.lastSeq + 1, at: Date.now(), stream: "exit", code: null, signal: null });
    }
    void this.persist().catch(() => undefined);
  }

  private holderRequest(entry: SlotEntry, replyType: string, message: SlotHolderInput): Promise<SlotHolderOutput> {
    return new Promise((resolve, reject) => {
      if (!entry.link || entry.link.destroyed) {
        reject(new Error("slot holder is not connected"));
        return;
      }
      const timer = setTimeout(() => {
        entry.replies.delete(replyType);
        reject(new Error("slot holder did not answer"));
      }, 10_000);
      timer.unref();
      entry.replies.set(replyType, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      if (!entry.link.write(holderMessage(message))) this.backpressured.add(entry.slot);
    });
  }

  private async holderWrite(entry: SlotEntry, data: Buffer): Promise<boolean> {
    const id = randomUUID();
    const reply = await this.holderRequest(entry, `write:${id}`, {
      v: SLOT_HOLDER_PROTOCOL_VERSION, type: "write", id, dataBase64: data.toString("base64"),
    });
    return reply.type === "write_result" && reply.ok;
  }

  private onHolderFrame(entry: SlotEntry, frame: SlotHolderFrame): void {
    // A reconnect resends what this sessiond may already hold.
    if (frame.seq <= entry.lastSeq) return;
    if (frame.stream === "stdout") entry.lastStdoutAt = frame.at;
    if (frame.stream === "exit") {
      entry.exited = true;
      entry.exitCode = frame.code ?? null;
      entry.signal = frame.signal ?? null;
      this.backpressured.delete(entry.slot);
      void this.persist().catch(() => undefined);
    }
    this.publish(entry.slot, frame);
  }

  private publish(slot: number, frame: SlotHolderFrame): void {
    const entry = this.slots.get(slot);
    if (entry) entry.lastSeq = Math.max(entry.lastSeq, frame.seq);
    const payload: Record<string, unknown> = frame.stream === "exit"
      ? { code: frame.code ?? null, signal: frame.signal ?? null }
      : { dataBase64: frame.dataBase64 };
    const seq = this.outputLog.append(slot, frame.stream, payload, frame.at, frame.seq);
    const event: SessiondEvent = { v: SESSIOND_PROTOCOL_VERSION, type: "output", slot,
      frame: outputFrame({ seq, at: frame.at, type: frame.stream, payload }), replay: false };
    for (const connection of this.connections) {
      if (connection.subscriptions.has(slot)) writeWire(connection.socket, event);
    }
  }

  private async writeSlot(params: SessiondWriteParams): Promise<{ slot: number; acceptedBytes: number; backpressured: boolean }> {
    const entry = this.slots.get(params.slot);
    if (!entry) throw new SessiondError("slot_not_found", "write refused: slot does not exist");
    if (!entry.attached || !this.entryAlive(entry)) {
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
      if (data.toString("base64") !== params.dataBase64) throw new Error("invalid base64");
    } catch {
      throw new SessiondError("invalid_request", "write dataBase64 is invalid");
    }
    if (data.length > MAX_WRITE_BYTES) throw new SessiondError("invalid_request", "write exceeds the 8 MiB limit");
    const ok = await this.holderWrite(entry, data).catch(() => false);
    if (!ok) throw new SessiondError("write_failed", "write failed before bytes were accepted");
    entry.lastStdinAt = Date.now();
    return { slot: params.slot, acceptedBytes: data.length, backpressured: this.backpressured.has(params.slot) };
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
    if (signal !== "SIGKILL" && entry.link && !entry.link.destroyed) {
      // The holder passes it to the child and reports the exit.
      signalled = entry.link.write(holderMessage({ v: SLOT_HOLDER_PROTOCOL_VERSION, type: "signal", signal })) || true;
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

  private holderAlive(entry: SlotEntry): boolean {
    return !!entry.identity && sameIdentity(entry.identity, readSessiondProcessIdentity(entry.identity.pid));
  }

  private entryAlive(entry: SlotEntry): boolean {
    return !entry.exited && this.holderAlive(entry);
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

    const legacy: Array<{ entry: SlotEntry; identity: ProcessIdentity }> = [];
    const held: SlotEntry[] = [];
    for (const record of parsed.slots) {
      const entry: SlotEntry = {
        slot: record.slot,
        pid: record.pid,
        identity: record.identity,
        ...(record.socketPath ? { socketPath: record.socketPath } : {}),
        attached: false,
        ...(record.status !== "live" ? { exited: true } : {}),
        lastSeq: 0,
        replies: new Map(),
        lastStdoutAt: record.lastStdoutAt,
        lastStdinAt: record.lastStdinAt,
        exitCode: record.exitCode,
        signal: record.signal,
      };
      this.slots.set(entry.slot, entry);
      if (record.status !== "live") continue;
      if (!record.identity) {
        entry.orphanReason = "identity_unverifiable";
        entry.exited = true;
        continue;
      }
      const observed = readSessiondProcessIdentity(record.identity.pid);
      if (!observed || !sameIdentity(record.identity, observed)) {
        entry.orphanReason = observed ? "identity_mismatch" : "supervisor_restarted";
        if (observed) entry.pid = null;
        entry.exited = true;
        entry.exitCode = null;
        entry.signal = null;
      } else if (record.socketPath) {
        held.push(entry);
      } else {
        legacy.push({ entry, identity: record.identity });
      }
    }

    // #631: a slot holder outlived the previous sessiond. Reconnect and carry
    // on: the child, its stdio and its unread output are all still there.
    await Promise.all(held.map(async (entry) => {
      if (!await this.connectHolder(entry, 3_000)) entry.orphanReason = "supervisor_restarted";
    }));

    // Pre-holder children had their stdio in the old sessiond, so they lost
    // it when it exited and can do no further work. Their exact identity is
    // positive ownership evidence; only those process groups are reaped.
    const escalated = new Set<number>();
    for (const { identity } of legacy) {
      try { process.kill(-identity.pgid, "SIGTERM"); } catch { /* already gone */ }
    }
    await Promise.all(legacy.map(({ identity }) => waitUntilGone(identity, ORPHAN_TERM_GRACE_MS)));
    for (const { identity } of legacy) {
      if (!sameIdentity(identity, readSessiondProcessIdentity(identity.pid))) continue;
      try { process.kill(-identity.pgid, "SIGKILL"); } catch { /* already gone */ }
      escalated.add(identity.pid);
    }
    await Promise.all(legacy.map(({ identity }) => waitUntilGone(identity, ORPHAN_KILL_GRACE_MS)));
    for (const { entry, identity } of legacy) {
      entry.orphanReason = "supervisor_restarted";
      entry.exited = true;
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
          ...(entry.socketPath ? { socketPath: entry.socketPath } : {}),
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
