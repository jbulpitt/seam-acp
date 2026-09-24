/**
 * #610 — the local agent path end to end, with no stand-in for adapter-child.
 *
 * Every agy turn timed out for hours on 2026-09-23 while the suite was green:
 * no test ran SupervisedSlots → sessiond → adapter-child → the agy profile.
 * These do, with a real SessiondServer, the real adapter-child.ts, the
 * unpinned agy runtime production uses, and a stub `agy` on PATH (only its
 * `--version` is ever called before a prompt).
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adapterChildLine } from "../packages/bridge/src/adapter-child-protocol.js";
import { SessiondClient } from "../packages/bridge/src/sessiond-client.js";
import { SessiondServer } from "../packages/bridge/src/sessiond-server.js";
import { SupervisedSlots, type SupervisedBridgeFrame } from "../packages/bridge/src/supervised-slots.js";

const adapterChild = path.join(path.dirname(fileURLToPath(import.meta.url)), "helpers/adapter-child-source.mjs");
const roots: string[] = [];
const servers: SessiondServer[] = [];
const clients: SessiondClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close({ terminateChildren: true });
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function until<T>(read: () => T | undefined, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function localBridge() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-610-"));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  await fs.mkdir(bin);
  await fs.mkdir(home);
  await fs.writeFile(path.join(bin, "agy"), "#!/bin/sh\necho 1.2.9\n", { mode: 0o755 });

  const socketPath = path.join(root, "sessiond.sock");
  const server = new SessiondServer({ socketPath, statePath: path.join(root, "slots.json") });
  servers.push(server);
  await server.start();
  const client = await SessiondClient.connect(socketPath);
  clients.push(client);

  const frames: Array<SupervisedBridgeFrame & { slot: number }> = [];
  const slots = new SupervisedSlots({
    client,
    copilotCmd: "/unused/copilot",
    localCwd: root,
    adapterChildPath: adapterChild,
    environment: {
      HOME: home,
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      AGY_ENABLED: "true",
      AGY_PIN: "unpinned",
      AGY_DEFAULT_MODEL: "gemini-3.8-flash-high",
    },
    onStderr: () => undefined,
    onFrame: (frame) => frames.push(frame),
  });
  return { root, client, slots, frames };
}

const initialize = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
})}\n`;

describe("#610 the local agent path, end to end", () => {
  it("delivers agy's initialize through sessiond and the real adapter-child", async () => {
    const { root, slots, frames } = await localBridge();
    slots.configure(1, { agentId: "agy", model: "gemini-3.8-flash-high", cwd: root });

    await expect(slots.writeInput(1, initialize)).resolves.toBe(true);

    const first = await until(
      () => frames.find((frame) => frame.slot === 1 && (frame.type === "data" || frame.type === "exit")),
      "agy's initialize reply or exit",
    );
    expect(first).toMatchObject({ type: "data" });
    expect(JSON.parse(first.data ?? "")).toMatchObject({ jsonrpc: "2.0", id: 0, result: { protocolVersion: 1 } });
  }, 30_000);

  it("stops a slot that cannot take input, and says why", async () => {
    const { root, client, slots, frames } = await localBridge();
    slots.configure(2, { agentId: "agy", model: "gemini-3.8-flash-high", cwd: root });
    await slots.writeInput(2, initialize);
    await until(() => frames.find((frame) => frame.slot === 2 && frame.type === "data"), "the slot to start");

    // A control frame this wrapper cannot understand used to be dropped with
    // no frame at all, leaving the controller to wait out its timeout.
    await client.write(2, adapterChildLine({ v: 2, type: "input", dataBase64: "" } as never));

    const exit = await until(
      () => frames.find((frame) => frame.slot === 2 && frame.type === "exit"),
      "a named exit",
    );
    expect(exit).toMatchObject({ code: 1, spawnError: "unsupported control protocol version 2" });
  }, 30_000);
});
