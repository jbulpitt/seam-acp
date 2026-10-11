import { afterEach, describe, expect, it } from "vitest";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessiondServer, readSessiondProcessIdentity } from "../packages/bridge/src/sessiond-server.js";
import { SessiondClient } from "../packages/bridge/src/sessiond-client.js";
import { SupervisedSlots, type SupervisedBridgeFrame } from "../packages/bridge/src/supervised-slots.js";
import { DEFAULT_REMOTE_RUNG1_POLICY } from "../packages/core/src/core/remote-spawn.js";
import { createManagedAgyFixture, createOrdinaryAgyFixture } from "./helpers/agy-runtime-fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures/thread-env-acp.mjs");
const roots: string[] = [];
const servers: SessiondServer[] = [];
const clients: SessiondClient[] = [];
const cleanups: (() => void)[] = [];
const identity = (threadId: string, agent = "claude") => ({ threadId, channelId: "parent", agentId: `${agent}@host` });
const envFor = (id: ReturnType<typeof identity>) => ({ SEAM_THREAD_ID: id.threadId, SEAM_CHANNEL_ID: id.channelId,
  SEAM_AGENT_ID: id.agentId });
const line = (id: number, method: string, params: object) => `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close({ terminateChildren: true });
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function until<T>(read: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`timed out waiting for ${what}`);
}
async function host(root?: string) {
  root ??= await fs.mkdtemp(path.join(os.tmpdir(), "seam-thread-env-"));
  if (!roots.includes(root)) roots.push(root);
  const bin = path.join(root, "bin");
  await fs.mkdir(bin, { recursive: true });
  for (const name of ["copilot", "codex-acp", "claude-agent-acp", "grok"]) {
    const executable = path.join(bin, name);
    if (!existsSync(executable)) {
      await fs.writeFile(executable, (await fs.readFile(fixture, "utf8")).replace(/^#![^\n]*/, `#!${process.execPath}`), { mode: 0o700 });
    }
  }
  const server = new SessiondServer({ socketPath: path.join(root, "control.sock"), statePath: path.join(root, "slots.json"), resumeDir: path.join(root, "resume") });
  servers.push(server);
  await server.start();
  const client = await SessiondClient.connect(path.join(root, "control.sock"));
  clients.push(client);
  const frames: (SupervisedBridgeFrame & { slot: number })[] = [];
  const slots = new SupervisedSlots({ client, adapterChildPath: path.join(here, "helpers/adapter-child-source.mjs"),
    copilotCmd: path.join(bin, "copilot"), localCwd: root,
    environment: { HOME: root, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, AGY_ENABLED: "false",
      GROK_CATALOG_MODE: "subscription", SEAM_BRIDGE_ID: "fixture-host", SEAM_BRIDGE_TOKEN: "fixture-token",
      CLAUDE_VERTEX_PROJECT_ID: "fixture-project", CLAUDE_VERTEX_CREDENTIALS_FILE: path.join(root, "credentials.json"),
      CLAUDE_VERTEX_CONFIG_DIR: path.join(root, "vertex-config") },
    onFrame: frame => frames.push(frame), onStderr: () => undefined });
  return { root, server, client, slots, frames };
}
async function prompt(h: Awaited<ReturnType<typeof host>>, slot: number, method = "session/new", text = "finish") {
  await h.slots.writeInput(slot, line(1, "initialize", { protocolVersion: 1 }));
  await h.slots.writeInput(slot, line(2, method, { cwd: h.root, sessionId: "env-session", mcpServers: [] }));
  await until(() => h.frames.find(f => f.slot === slot && f.data?.includes('"id":2')), method);
  await h.slots.armRecovery(slot, { submissionId: `thread-${slot}`, acpSessionId: "env-session", continuation: "continue" });
  await h.slots.writeInput(slot, line(3, "session/prompt", { sessionId: "env-session", prompt: [{ type: "text", text }] }));
  return until(() => h.frames.find(f => f.slot === slot && f.data?.includes('grandchild')), "tool environment receipt");
}
function result(frame: SupervisedBridgeFrame) { return JSON.parse(JSON.parse(frame.data!).params.update.content.text); }

describe("supervised thread environment", () => {
  it.each(["claude", "codex", "copilot", "grok", "claude-vertex"])("%s tools inherit identity on new and loaded sessions", async agentId => {
    const h = await host();
    for (const [slot, method] of [[1, "session/new"], [2, "session/load"]] as const) {
      const id = identity(`thread-${slot}`, agentId);
      h.slots.configure(slot, { agentId, cwd: h.root, threadIdentity: id, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY } as any);
      const receipt = result(await prompt(h, slot, method));
      expect(receipt.identity).toEqual(envFor(id));
      expect(receipt.grandchild).toEqual(envFor(id));
      expect(receipt).toMatchObject({ bridgeId: "fixture-host", bridgeTokenUnchanged: true, resumeFile: true });
    }
  }, 40_000);

  it("concurrent Claude and Codex threads retain their identities through bridge rebind", async () => {
    const h = await host();
    const ids = [identity("thread-one"), identity("thread-two", "codex")];
    ids.forEach((id, index) => h.slots.configure(index + 1, { agentId: index ? "codex" : "claude", cwd: h.root,
      threadIdentity: id, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY } as any));
    const first = await Promise.all(ids.map((_id, i) => prompt(h, i + 1, "session/new", "hold")));
    const pids = first.map(f => result(f).pid);
    h.client.close();
    const client = await SessiondClient.connect(path.join(h.root, "control.sock"));
    clients.push(client);
    const frames: any[] = [];
    const slots = new SupervisedSlots({ client, localCwd: h.root, copilotCmd: "unused", onFrame: f => frames.push(f), onStderr() {} });
    await slots.rebind();
    for (let slot = 1; slot <= 2; slot++) {
      const replay = await slots.replay(slot, 0); replay.activate();
      await slots.writeInput(slot, line(4, "session/prompt", { sessionId: "env-session", prompt: [{ type: "text", text: "finish" }] }));
      const f = await until(() => frames.find(f => f.slot === slot && f.data?.includes('grandchild')), "rebound environment");
      expect(result(f)).toMatchObject({ pid: pids[slot - 1], identity: envFor(ids[slot - 1]!), grandchild: envFor(ids[slot - 1]!) });
    }
  }, 40_000);

  it.each(["copilot", "codex"])("sessiond respawns %s with the original identity after a host restart", async agentId => {
    const h = await host();
    const id = identity("same-thread", agentId);
    h.slots.configure(5, { agentId, cwd: h.root, threadIdentity: id, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY } as any);
    const first = result(await prompt(h, 5, "session/new", "hold"));
    const file = path.join(h.root, "resume/5.json");
    await until(() => existsSync(file) ? true : undefined, "resume record");
    await h.server.close(); servers.splice(servers.indexOf(h.server), 1); h.client.close();
    const state = JSON.parse(await fs.readFile(path.join(h.root, "slots.json"), "utf8"));
    for (const slot of state.slots) try { process.kill(-slot.identity.pgid, "SIGKILL"); } catch {}
    try { process.kill(first.pid, "SIGKILL"); } catch {}
    await until(() => [...state.slots.map((s: any) => s.identity.pid), first.pid].every(pid => !readSessiondProcessIdentity(pid)) ? true : undefined, "own fixture shutdown");
    const resumed = await host(h.root);
    await resumed.slots.rebind();
    const replay = await resumed.slots.replay(5, 0); replay.activate();
    const seen = () => [...replay.result.frames, ...resumed.frames];
    const f = await until(() => seen().find(f => f.data?.includes('grandchild')), "resumed tool receipt");
    expect(result(f).pid).not.toBe(first.pid);
    expect(result(f).identity).toEqual(envFor(id));
    expect(result(f).grandchild).toEqual(envFor(id));
    await until(() => seen().find(f => f.recoveryResult?.status === "completed"), "resumed completion");
  }, 60_000);
});

describe("AGY environment filtering", () => {
  it.each(["managed", "ordinary"])("%s AGY passes the thread owner to shell grandchildren", async mode => {
    const id = identity("agy-thread", "agy");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-agy-env-")); roots.push(root);
    const baseEnv = { HOME: root, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, ...envFor(id) };
    const f = mode === "managed" ? createManagedAgyFixture({ source: fixture, version: "thread-env-fixture 1.0", cwd: root, baseEnv })
      : createOrdinaryAgyFixture({ source: fixture, version: "thread-env-fixture 1.0", cwd: root, baseEnv });
    cleanups.push(f.cleanup);
    const child = f.runtime.prepare([], root, { stdio: ["pipe", "pipe", "pipe"] }).spawn();
    let data = "";
    const answer = new Promise<any>((resolve, reject) => {
      child.once("error", reject);
      child.stdout!.on("data", chunk => { data += chunk; for (const l of data.split("\n").slice(0, -1)) {
        const frame = JSON.parse(l); if (frame.method === "session/update") resolve(JSON.parse(frame.params.update.content.text));
      } });
    });
    child.stdin!.write(line(3, "session/prompt", { sessionId: "env-session", prompt: [{ type: "text", text: "finish" }] }));
    try { const receipt = await answer; expect(receipt.identity).toEqual(envFor(id)); expect(receipt.grandchild).toEqual(envFor(id)); }
    finally { child.stdin!.end(); await new Promise(resolve => child.once("close", resolve)); }
  }, 30_000);
});
