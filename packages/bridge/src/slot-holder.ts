#!/usr/bin/env node
/**
 * Own the child's stdio so it survives sessiond restarts.
 * Launch data may contain credentials and arrives over the socket, not argv.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import type { Readable } from "node:stream";
import { terminateProcessGroup, type ProcessGroupOwnership, type ProcessIdentity } from "@seam/adapters/process-group";
import { createLineFramer } from "./output-log.js";
import { createNdjsonReader } from "./ndjson-reader.js";
import {
  SLOT_HOLDER_PROTOCOL_VERSION,
  type SlotHolderFrame,
  type SlotHolderInput,
  type SlotHolderOutput,
} from "./slot-holder-protocol.js";

const socketPath = process.argv[2];
if (!socketPath) process.exit(2);

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
const groups = new Map<number, ProcessIdentity>();
let finalizing: Promise<void> | undefined;

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
      env: { ...message.env, SEAM_SLOT_GROUP_FD: "3" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
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
  const ownershipPipe = spawned.stdio[3] as Readable;
  const ownershipReader = createNdjsonReader(line => {
    const message = JSON.parse(line.toString("utf8")) as ProcessGroupOwnership;
    if (message.type === "own_group") groups.set(message.identity.pgid, message.identity);
    else if (message.type === "release_group" && groups.get(message.identity.pgid)?.started === message.identity.started) {
      groups.delete(message.identity.pgid);
    }
  }, MAX_BUFFER_BYTES);
  const ownershipDrained = new Promise<void>(resolve => ownershipPipe.once("end", resolve));
  ownershipPipe.on("data", (chunk: Buffer) => ownershipReader.push(chunk));
  spawned.on("exit", (code, signal) => {
    finalizing ??= (async () => {
      // Registration bytes can still be buffered when the direct child exits.
      await ownershipDrained;
      for (const identity of groups.values()) {
        for (;;) {
          try {
            if (await terminateProcessGroup(identity, 1_000)) break;
            process.stderr.write(`[slot-holder] process group ${identity.pgid} has not stopped after SIGKILL; waiting before reporting exit\n`);
          } catch (error) {
            process.stderr.write(`[slot-holder] process group ${identity.pgid} cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
          }
          await new Promise(resolve => setTimeout(resolve, 1_000));
        }
      }
      groups.clear();
      const tail = stdoutFramer.flush();
      if (tail) emit({ stream: "stdout", dataBase64: Buffer.from(tail).toString("base64") });
      emit({ stream: "exit", code, signal });
      exitSeq = seq;
      lingerTimer = setTimeout(finish, EXIT_LINGER_MS);
    })().catch(error => {
      process.stderr.write(`[slot-holder] native group cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  });
}

function handle(socket: net.Socket, message: SlotHolderInput): void {
  if (message.type === "hello") {
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
  const reader = createNdjsonReader((line) => {
    let message: SlotHolderInput;
    try {
      message = JSON.parse(line.toString("utf8")) as SlotHolderInput;
    } catch {
      socket.destroy();
      return;
    }
    if (message.v !== SLOT_HOLDER_PROTOCOL_VERSION) {
      socket.destroy();
      return;
    }
    handle(socket, message);
  }, 512 * 1024 * 1024);
  socket.on("data", (chunk: Buffer) => {
    if (!reader.push(chunk)) socket.destroy();
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
// A holder with no launch has no child to preserve.
setTimeout(() => { if (!child) finish(); }, 60_000).unref();

// The holder has its own process group; SIGTERM here explicitly stops its slot.
process.on("SIGTERM", () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  else if (!finalizing || exitSeq !== undefined) finish();
});
