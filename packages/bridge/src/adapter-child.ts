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
import {
  ADAPTER_CHILD_PROTOCOL_VERSION,
  adapterChildLine,
  type AdapterChildBootstrap,
  type AdapterChildInput,
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
  process.exit(1);
}

function writeAgent(data: string | Buffer): boolean {
  if (!child?.stdin?.writable) return false;
  child.stdin.write(data);
  return true;
}

let refused = false;
/** Stop this slot and send the reason to the controller as the exit frame's
 *  spawnError. A dropped input with no report surfaced only as a 45s
 *  "never responded" timeout (#609, #610). */
function exitWithRefusal(reason: string): void {
  if (refused) return;
  refused = true;
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
    publishResult: (_slot, result) => publish({
      v: ADAPTER_CHILD_PROTOCOL_VERSION,
      type: "recovery_result",
      recoveryResult: result,
    }),
    // The durable output stream retains child-to-client requests while the
    // bridge is absent. The replacement controller can answer after replay.
    controllerConnected: () => true,
  });

  child.stdout?.on("data", (chunk: Buffer | string) => {
    for (const line of agentOutput.push(chunk.toString())) {
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
      const bytes = Buffer.from(message.dataBase64, "base64");
      recovery.observeInputBytes(config.slot);
      for (const line of agentInput.push(bytes.toString())) recovery.observeInput(config.slot, line);
      if (!writeAgent(bytes)) exitWithRefusal("agent stdin is closed; input could not be delivered");
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
  consume = handle;
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
