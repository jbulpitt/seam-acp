import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { terminateProcessGroup } from "../packages/adapters/src/probe-process.js";
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

async function fixture(agy = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-native-tree-"));
  const trees: Tree[] = [];
  const options = { socketPath: path.join(root, "control.sock"),
    statePath: path.join(root, "slots.json"), resumeDir: path.join(root, "resume") };
  let server = new SessiondServer(options);
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
  const invocationLog = path.join(root, "agy-invocations.jsonl");
  if (agy) {
    const fixtures = path.join(here, "fixtures/agy-native-capabilities");
    await fs.mkdir(path.join(root, ".gemini", "antigravity-cli"), { recursive: true });
    await fs.writeFile(path.join(root, "agy"),
      `#!/bin/sh\nSEAM_AGY_CAPABILITY_FIXTURE_DIR=${JSON.stringify(fixtures)} SEAM_AGY_CAPABILITY_INVOCATIONS=${JSON.stringify(invocationLog)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(fixtures, "fake-native-agy.mjs"))} "$@"\n`,
      { mode: 0o755 });
  }
  await server.start();
  client = await SessiondClient.connect(path.join(root, "control.sock"));
  const frames: Array<SupervisedBridgeFrame & { slot: number }> = [];
  const makeSlots = () => new SupervisedSlots({ client: client!, localCwd: root, copilotCmd: "/unused/copilot",
    adapterChildPath: path.join(here, "helpers/adapter-child-source.mjs"),
    environment: { HOME: root, PATH: `${root}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      CLAUDE_CLI_PATH: executable, CLAUDE_CONFIG_DIR: path.join(root, "claude"),
      COPILOT_ENABLED: "false", AGY_ENABLED: String(agy), AGY_PIN: "unpinned",
      AGY_DEFAULT_MODEL: "fixture-native-model", SEAM_NATIVE_TREE_FIXTURE: root },
    onFrame: frame => frames.push(frame), onStderr: () => {} });
  let slots = makeSlots();
  async function reconnectSessiond() {
    client?.close();
    await server.close();
    server = new SessiondServer(options);
    await server.start();
    client = await SessiondClient.connect(options.socketPath);
    slots = makeSlots();
    const listed = await slots.rebind();
    for (const health of listed.health) (await slots.replay(health.slot, 0)).activate();
  }
  const response = (slot: number, id: string) => until(() => frames.flatMap(frame => {
    if (frame.slot !== slot || frame.type !== "data") return [];
    return (frame.data ?? "").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  }).find(message => message.id === id), `slot ${slot} response ${id}`);
  const send = (slot: number, id: string, method: string, params: object) =>
    slots.writeInput(slot, `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  async function start(slot: number, load = false, agentId = "claude") {
    slots.configure(slot, { agentId, cwd: root, env: { SEAM_NATIVE_TREE_SLOT: String(slot) } });
    const prefix = `${slot}-${load ? "replacement" : "original"}`;
    await send(slot, `${prefix}-init`, "initialize", { protocolVersion: 1, clientCapabilities: {} });
    await response(slot, `${prefix}-init`);
    await send(slot, `${prefix}-session`, load ? "session/load" : "session/new",
      { cwd: root, mcpServers: [], ...(load ? { sessionId: "native-tree-session" } : {}) });
    const loaded = await response(slot, `${prefix}-session`);
    if (load && agentId === "claude") expect(loaded.result.previousRunning, "replacement load must find no old writer/tool").toEqual([]);
    await send(slot, `${prefix}-prompt`, "session/prompt", { sessionId: loaded.result.sessionId,
      prompt: [{ type: "text", text: agentId === "agy" ? "r5-tree" : "hold" }] });
    const tree = await until(async () => {
      try {
        let tree: Tree;
        if (agentId === "agy") {
          const invocations = (await fs.readFile(invocationLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
          const native = invocations.findLast(row => row.prompt === "r5-tree");
          const tool = invocations.findLast(row => row.scenario === "descendant");
          if (!native || !tool) return undefined;
          tree = { wrapper: native.pid, native: native.pid, tool: tool.pid };
        } else tree = JSON.parse(await fs.readFile(path.join(root, `${slot}.json`), "utf8")) as Tree;
        return trees.some(previous => previous.wrapper === tree.wrapper) ? undefined : tree;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    }, `slot ${slot} native/tool PIDs`);
    trees.push(tree);
    const health = (await client!.listSlots()).health.find(health => health.slot === slot)!;
    return { tree, adapterPid: health.pid! };
  }
  return { root, get client() { return client!; }, get server() { return server; },
    get slots() { return slots; }, frames, start, send, reconnectSessiond, trees };
}

describe("dead ACP wrapper process ownership", () => {
  it.each(["wrapper", "adapter-child", "wrapper exit", "explicit SIGKILL"] as const)("stops native/tool descendants after %s death before reporting exit, without touching another slot", async target => {
    const { client, frames, start, send } = await fixture();
    const first = await start(8911);
    const control = await start(8912);
    expect(readSessiondProcessIdentity(first.tree.native)?.pgid).toBe(first.tree.wrapper);
    expect(readSessiondProcessIdentity(first.tree.tool)?.pgid).toBe(first.tree.wrapper);
    expect(first.adapterPid).not.toBe(first.tree.wrapper);
    if (target === "wrapper exit") await send(8911, "exit", "fixture/exit", {});
    else if (target === "explicit SIGKILL") await client.kill({ slot: 8911, signal: "SIGKILL" });
    else process.kill(target === "wrapper" ? first.tree.wrapper : first.adapterPid, "SIGKILL");
    await until(() => frames.find(frame => frame.slot === 8911 && frame.type === "exit"), "slot exit");
    expect((await client!.listSlots()).health.find(health => health.slot === 8911)?.alive).toBe(false);
    expect((await client!.listSlots()).health.find(health => health.slot === 8912)?.alive).toBe(true);
    for (const pid of [control.adapterPid, control.tree.wrapper, control.tree.native, control.tree.tool]) {
      expect(readSessiondProcessIdentity(pid), `control PID ${pid} must remain running`).toBeDefined();
    }
    expect(readSessiondProcessIdentity(first.tree.native), "native must stop before replacement admission").toBeUndefined();
    expect(readSessiondProcessIdentity(first.tree.tool), "tool must stop before replacement admission").toBeUndefined();
    expect(readSessiondProcessIdentity(first.tree.wrapper), "wrapper must stop after adapter-child crash").toBeUndefined();
    await start(8911, true);
  }, 60_000);

  it("keeps live holders and their native work across sessiond restart, then reaps on wrapper death", async () => {
    const f = await fixture();
    const first = await f.start(8911);
    const control = await f.start(8912);
    await f.reconnectSessiond();
    for (const pid of [first.adapterPid, first.tree.wrapper, first.tree.native, first.tree.tool,
      control.adapterPid, control.tree.wrapper, control.tree.native, control.tree.tool]) {
      expect(readSessiondProcessIdentity(pid), `restart must retain PID ${pid}`).toBeDefined();
    }
    process.kill(first.tree.wrapper, "SIGKILL");
    await until(() => f.frames.find(frame => frame.slot === 8911 && frame.type === "exit"), "reattached slot exit");
    expect(readSessiondProcessIdentity(first.tree.native)).toBeUndefined();
    expect(readSessiondProcessIdentity(first.tree.tool)).toBeUndefined();
    expect(readSessiondProcessIdentity(control.tree.tool)).toBeDefined();
    await f.start(8911, true);
  }, 60_000);

  it.each(["SIGKILL", "SIGTERM"] as const)("reaps AGY's nested detached native/tool group after adapter-child %s, leaving the control slot alone", async signal => {
    const f = await fixture(true);
    const first = await f.start(8911, false, "agy");
    const control = await f.start(8912);
    expect(readSessiondProcessIdentity(first.tree.tool)?.pgid).toBe(first.tree.native);
    expect(readSessiondProcessIdentity(first.adapterPid)?.pgid).not.toBe(first.tree.native);
    process.kill(first.adapterPid, signal);
    await until(() => f.frames.find(frame => frame.slot === 8911 && frame.type === "exit"), "AGY slot exit");
    expect(readSessiondProcessIdentity(first.tree.native), "nested native must stop before exit publication").toBeUndefined();
    expect(readSessiondProcessIdentity(first.tree.tool), "TERM-ignoring tool must be reaped before exit publication").toBeUndefined();
    for (const pid of [control.adapterPid, control.tree.wrapper, control.tree.native, control.tree.tool]) {
      expect(readSessiondProcessIdentity(pid), `control PID ${pid} must remain running`).toBeDefined();
    }
  }, 60_000);

  it("does not signal a group whose leader start identity differs from the recorded owner", async () => {
    const f = await fixture();
    const control = await f.start(8912);
    const identity = readSessiondProcessIdentity(control.tree.wrapper)!;
    expect(await terminateProcessGroup({ ...identity, started: `${identity.started}-different` }, 1)).toBe(true);
    for (const pid of [control.adapterPid, control.tree.wrapper, control.tree.native, control.tree.tool]) {
      expect(readSessiondProcessIdentity(pid), `unowned PID ${pid} must remain running`).toBeDefined();
    }
  }, 60_000);
});
