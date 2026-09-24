/**
 * #606 — a dead sessiond slot must never swallow a new turn.
 *
 * sessiond keeps entries for exited children, and slot numbers restart near
 * zero on every bridge connection. After a bridge-only restart, `rebind()`
 * bound those dead entries as though they were live, `ensure()` returned them
 * without spawning, the write hit a process that no longer existed, and
 * `writeInput` resolved `false` — which the bridge never read. The controller
 * waited out its 45s ACP-initialize timeout and blamed installation and
 * authentication. Every local turn failed that way for ~45 minutes, twice.
 *
 * These drive a real SessiondServer and real OS children, because the defect
 * lived in the seam between the bridge's bindings and sessiond's slot table.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessiondClient } from "../packages/bridge/src/sessiond-client.js";
import { SessiondServer } from "../packages/bridge/src/sessiond-server.js";
import {
  SupervisedSlots,
  forwardInput,
  type SupervisedBridgeFrame,
} from "../packages/bridge/src/supervised-slots.js";

const roots: string[] = [];
const servers: SessiondServer[] = [];
const clients: SessiondClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close({ terminateChildren: true });
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Echoes each input line as a data frame; exits cleanly on "exit-now".
const CHILD = `
  let buffered = "";
  const send = (value) => process.stdout.write(JSON.stringify({ v: 1, ...value }) + "\\n");
  process.stdin.on("data", (chunk) => {
    buffered += chunk.toString();
    let newline;
    while ((newline = buffered.indexOf("\\n")) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const frame = JSON.parse(line);
      if (frame.type === "report_recovery") {
        send({ type: "recovery", recovery: { submissionId: "sub-r", acpSessionId: "acp-r", phase: "executing" } });
        continue;
      }
      if (frame.type !== "input") continue;
      const text = Buffer.from(frame.dataBase64, "base64").toString();
      if (text.includes("exit-now")) process.exit(0);
      if (text.includes("recover-now")) {
        send({ type: "recovery", recovery: { submissionId: "sub-1", acpSessionId: "acp-1", phase: "executing" } });
        continue;
      }
      send({ type: "data", data: "echo:" + text });
    }
  });
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000);
`;

async function sessiond() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-606-"));
  roots.push(root);
  await fs.chmod(root, 0o700);
  const socketPath = path.join(root, "sessiond.sock");
  const childPath = path.join(root, "child.mjs");
  await fs.writeFile(childPath, CHILD, { mode: 0o700 });
  const server = new SessiondServer({ socketPath, statePath: path.join(root, "slots.json") });
  servers.push(server);
  await server.start();
  return { socketPath, childPath };
}

async function bridge(socketPath: string, childPath: string) {
  const client = await SessiondClient.connect(socketPath);
  clients.push(client);
  const frames: Array<SupervisedBridgeFrame & { slot: number }> = [];
  const slots = new SupervisedSlots({
    client,
    copilotCmd: "/unused/copilot",
    localCwd: process.cwd(),
    adapterChildPath: childPath,
    onStderr: () => undefined,
    onFrame: (frame) => frames.push(frame),
  });
  return { client, slots, frames };
}

async function health(client: SessiondClient, slot: number) {
  const listed = await client.listSlots();
  return listed.health.find((entry) => entry.slot === slot);
}

async function until(check: () => Promise<boolean> | boolean, what: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("#631 a killed slot has no recovery to adopt", () => {
  it("stops reporting the recovery once the slot is killed", async () => {
    const { socketPath, childPath } = await sessiond();
    const only = await bridge(socketPath, childPath);
    only.slots.configure(9, { agentId: "fixture" });
    await expect(only.slots.writeInput(9, "recover-now\n")).resolves.toBe(true);
    const recoveryOf = async () => (await only.slots.listSlots()).health
      .find((entry) => entry.slot === 9) as { recovery?: unknown } | undefined;
    await until(async () => (await recoveryOf())?.recovery !== undefined, "the recovery snapshot");
    await only.slots.kill(9);
    expect((await recoveryOf())?.recovery).toBeUndefined();
  });
});

describe("#631 a restarted bridge recovers live slots' recovery records", () => {
  it("asks each live child for its current recovery state", async () => {
    const { socketPath, childPath } = await sessiond();
    const first = await bridge(socketPath, childPath);
    first.slots.configure(11, { agentId: "fixture" });
    await expect(first.slots.writeInput(11, "hello\n")).resolves.toBe(true);
    first.client.close();

    const second = await bridge(socketPath, childPath);
    await second.slots.rebind();
    const row = (await second.slots.listSlots()).health.find((entry) => entry.slot === 11) as { recovery?: unknown };
    expect(row.recovery).toMatchObject({ submissionId: "sub-r" });
  });
});

describe("#606 dead sessiond slots", () => {
  it("spawns a fresh child when a restarted bridge reuses a dead slot number", async () => {
    const { socketPath, childPath } = await sessiond();

    // Bridge A: a turn on slot 7 runs and its child exits normally.
    const first = await bridge(socketPath, childPath);
    first.slots.configure(7, { agentId: "fixture" });
    await expect(first.slots.writeInput(7, "hello\n")).resolves.toBe(true);
    const firstPid = (await health(first.client, 7))?.pid;
    expect(firstPid).toBeTypeOf("number");
    await first.slots.writeInput(7, "exit-now\n");
    await until(async () => (await health(first.client, 7))?.alive === false, "slot 7 to die");

    // Bridge-only restart: sessiond keeps its dead entry for slot 7.
    first.client.close();
    const second = await bridge(socketPath, childPath);
    await second.slots.rebind();
    expect((await health(second.client, 7))?.alive).toBe(false);

    // The first turn on the restarted bridge lands on the same slot number.
    second.slots.configure(7, { agentId: "fixture" });
    await expect(second.slots.writeInput(7, "after-restart\n")).resolves.toBe(true);

    const replaced = await health(second.client, 7);
    expect(replaced?.alive).toBe(true);
    expect(replaced?.pid).not.toBe(firstPid);
    await until(
      () => second.frames.some((frame) => frame.data === "echo:after-restart\n"),
      "the new child to answer",
    );
  });

  it("never resurrects a dead child for continuation input, but spawns for a new configure", async () => {
    const { socketPath, childPath } = await sessiond();
    const only = await bridge(socketPath, childPath);
    only.slots.configure(3, { agentId: "fixture" });
    await expect(only.slots.writeInput(3, "one\n")).resolves.toBe(true);
    const firstPid = (await health(only.client, 3))?.pid;
    await only.slots.writeInput(3, "exit-now\n");
    await until(() => only.frames.some((frame) => frame.slot === 3 && frame.type === "exit"), "the exit frame");

    // Continuation input for the dead child: undeliverable, reported, and no
    // blank child is spawned to receive mid-session frames (#574).
    const reported: Array<[number, string]> = [];
    await forwardInput(only.slots, 3, "continuation\n", (slot, reason) => reported.push([slot, reason]));
    // The report names why, not just that it failed.
    expect(reported).toEqual([[3, "the slot's process has already exited"]]);
    expect((await health(only.client, 3))?.alive).toBe(false);

    // A new runtime configures the slot first (`rpc("spawn")`), then writes.
    only.slots.configure(3, { agentId: "fixture" });
    await expect(only.slots.writeInput(3, "two\n")).resolves.toBe(true);
    const replaced = await health(only.client, 3);
    expect(replaced?.alive).toBe(true);
    expect(replaced?.pid).not.toBe(firstPid);
    await until(() => only.frames.some((frame) => frame.data === "echo:two\n"), "the new child to answer");
  });
});

describe("#606 forwardInput reports undeliverable input", () => {
  it("reports a resolved false — the case the bridge used to drop", async () => {
    const reported: number[] = [];
    await forwardInput({ writeInput: async () => false }, 4, "x", (slot) => reported.push(slot));
    expect(reported).toEqual([4]);
  });

  it("reports a rejection", async () => {
    const reported: number[] = [];
    await forwardInput(
      { writeInput: async () => { throw new Error("spawn refused"); } },
      5,
      "x",
      (slot) => reported.push(slot),
    );
    expect(reported).toEqual([5]);
  });

  it("stays silent when the input landed", async () => {
    const reported: number[] = [];
    await forwardInput({ writeInput: async () => true }, 6, "x", (slot) => reported.push(slot));
    expect(reported).toEqual([]);
  });
});
