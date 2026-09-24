#!/usr/bin/env node
/**
 * One process per slot that owns the slot's child and its stdio (#631).
 *
 * sessiond used to hold every child's pipes itself, so a sessiond restart
 * closed them and ended every running turn on the host. The holder owns the
 * pipes instead, numbers and keeps the child's output until it is read, and
 * listens on a private socket. A restarted sessiond reconnects and carries on.
 *
 * It knows nothing about ACP or adapters: it moves bytes and reports facts.
 * The launch (which may carry credentials) arrives over the socket, never argv.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { createLineFramer } from "./output-log.js";
import {
  SLOT_HOLDER_PROTOCOL_VERSION,
  type SlotHolderFrame,
  type SlotHolderInput,
  type SlotHolderOutput,
} from "./slot-holder-protocol.js";

const socketPath = process.argv[2];
if (!socketPath) process.exit(2);

/** Unread output is kept up to this size, oldest dropped first. */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
/** After the child exits, stay reachable this long for sessiond to collect the exit. */
const EXIT_LINGER_MS = 60_000;

let child: ChildProcessWithoutNullStreams | undefined;
let seq = 0;
let buffered: Array<{ frame: SlotHolderFrame; bytes: number }> = [];
let bufferedBytes = 0;
let connection: net.Socket | undefined;
let exitSeq: number | undefined;
let lingerTimer: ReturnType<typeof setTimeout> | undefined;
const stdoutFramer = createLineFramer();

function send(socket: net.Socket | undefined, message: SlotHolderOutput): boolean {
  if (!socket || socket.destroyed || !socket.writable) return false;
  return socket.write(`${JSON.stringify(message)}\n`);
}

function emit(frame: Omit<SlotHolderFrame, "seq" | "at">): void {
  const full = { ...frame, seq: ++seq, at: Date.now() } as SlotHolderFrame;
  const bytes = (full.dataBase64?.length ?? 0) + 64;
  buffered.push({ frame: full, bytes });
  bufferedBytes += bytes;
  while (bufferedBytes > MAX_BUFFER_BYTES && buffered.length > 1) {
    bufferedBytes -= buffered.shift()!.bytes;
  }
  send(connection, { v: SLOT_HOLDER_PROTOCOL_VERSION, type: "frame", frame: full });
}

function ack(throughSeq: number): void {
  while (buffered.length && buffered[0]!.frame.seq <= throughSeq) bufferedBytes -= buffered.shift()!.bytes;
  if (exitSeq !== undefined && throughSeq >= exitSeq) finish();
}

function finish(): void {
  try { fs.unlinkSync(socketPath!); } catch { /* already gone */ }
  process.exit(0);
}

function startChild(message: Extract<SlotHolderInput, { type: "spawn" }>, socket: net.Socket): void {
  if (child) {
    send(socket, { v: SLOT_HOLDER_PROTOCOL_VERSION, type: "spawn_result", ok: false, code: "EEXIST" });
    return;
  }
  if (message.firstSeq && message.firstSeq > seq) seq = message.firstSeq - 1;
  let spawned: ChildProcessWithoutNullStreams;
  try {
    spawned = spawn(message.executable, message.args ?? [], {
      cwd: message.cwd,
      env: message.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    send(socket, { v: SLOT_HOLDER_PROTOCOL_VERSION, type: "spawn_result", ok: false,
      code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN" });
    return;
  }
  spawned.on("error", (error: NodeJS.ErrnoException) => {
    if (spawned.pid) return;
    send(connection, { v: SLOT_HOLDER_PROTOCOL_VERSION, type: "spawn_result", ok: false, code: error.code ?? "UNKNOWN" });
    setTimeout(finish, 1_000).unref();
  });
  spawned.once("spawn", () => {
    child = spawned;
    send(connection, { v: SLOT_HOLDER_PROTOCOL_VERSION, type: "spawn_result", ok: true, pid: spawned.pid! });
  });
  spawned.stdout.on("data", (chunk: Buffer) => {
    for (const line of stdoutFramer.push(chunk.toString())) {
      emit({ stream: "stdout", dataBase64: Buffer.from(line).toString("base64") });
    }
  });
  spawned.stderr.on("data", (chunk: Buffer) => emit({ stream: "stderr", dataBase64: chunk.toString("base64") }));
  spawned.stdin.on("error", () => undefined);
  spawned.on("exit", (code, signal) => {
    const tail = stdoutFramer.flush();
    if (tail) emit({ stream: "stdout", dataBase64: Buffer.from(tail).toString("base64") });
    emit({ stream: "exit", code, signal });
    exitSeq = seq;
    lingerTimer = setTimeout(finish, EXIT_LINGER_MS);
  });
}

function handle(socket: net.Socket, message: SlotHolderInput): void {
  if (message.type === "hello") {
    // A (re)connecting sessiond. It replaces any earlier connection and gets
    // every retained frame after its cursor, then the live stream.
    if (connection && connection !== socket) connection.destroy();
    connection = socket;
    send(socket, { v: SLOT_HOLDER_PROTOCOL_VERSION, type: "hello_ack",
      ...(child?.pid ? { pid: child.pid } : {}), ...(exitSeq !== undefined ? { exited: true } : {}) });
    for (const { frame } of buffered) {
      if (frame.seq > message.afterSeq) send(socket, { v: SLOT_HOLDER_PROTOCOL_VERSION, type: "frame", frame });
    }
    if (exitSeq !== undefined && lingerTimer) {
      // sessiond has now seen the exit; keep a short window for its consumer.
      clearTimeout(lingerTimer);
      lingerTimer = setTimeout(finish, EXIT_LINGER_MS);
    }
  } else if (message.type === "spawn") {
    startChild(message, socket);
  } else if (message.type === "write") {
    const data = Buffer.from(message.dataBase64, "base64");
    const ok = !!child && child.exitCode === null && child.signalCode === null && child.stdin.writable;
    if (ok) child!.stdin.write(data);
    send(socket, { v: SLOT_HOLDER_PROTOCOL_VERSION, type: "write_result", id: message.id, ok });
  } else if (message.type === "ack") {
    ack(message.throughSeq);
  } else if (message.type === "signal") {
    if (child && child.exitCode === null && child.signalCode === null) child.kill(message.signal);
  }
}

try { fs.unlinkSync(socketPath); } catch { /* none */ }
const server = net.createServer((socket) => {
  let input = "";
  socket.on("data", (chunk: Buffer) => {
    input += chunk.toString();
    let newline: number;
    while ((newline = input.indexOf("\n")) !== -1) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      let message: SlotHolderInput;
      try {
        message = JSON.parse(line) as SlotHolderInput;
      } catch {
        socket.destroy();
        return;
      }
      if (message.v !== SLOT_HOLDER_PROTOCOL_VERSION) {
        socket.destroy();
        return;
      }
      handle(socket, message);
    }
  });
  socket.on("error", () => undefined);
  socket.on("close", () => {
    // sessiond went away. The child keeps running; the next sessiond reconnects.
    if (connection === socket) connection = undefined;
  });
});
server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o600);
});
// sessiond sends the launch right after starting this holder. If it never
// arrives (sessiond died in between), there is nothing to hold.
setTimeout(() => { if (!child) finish(); }, 60_000).unref();

// sessiond's own stop signals never reach here (separate process group). A
// SIGTERM to the holder is an explicit stop of this slot: pass it to the child.
process.on("SIGTERM", () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  else finish();
});
