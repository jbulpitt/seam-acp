/**
 * #436 — the production BridgeHub must audit the reason before its mux turns
 * a liveness decision into an abnormal WebSocket close.
 *
 * This drives BridgeHub's real `ensureMux` construction site. Calling a test
 * callback directly would leave the original bug (the hook unwired in
 * production) green.
 */
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { BridgeHub } from "../packages/core/src/core/bridge-hub.js";
import type { Config } from "../packages/core/src/config.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

class SilentSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  readonly send = vi.fn();
  readonly ping = vi.fn();
  readonly terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  });
}

let server: Server | undefined;
let hub: BridgeHub | undefined;

afterEach(async () => {
  vi.useRealTimers();
  hub?.close();
  hub = undefined;
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("bridge liveness audit", () => {
  it("records bridge identity and measured probe silence on the production hook", async () => {
    const warn = vi.fn();
    const logger = {
      child: () => logger,
      warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as Logger;

    server = createServer();
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    hub = new BridgeHub({
      logger,
      config: { bridgePresets: new Map() } as Config,
      httpServer: server,
      mutation: {} as never,
      healthPort: 3000,
      dataDir: "/tmp",
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    const socket = new SilentSocket();
    const mux = (hub as unknown as {
      ensureMux(bridgeId: string): { attach(ws: WebSocket): void };
    }).ensureMux("audit-bridge");
    mux.attach(socket as unknown as WebSocket);

    // Production constants: probe after 35s silence, terminate after another
    // 10s without a pong. Advancing to 45s drives the actual monitor exactly.
    await vi.advanceTimersByTimeAsync(45_000);

    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      {
        bridgeId: "audit-bridge",
        observedSilenceMs: 45_000,
        unansweredProbeMs: 10_000,
      },
      "bridge liveness terminated socket after unanswered probe"
    );
  });
});
