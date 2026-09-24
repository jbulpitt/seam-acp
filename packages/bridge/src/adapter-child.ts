#!/usr/bin/env node
/**
 * Adapter-aware child host for #574.
 *
 * sessiond remains an opaque descriptor owner. This process is what turns a
 * bridge slot configuration into an adapter process, then survives bridge
 * control-plane restarts while keeping that adapter's stdio open. Bootstrap
 * arrives on stdin (never argv or persisted state) because it may contain MCP
 * credentials and per-slot environment values.
 */
import type { ChildProcess } from "node:child_process";
import {
  unclassified,
} from "@seam/adapters";
import { createLineFramer } from "./output-log.js";
import { loadHostAdapterInventory } from "./inventory.js";
import { createRung1Recovery } from "./rung1-recovery.js";
import { spawnSupervisedAdapter } from "./spawn-agent.js";
import { spawnRefusalFrame } from "./resolve-adapter.js";
import { createResumeRecorder } from "./adapter-child-resume.js";
import {
  ADAPTER_CHILD_PROTOCOL_VERSION,
  adapterChildLine,
  type AdapterChildBootstrap,
  type AdapterChildInput,
  type AdapterChildResume,
  type AdapterChildOutput,
} from "./adapter-child-protocol.js";

const controlInput = createLineFramer();
const agentInput = createLineFramer();
const agentOutput = createLineFramer();
let child: ChildProcess | undefined;
let bootstrap: AdapterChildBootstrap | undefined;
let stopping = false;

function publish(message: AdapterChildOutput): void {
  process.stdout.write(adapterChildLine(message));
}

function fail(message: string): never {
  // Closed diagnostic only. Bootstrap, argv, paths, and raw spawn errors may
  // carry secrets and never cross fd 2 from this host.
  process.stderr.write(`[adapter-child] ${message}\n`);
  clearResumeRecord();
  process.exit(1);
}

function writeAgent(data: string | Buffer): boolean {
  if (!child?.stdin?.writable) return false;
  child.stdin.write(data);
  return true;
}

let refused = false;
/** Set once a resume record exists; a refusal or failure ends the work for good. */
let clearResumeRecord = (): void => {};
/** Stop this slot and send the reason to the controller as the exit frame's
 *  spawnError. A dropped input with no report surfaced only as a 45s
 *  "never responded" timeout (#609, #610). */
function exitWithRefusal(reason: string): void {
  if (refused) return;
  refused = true;
  clearResumeRecord();
  process.stdout.write(
    adapterChildLine({ v: ADAPTER_CHILD_PROTOCOL_VERSION, type: "refusal", reason }),
    () => process.exit(1),
  );
}

function start(config: AdapterChildBootstrap): void {
  const { adapters } = loadHostAdapterInventory(config.copilotCmd, { cwd: config.localCwd });
  let spawned: ChildProcess;
  try {
    spawned = spawnSupervisedAdapter(adapters, config.config);
  } catch (error) {
    const refusal = spawnRefusalFrame(error);
    process.stdout.write(adapterChildLine({
      v: ADAPTER_CHILD_PROTOCOL_VERSION,
      type: "spawn_refusal",
      spawnError: String(refusal.spawnError),
    }), () => process.exit(1));
    return;
  }
  child = spawned;
  const resumeRecord = createResumeRecorder(process.env.SEAM_SESSIOND_RESUME_FILE, config);
  clearResumeRecord = () => resumeRecord.clear();
  const recovery = createRung1Recovery({
    policyFor: () => config.config.rung1Recovery,
    classify: (_slot, error) => {
      const adapter = config.config.agentId ? adapters.get(config.config.agentId) : undefined;
      try {
        return (adapter?.classifyError?.(error) ?? unclassified(config.config.agentId ?? "unknown")).errorKind;
      } catch {
        return "unclassified";
      }
    },
    write: (_slot, line) => writeAgent(line),
    publishSnapshot: (_slot, snapshot) => publish({
      v: ADAPTER_CHILD_PROTOCOL_VERSION,
      type: "recovery",
      recovery: snapshot,
    }),
    publishResult: (_slot, result) => {
      publish({
        v: ADAPTER_CHILD_PROTOCOL_VERSION,
        type: "recovery_result",
        recoveryResult: result,
      });
      resumeRecord.clear();
    },
    // The durable output stream retains child-to-client requests while the
    // bridge is absent. The replacement controller can answer after replay.
    controllerConnected: () => true,
  });

  // #631: relaunched after a host restart. Bring the agent back to the same
  // session, then continue the interrupted turn under its original request id.
  let resuming: { resume: AdapterChildResume; phase: "initialize" | "load" } | undefined;
  const RESUME_INITIALIZE = "seam-resume-initialize";
  const RESUME_LOAD = "seam-resume-load";
  const resumeOutput = (line: string): boolean => {
    if (!resuming) return false;
    let message: { id?: unknown; method?: unknown; error?: { message?: unknown } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return false;
    }
    // session/load replays the conversation; the controller already has it.
    if (resuming.phase === "load" && message.method === "session/update") return true;
    if (resuming.phase === "initialize" && message.id === RESUME_INITIALIZE) {
      if (message.error) {
        exitWithRefusal(`resume after restart: initialize failed (${String(message.error.message ?? "error")})`);
        return true;
      }
      resuming.phase = "load";
      writeAgent(`${JSON.stringify({ jsonrpc: "2.0", id: RESUME_LOAD, method: "session/load", params: resuming.resume.load })}\n`);
      return true;
    }
    if (resuming.phase === "load" && message.id === RESUME_LOAD) {
      if (message.error) {
        exitWithRefusal(`resume after restart: session/load failed (${String(message.error.message ?? "error")})`);
        return true;
      }
      const { recovery: turn } = resuming.resume;
      resuming = undefined;
      process.stderr.write(`[adapter-child] resumed session ${turn.acpSessionId} after a restart; continuing the turn\n`);
      deliverInput(Buffer.from(`${JSON.stringify({
        jsonrpc: "2.0",
        id: turn.originalRequestId,
        method: "session/prompt",
        params: { sessionId: turn.acpSessionId, prompt: [{ type: "text", text: turn.continuation }] },
      })}\n`));
      return true;
    }
    return false;
  };

  child.stdout?.on("data", (chunk: Buffer | string) => {
    for (const line of agentOutput.push(chunk.toString())) {
      if (resumeOutput(line)) continue;
      const decision = recovery.observeOutput(config.slot, line);
      if (decision.forward !== null) publish({
        v: ADAPTER_CHILD_PROTOCOL_VERSION,
        type: "data",
        data: decision.forward,
      });
    }
  });
  child.stderr?.on("data", (chunk: Buffer | string) => process.stderr.write(chunk));
  child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
    exitWithRefusal(`agent stdin failed (${error.code ?? "write error"})`);
  });
  child.on("error", () => {
    recovery.childExited(config.slot);
    fail("adapter process emitted an error");
  });
  child.on("exit", (code, signal) => {
    const tail = agentOutput.flush();
    if (tail) {
      const decision = recovery.observeOutput(config.slot, tail);
      if (decision.forward !== null) publish({
        v: ADAPTER_CHILD_PROTOCOL_VERSION,
        type: "data",
        data: decision.forward,
      });
    }
    recovery.childExited(config.slot);
    // Ending on its own (not by a signal, as at shutdown) leaves nothing to resume.
    if (!signal) resumeRecord.clear();
    if (stopping) process.exit(0);
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 1);
  });

  const handle = (message: AdapterChildInput): void => {
    if (refused) return;
    if (message.v !== ADAPTER_CHILD_PROTOCOL_VERSION) {
      exitWithRefusal(`unsupported control protocol version ${String(message.v)}`);
      return;
    }
    if (message.type === "input") {
      deliverInput(Buffer.from(message.dataBase64, "base64"));
    } else if (message.type === "arm_recovery") {
      try {
        publish({
          v: ADAPTER_CHILD_PROTOCOL_VERSION,
          type: "control_result",
          requestId: message.requestId,
          ok: true,
          result: recovery.arm(config.slot, message),
        });
      } catch (error) {
        publish({
          v: ADAPTER_CHILD_PROTOCOL_VERSION,
          type: "control_result",
          requestId: message.requestId,
          ok: false,
          error: error instanceof Error ? error.message : "recovery arm failed",
        });
      }
    } else if (message.type === "report_recovery") {
      const snapshot = recovery.snapshot(config.slot);
      if (snapshot) publish({ v: ADAPTER_CHILD_PROTOCOL_VERSION, type: "recovery", recovery: snapshot });
      const result = recovery.terminalResult(config.slot);
      if (result) publish({ v: ADAPTER_CHILD_PROTOCOL_VERSION, type: "recovery_result", recoveryResult: result });
    } else if (message.type === "disarm_recovery") {
      publish({
        v: ADAPTER_CHILD_PROTOCOL_VERSION,
        type: "control_result",
        requestId: message.requestId,
        ok: true,
        result: { disarmed: recovery.disarm(config.slot, message.submissionId) },
      });
    }
  };
  function deliverInput(bytes: Buffer): void {
    recovery.observeInputBytes(config.slot);
    for (const line of agentInput.push(bytes.toString())) {
      recovery.observeInput(config.slot, line);
      resumeRecord.observeInput(line);
      resumeRecord.record(recovery.resumable(config.slot));
    }
    if (!writeAgent(bytes)) exitWithRefusal("agent stdin is closed; input could not be delivered");
  }

  consume = handle;
  if (config.resume) {
    // Re-arm first: the controller sees this slot owns the turn while the
    // session reloads, and does not start a second continuation.
    recovery.arm(config.slot, {
      submissionId: config.resume.recovery.submissionId,
      acpSessionId: config.resume.recovery.acpSessionId,
      continuation: config.resume.recovery.continuation,
    });
    resuming = { resume: config.resume, phase: "initialize" };
    writeAgent(`${JSON.stringify({ jsonrpc: "2.0", id: RESUME_INITIALIZE, method: "initialize", params: config.resume.initialize })}\n`);
  }
}

let consume = (message: AdapterChildInput): void => {
  if (message.type !== "bootstrap" || bootstrap) fail("invalid bootstrap");
  bootstrap = message;
  start(message);
};

process.stdin.on("data", (chunk: Buffer | string) => {
  for (const line of controlInput.push(chunk.toString())) {
    let message: AdapterChildInput;
    try {
      message = JSON.parse(line) as AdapterChildInput;
    } catch {
      fail("invalid control frame");
    }
    consume(message);
  }
});
process.stdin.on("end", () => {
  if (!stopping) child?.kill("SIGTERM");
});

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  if (!child || child.exitCode !== null || child.signalCode !== null) process.exit(0);
  child.kill(signal);
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
