import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessiondClient } from "../packages/bridge/src/sessiond-client.js";
import { readSessiondProcessIdentity, SessiondServer } from "../packages/bridge/src/sessiond-server.js";
import { SupervisedSlots, type SupervisedBridgeFrame } from "../packages/bridge/src/supervised-slots.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cleanups: Array<() => Promise<void>> = [];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Tree { wrapper: number; native: number; tool: number }

async function until<T>(read: () => T | undefined | Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-native-tree-"));
  const trees: Tree[] = [];
  const server = new SessiondServer({ socketPath: path.join(root, "control.sock"),
    statePath: path.join(root, "slots.json"), resumeDir: path.join(root, "resume") });
  let client: SessiondClient | undefined;
  cleanups.push(async () => {
    // Main deliberately leaves these groups alive. Reclaim only recorded fixture groups.
    for (const tree of trees) {
      const member = [tree.wrapper, tree.native, tree.tool]
        .map(pid => readSessiondProcessIdentity(pid)).find(identity => identity?.pgid === tree.wrapper);
      if (member) process.kill(-tree.wrapper, "SIGKILL");
    }
    await until(() => trees.every(tree => [tree.wrapper, tree.native, tree.tool]
      .every(pid => !readSessiondProcessIdentity(pid))) ? true : undefined, "fixture groups to stop");
    client?.close();
    await server.close({ terminateChildren: true });
    await fs.rm(root, { recursive: true, force: true });
  });
  const executable = path.join(root, "claude-agent-acp");
  await fs.writeFile(executable,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(here, "fixtures/native-tree-agent.mjs"))}\n`,
    { mode: 0o755 });
  await server.start();
  client = await SessiondClient.connect(path.join(root, "control.sock"));
  const frames: Array<SupervisedBridgeFrame & { slot: number }> = [];
  const slots = new SupervisedSlots({ client, localCwd: root, copilotCmd: "/unused/copilot",
    adapterChildPath: path.join(here, "helpers/adapter-child-source.mjs"),
    environment: { HOME: root, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      CLAUDE_CLI_PATH: executable, CLAUDE_CONFIG_DIR: path.join(root, "claude"),
      COPILOT_ENABLED: "false", AGY_ENABLED: "false", SEAM_NATIVE_TREE_FIXTURE: root },
    onFrame: frame => frames.push(frame), onStderr: () => {} });
  async function start(slot: number) {
    slots.configure(slot, { agentId: "claude", cwd: root, env: { SEAM_NATIVE_TREE_SLOT: String(slot) } });
    const response = (id: string) => until(() => frames.flatMap(frame => {
      if (frame.slot !== slot || frame.type !== "data") return [];
      return (frame.data ?? "").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    }).find(message => message.id === id), `slot ${slot} response ${id}`);
    const send = (id: string, method: string, params: object) =>
      slots.writeInput(slot, `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    await send(`${slot}-init`, "initialize", { protocolVersion: 1, clientCapabilities: {} });
    await response(`${slot}-init`);
    await send(`${slot}-new`, "session/new", { cwd: root, mcpServers: [] });
    await response(`${slot}-new`);
    await send(`${slot}-prompt`, "session/prompt", { sessionId: "native-tree-session", prompt: [{ type: "text", text: "hold" }] });
    const tree = await until(async () => {
      try { return JSON.parse(await fs.readFile(path.join(root, `${slot}.json`), "utf8")) as Tree; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    }, `slot ${slot} native/tool PIDs`);
    trees.push(tree);
    const health = (await client!.listSlots()).health.find(health => health.slot === slot)!;
    return { tree, adapterPid: health.pid! };
  }
  return { root, client, server, slots, frames, start };
}

describe("dead ACP wrapper process ownership", () => {
  it.each(["wrapper", "adapter-child"] as const)("stops native/tool descendants after %s death before reporting exit, without touching another slot", async target => {
    const { client, frames, start } = await fixture();
    const first = await start(8911);
    const control = await start(8912);
    expect(readSessiondProcessIdentity(first.tree.native)?.pgid).toBe(first.tree.wrapper);
    expect(readSessiondProcessIdentity(first.tree.tool)?.pgid).toBe(first.tree.wrapper);
    expect(first.adapterPid).not.toBe(first.tree.wrapper);
    process.kill(target === "wrapper" ? first.tree.wrapper : first.adapterPid, "SIGKILL");
    await until(() => frames.find(frame => frame.slot === 8911 && frame.type === "exit"), "slot exit");
    expect((await client!.listSlots()).health.find(health => health.slot === 8911)?.alive).toBe(false);
    expect((await client!.listSlots()).health.find(health => health.slot === 8912)?.alive).toBe(true);
    for (const pid of [control.adapterPid, control.tree.wrapper, control.tree.native, control.tree.tool]) {
      expect(readSessiondProcessIdentity(pid), `control PID ${pid} must remain running`).toBeDefined();
    }
    expect(readSessiondProcessIdentity(first.tree.native), "native must stop before replacement admission").toBeUndefined();
    expect(readSessiondProcessIdentity(first.tree.tool), "tool must stop before replacement admission").toBeUndefined();
    expect(readSessiondProcessIdentity(first.tree.wrapper), "wrapper must stop after adapter-child crash").toBeUndefined();
  }, 60_000);
});
