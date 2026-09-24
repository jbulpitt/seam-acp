/**
 * #610 — a bridge-reported exit before initialize reaches the operator as the
 * bridge's reason, promptly, instead of the 45s "never responded" timeout.
 *
 * Three hops dropped it: the mux read only code/signal/hostOom from the exit
 * frame, and the runtime's "exited before initialize" branch keyed on
 * `this.connection`, which is assigned before any exit can be observed. This
 * drives the real mux and the real AgentRuntime.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { makeMux, type AgentProfile } from "@seam/adapters";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

class FakeWs extends EventEmitter {
  readyState = 1;
  send(): void {}
  close(): void {}
  ping(): void {}
  terminate(): void {}
  deliver(msg: Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }
}

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), child() { return this; } };

function remoteRuntime() {
  const ws = new FakeWs();
  const mux = makeMux({ id: "laptop" } as never);
  mux.attach(ws as never);
  let child: ReturnType<typeof mux.spawn> | undefined;
  const runtime = new AgentRuntime({
    profile: { id: "agy" } as unknown as AgentProfile,
    logger: logger as unknown as Logger,
    spawnFn: () => {
      child = mux.spawn();
      return child;
    },
  });
  return { ws, runtime, child: () => child! };
}

describe("#610 remote start failure cause", () => {
  it("rejects start with the bridge's reason and stderr, not the 45s timeout", async () => {
    const { ws, runtime, child } = remoteRuntime();
    const started = Date.now();
    const failure = runtime.start().catch((error: unknown) => error as Error);
    await new Promise((resolve) => setImmediate(resolve));

    ws.deliver({
      slot: child().slot,
      type: "exit",
      code: 1,
      spawnError: "agent stdin is closed; input could not be delivered",
      stderrTail: "adapter-child: last words",
    });

    const error = await failure;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(error.message).toContain(
      "remote agent supervisor exited before initialize on host 'laptop' (code=1, signal=null): "
      + "agent stdin is closed; input could not be delivered",
    );
    expect(error.message).toContain("adapter-child: last words");
    expect(error.message).not.toContain("neither answered nor exited");
  });

  it("gives the remote child a live ChildProcess exit state", async () => {
    const { ws, runtime, child } = remoteRuntime();
    const failure = runtime.start().catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    expect(child().exitCode).toBeNull();
    expect(child().signalCode).toBeNull();
    expect(child().killed).toBe(false);

    ws.deliver({ slot: child().slot, type: "exit", code: 3, signal: "SIGTERM" });
    await failure;
    expect(child().exitCode).toBe(3);
    expect(child().signalCode).toBe("SIGTERM");
    // As in Node, `killed` means kill() was called, not that the process exited.
    expect(child().killed).toBe(false);
  });

  it("reports killed after kill(), not the value frozen at construction", async () => {
    const { runtime, child } = remoteRuntime();
    const failure = runtime.start().catch(() => undefined);
    await new Promise((resolve) => setImmediate(resolve));
    child().kill();
    expect(child().killed).toBe(true);
    await runtime.dispose();
    await failure;
  });
});
