/**
 * #631 — a turn interrupted by a host restart continues by itself.
 *
 * Real sessiond, slot holder, adapter-child and SupervisedSlots, with a fake
 * ACP agent. The "restart" kills every process the way a shutdown does, then
 * starts a new sessiond against the same resume directory.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_REMOTE_RUNG1_POLICY } from "../packages/core/src/core/remote-spawn.js";
import { SessiondClient } from "../packages/bridge/src/sessiond-client.js";
import { SessiondServer, readSessiondProcessIdentity } from "../packages/bridge/src/sessiond-server.js";
import { SupervisedSlots, type SupervisedBridgeFrame } from "../packages/bridge/src/supervised-slots.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapterChild = path.join(here, "helpers/adapter-child-source.mjs");
const fakeAgent = path.join(here, "fixtures/fake-acp-agent.mjs");
const roots: string[] = [];
const servers: SessiondServer[] = [];
const clients: SessiondClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close({ terminateChildren: true });
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function until<T>(read: () => T | undefined | Promise<T | undefined>, what: string, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const line = (message: Record<string, unknown>) => `${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`;

async function host(root: string, modeId?: string, options: {
  legacy?: boolean; loadGate?: string; selectors?: boolean; fixed?: boolean; restoreFailure?: string;
  agentEnv?: Record<string, string>;
} = {}) {
  const bin = path.join(root, "bin");
  if (modeId) {
    await fs.mkdir(bin, { recursive: true });
    if (!existsSync(path.join(bin, "codex-acp"))) await fs.symlink(fakeAgent, path.join(bin, "codex-acp"));
  }
  const socketPath = path.join(root, "control.sock");
  const server = new SessiondServer({ socketPath, statePath: path.join(root, "slots.json"), resumeDir: path.join(root, "resume") });
  servers.push(server);
  await server.start();
  const client = await SessiondClient.connect(socketPath);
  clients.push(client);
  const frames: Array<SupervisedBridgeFrame & { slot: number }> = [];
  const slots = new SupervisedSlots({
    client,
    copilotCmd: fakeAgent,
    localCwd: root,
    adapterChildPath: options.legacy ? path.join(here, "helpers/adapter-child-legacy.mjs") : adapterChild,
    environment: {
      HOME: root,
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      FAKE_AGENT_PIDS: path.join(root, "agent.pids"),
      ...(modeId ? { FAKE_AGENT_REQUIRE_MODE: modeId } : {}),
      ...(options.loadGate ? { FAKE_AGENT_LOAD_GATE: options.loadGate } : {}),
      ...(options.selectors ? {
        FAKE_AGENT_CONFIG_OPTIONS: "reasoning_effort",
        FAKE_AGENT_REQUIRE_MODEL: options.fixed ? "fixture-fixed" : "fixture-deep",
        FAKE_AGENT_REQUIRE_EFFORT: "max",
        FAKE_AGENT_REQUESTS: path.join(root, "requests.jsonl"),
      } : {}),
      ...(options.restoreFailure ? { FAKE_AGENT_RESTORE_FAILURE: options.restoreFailure } : {}),
      ...options.agentEnv,
    },
    onStderr: () => undefined,
    onFrame: (frame) => frames.push(frame),
  });
  return { server, client, slots, frames };
}

async function shutdown(root: string, app: Awaited<ReturnType<typeof host>>) {
  await app.server.close();
  servers.splice(servers.indexOf(app.server), 1);
  app.client.close();
  const state = JSON.parse(await fs.readFile(path.join(root, "slots.json"), "utf8")) as { slots: Array<{ identity: { pid: number; pgid: number } }> };
  const agentPid = Number((await fs.readFile(path.join(root, "agent.pids"), "utf8")).trim().split("\n").at(-1));
  for (const slot of state.slots) try { process.kill(-slot.identity.pgid, "SIGKILL"); } catch { /* gone */ }
  try { process.kill(agentPid, "SIGKILL"); } catch { /* gone */ }
  await until(() => [...state.slots.map(slot => slot.identity.pid), agentPid]
    .every(pid => !readSessiondProcessIdentity(pid)) ? true : undefined, "shutdown to finish");
  return agentPid;
}

describe("large prompts reach the agent", () => {
  it("delivers a 20 MB prompt (several full-size photos) through sessiond, the holder and adapter-child", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-big-"));
    roots.push(root);
    await fs.chmod(root, 0o700);
    const one = await host(root);
    one.slots.configure(6, { agentId: "copilot", cwd: root });
    await one.slots.writeInput(6, line({ id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    await one.slots.writeInput(6, line({ id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } }));
    await until(() => one.frames.find((f) => f.data?.includes("\"sessionId\":\"s1\"")), "session/new");
    const image = { type: "image", mimeType: "image/jpeg", data: Buffer.alloc(15 * 1024 * 1024, 5).toString("base64") };
    const prompt = line({ id: 3, method: "session/prompt", params: { sessionId: "s1", prompt: [image, { type: "text", text: "long job" }] } });
    expect(prompt.length).toBeGreaterThan(20 * 1024 * 1024);
    const delivered = await one.slots.writeInput(6, prompt);
    expect(one.slots.undeliverableReason(6)).toBeUndefined();
    expect(delivered).toBe(true);
    await until(() => one.frames.find((f) => f.data?.includes("working on it")), "the agent to answer the large prompt", 60_000);
  }, 90_000);
});

describe("#777 the retained adapter child decides reconciliation", () => {
  it("reconciles the same owner's cached terminal result without another prompt", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-terminal-owner-"));
    roots.push(root);
    const one = await host(root);
    one.slots.configure(9, { agentId: "copilot", cwd: root, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY });
    await one.slots.writeInput(9, line({ id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    await one.slots.writeInput(9, line({ id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } }));
    await until(() => one.frames.find(f => f.data?.includes('"sessionId":"s1"')), "session/new");
    await one.slots.armRecovery(9, { submissionId: "terminal", acpSessionId: "s1", continuation: "continue" });
    await one.slots.writeInput(9, line({ id: 3, method: "session/prompt", params: {
      sessionId: "s1", prompt: [{ type: "text", text: "continue" }],
    } }));
    const terminal = await until(() => one.frames.find(f => f.type === "recovery_result"), "terminal result");
    const before = (await one.client.listSlots()).health.find(row => row.slot === 9)!;
    one.frames.length = 0;
    expect(await one.slots.reconcileRecovery(9, { submissionId: "terminal", acpSessionId: "s1" }))
      .toEqual({ state: "owned" });
    const reconciled = await until(() => one.frames.find(f => f.type === "recovery_result"), "cached terminal result");
    expect(reconciled.recoveryResult).toEqual(terminal.recoveryResult);
    expect((await one.client.listSlots()).health.find(row => row.slot === 9)).toMatchObject({ alive: true, pid: before.pid });
    expect((await fs.readFile(path.join(root, "agent.pids"), "utf8")).trim().split("\n")).toHaveLength(1);
  }, 30_000);

  it.each([
    { legacy: false, unrelatedInput: false },
    { legacy: true, unrelatedInput: false },
    { legacy: true, unrelatedInput: true },
  ])("settles a never-submitted arm after bridge rebind: %j", async ({ legacy, unrelatedInput }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-777-owner-"));
    roots.push(root);
    const first = await host(root, undefined, { legacy });
    first.slots.configure(8, { agentId: "copilot", cwd: root, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY });
    await first.slots.writeInput(8, line({ id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    await first.slots.writeInput(8, line({ id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } }));
    await until(() => first.frames.find(f => f.data?.includes('"sessionId":"s1"')), "session/new");
    const snapshot = await first.slots.armRecovery(8, { submissionId: "never-submitted", acpSessionId: "s1", continuation: "continue" });
    if (unrelatedInput) await first.slots.writeInput(8, line({ id: 3, method: "session/get_config", params: { sessionId: "s1" } }));
    expect(snapshot.reconcileSupported).toBe(legacy ? undefined : true);
    const before = (await first.client.listSlots()).health.find(row => row.slot === 8)!;
    expect(before.resumePending).toBe(false);
    first.client.close();
    const client = await SessiondClient.connect(path.join(root, "control.sock"));
    clients.push(client);
    const frames: SupervisedBridgeFrame[] = [];
    const rebound = new SupervisedSlots({ client, copilotCmd: fakeAgent, localCwd: root,
      onFrame: frame => frames.push(frame), onStderr: () => undefined });
    await rebound.rebind();
    const replay = await rebound.replay(8, 0);
    replay.activate();
    const result = await rebound.reconcileRecovery(8, { submissionId: "never-submitted", acpSessionId: "s1" });
    if (legacy) expect(result).toMatchObject({ state: "missing", cause: expect.stringContaining("never received") });
    else {
      expect(result).toEqual({ state: "owned" });
      const terminal = await until(() => frames.find(frame => frame.recoveryResult), "owner failure result");
      expect(terminal.recoveryResult).toMatchObject({ status: "failed", stopReason: "prompt_not_received",
        error: expect.stringContaining("never received") });
    }
    const after = (await client.listSlots()).health.find(row => row.slot === 8)!;
    expect(after).toMatchObject({ pid: before.pid, alive: true, attached: true });
    expect(frames.some(frame => frame.type === "exit")).toBe(false);
    expect(frames.some(frame => frame.data?.includes("working on it"))).toBe(false);
  }, 20_000);

  it.each([false, true])("leaves executing work owned; legacy=%s", async legacy => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-777-running-"));
    roots.push(root);
    const one = await host(root, undefined, { legacy });
    one.slots.configure(8, { agentId: "copilot", cwd: root, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY });
    await one.slots.writeInput(8, line({ id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    await one.slots.writeInput(8, line({ id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } }));
    await until(() => one.frames.find(f => f.data?.includes('"sessionId":"s1"')), "session/new");
    await one.slots.armRecovery(8, { submissionId: "running", acpSessionId: "s1", continuation: "continue" });
    await one.slots.writeInput(8, line({ id: 7, method: "session/prompt", params: {
      sessionId: "s1", prompt: [{ type: "text", text: "long job" }],
    } }));
    await until(() => one.frames.find(f => f.data?.includes("working on it")), "prompt acceptance");
    const before = (await one.client.listSlots()).health.find(row => row.slot === 8)!;
    expect(before.resumePending).toBe(true);
    expect(await one.slots.reconcileRecovery(8, { submissionId: "running", acpSessionId: "s1" })).toEqual({ state: "owned" });
    expect((await one.client.listSlots()).health.find(row => row.slot === 8)?.pid).toBe(before.pid);
    expect(one.frames.some(frame => frame.recoveryResult)).toBe(false);
  }, 20_000);
});

describe("#631 host restart mid-turn", () => {
  it.each([
    { model: "fixture-flash", effort: "low" },
    { model: "fixture-fixed", effort: undefined },
  ])("records changed replay readbacks for a second restart: %j", async accepted => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-repeat-resume-"));
    roots.push(root);
    const readbackFile = path.join(root, "readback.json");
    const setterGate = path.join(root, "setter.ready");
    const continueGate = path.join(root, "continue.ready");
    const requests = async () => (await fs.readFile(path.join(root, "requests.jsonl"), "utf8")).trim().split("\n").map(row => JSON.parse(row));
    const record = path.join(root, "resume", "5.json");
    const saved = async () => JSON.parse(Buffer.from(JSON.parse(await fs.readFile(record, "utf8")).initialStdinBase64, "base64").toString()).resume;
    const original = { model: { configId: "model", value: "fixture-deep" }, effort: { configId: "reasoning_effort", value: "max" } };
    const first = await host(root, undefined, { selectors: true, agentEnv: {
      FAKE_AGENT_READBACK_FILE: readbackFile,
      FAKE_AGENT_SETTER_GATE: setterGate,
      FAKE_AGENT_CONTINUE_GATE: continueGate,
      FAKE_AGENT_REQUIRE_MODEL: accepted.model,
      FAKE_AGENT_REQUIRE_EFFORT: accepted.effort ?? "max",
    } });
    first.slots.configure(5, { agentId: "copilot", cwd: root, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY });
    await first.slots.writeInput(5, line({ id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    await first.slots.writeInput(5, line({ id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } }));
    await until(() => first.frames.find(f => f.data?.includes('"sessionId":"s1"')), "session/new");
    for (const [id, configId, value] of [[3, "model", "fixture-deep"], [4, "reasoning_effort", "max"]] as const) {
      await first.slots.writeInput(5, line({ id, method: "session/set_config_option", params: { sessionId: "s1", configId, value } }));
      await until(() => first.frames.find(f => f.data?.includes(`"id":${id}`) && f.data.includes('"result"')), "selector acknowledgement");
    }
    await first.slots.armRecovery(5, { submissionId: "repeat", acpSessionId: "s1", continuation: "continue" });
    await first.slots.writeInput(5, line({ id: 7, method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text: "long job" }] } }));
    await until(() => first.frames.find(f => f.data?.includes("working on it")), "initial turn");
    expect((await saved()).configOptions).toEqual(original);
    const firstPid = await shutdown(root, first);
    await fs.writeFile(readbackFile, JSON.stringify(accepted));

    const second = await host(root);
    await second.slots.rebind();
    const replay = await second.slots.replay(5, 0); replay.activate();
    const secondFrames = () => [...replay.result.frames, ...second.frames];
    await until(async () => (await requests()).find(row => row.pid !== firstPid && row.method === "session/set_config_option"
      && row.params.configId === "reasoning_effort"), "frozen effort target to be sent");
    // Intermediate model defaults must not replace the intended pair on disk.
    expect((await saved()).configOptions).toEqual(original);
    await fs.writeFile(setterGate, "ready");
    await until(() => secondFrames().find(f => f.data?.includes("continuation held")), "resumed continuation in flight");
    expect((await saved()).configOptions).toEqual({ model: { configId: "model", value: accepted.model },
      ...(accepted.effort ? { effort: { configId: "reasoning_effort", value: accepted.effort } } : {}) });
    const secondPid = await shutdown(root, second);
    const firstReplay = (await requests()).filter(row => row.pid === secondPid && row.method === "session/set_config_option");
    expect(firstReplay.map(row => row.params)).toEqual([
      { sessionId: "s1", ...original.model }, { sessionId: "s1", ...original.effort },
    ]);
    await fs.unlink(readbackFile);
    await fs.writeFile(continueGate, "ready");

    const third = await host(root);
    await third.slots.rebind();
    const finalReplay = await third.slots.replay(5, 0); finalReplay.activate();
    const finalFrames = () => [...finalReplay.result.frames, ...third.frames];
    const answer = await until(() => finalFrames().find(f => f.data?.includes('"id":7')
      && (f.data.includes('"result"') || f.data.includes('"error"'))), "second resume result");
    expect(JSON.parse(answer.data!)).toMatchObject({ id: 7, result: { stopReason: "end_turn" } });
    const thirdRequests = (await requests()).filter(row => row.pid !== firstPid && row.pid !== secondPid);
    expect(thirdRequests.map(row => row.method)).toEqual(["initialize", "session/load", "session/set_config_option",
      ...(accepted.effort ? ["session/set_config_option"] : []), "session/prompt"]);
    expect(thirdRequests.filter(row => row.method === "session/set_config_option").map(row => row.params)).toEqual([
      { sessionId: "s1", configId: "model", value: accepted.model },
      ...(accepted.effort ? [{ sessionId: "s1", configId: "reasoning_effort", value: accepted.effort }] : []),
    ]);
    await until(() => existsSync(record) ? undefined : true, "completed resume record to clear");
  }, 60_000);

  it.each([
    { modeId: undefined, legacy: false },
    { modeId: "agent-full-access", legacy: false },
    { modeId: undefined, legacy: true },
    { modeId: undefined, legacy: false, selectors: true },
    { modeId: "agent-full-access", legacy: false, selectors: true },
    { modeId: undefined, legacy: false, selectors: true, fixed: true },
    { modeId: undefined, legacy: false, selectors: true, restoreFailure: "model" },
    { modeId: undefined, legacy: false, selectors: true, restoreFailure: "reasoning_effort" },
  ])("reloads and continues under the original id: %j", async ({ modeId, legacy, selectors, fixed, restoreFailure }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seam-631r-"));
    roots.push(root);
    await fs.chmod(root, 0o700);
    const loadGate = path.join(root, "load.ready");
    const first = await host(root, modeId, { legacy, loadGate, selectors, fixed, restoreFailure });
    const mcpServers = selectors ? [{ name: "owned-fixture", type: "http" as const, url: "http://fixture.invalid/mcp", headers: [] }] : [];
    first.slots.configure(5, { agentId: modeId ? "codex" : "copilot", cwd: root, rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY, mcpServers });
    await first.slots.writeInput(5, line({ id: 1, method: "initialize", params: { protocolVersion: 1 } }));
    await first.slots.writeInput(5, line({ id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } }));
    await until(() => first.frames.find((f) => f.data?.includes("\"sessionId\":\"s1\"")), "session/new");
    if (modeId) {
      await first.slots.writeInput(5, line({ id: 3, method: "session/set_mode", params: { sessionId: "s1", modeId } }));
      await until(() => first.frames.find(f => f.data?.includes('"id":3') && f.data.includes('"result"')), "the mode acknowledgement");
    }
    if (selectors) {
      await first.slots.writeInput(5, line({ id: 4, method: "session/set_config_option",
        params: { sessionId: "s1", configId: "model", value: fixed ? "fixture-fixed" : "fixture-deep" } }));
      await until(() => first.frames.find(f => f.data?.includes('"id":4') && f.data.includes('"result"')), "model acknowledgement");
      if (!fixed) {
        await first.slots.writeInput(5, line({ id: 5, method: "session/set_config_option",
          params: { sessionId: "s1", configId: "reasoning_effort", value: "max" } }));
        await until(() => first.frames.find(f => f.data?.includes('"id":5') && f.data.includes('"result"')), "effort acknowledgement");
      }
      await first.slots.writeInput(5, line({ id: 6, method: "session/set_config_option",
        params: { sessionId: "s1", configId: "model", value: "pending" } }));
      await first.slots.writeInput(5, line({ id: 8, method: "session/set_config_option",
        params: { sessionId: "s1", configId: "model", value: "rejected" } }));
      await until(() => first.frames.find(f => f.data?.includes('"id":8') && f.data.includes('"error"')), "rejected selection");
    }
    await first.slots.armRecovery(5, { submissionId: "sub-5", acpSessionId: "s1", continuation: "continue" });
    await first.slots.writeInput(5, line({ id: 7, method: "session/prompt",
      params: { sessionId: "s1", prompt: [{ type: "text", text: "long job" }] } }));
    await until(() => first.frames.find((f) => f.data?.includes("working on it")), "the turn to start");
    const record = path.join(root, "resume", "5.json");
    await until(() => existsSync(record) ? true : undefined, "the resume record");
    const saved = JSON.parse(await fs.readFile(record, "utf8"));
    expect(JSON.parse(Buffer.from(saved.initialStdinBase64, "base64").toString()).resume.modeId).toBe(modeId);
    const selections = JSON.parse(Buffer.from(saved.initialStdinBase64, "base64").toString()).resume.configOptions;
    if (selectors) expect(selections).toEqual({
      model: { configId: "model", value: fixed ? "fixture-fixed" : "fixture-deep" },
      ...(!fixed ? { effort: { configId: "reasoning_effort", value: "max" } } : {}),
    });
    else expect(selections).toBeUndefined();

    // Host shutdown: sessiond stops, then every remaining process is killed.
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    first.client.close();
    const state = JSON.parse(await fs.readFile(path.join(root, "slots.json"), "utf8")) as { slots: Array<{ identity: { pid: number; pgid: number } }> };
    for (const slot of state.slots) try { process.kill(-slot.identity.pgid, "SIGKILL"); } catch { /* gone */ }
    const agentPids = (await fs.readFile(path.join(root, "agent.pids"), "utf8")).trim().split("\n").map(Number);
    for (const pid of agentPids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
    // A new host cannot still observe processes from the previous boot.
    await until(() => [...state.slots.map(slot => slot.identity.pid), ...agentPids]
      .every(pid => !readSessiondProcessIdentity(pid)) ? true : undefined, "shutdown to finish");
    expect(existsSync(record)).toBe(true);

    const second = await host(root, modeId, { legacy, loadGate, selectors, fixed, restoreFailure });
    await second.slots.rebind();
    const replay = await second.slots.replay(5, 0);
    replay.activate();
    const seen = () => [...replay.result.frames, ...second.frames];
    expect((await second.client.listSlots()).health.find(row => row.slot === 5)?.resumePending).toBe(true);
    expect(await second.slots.reconcileRecovery(5, { submissionId: "sub-5", acpSessionId: "s1" })).toEqual({ state: "owned" });
    expect(seen().some(frame => frame.recoveryResult?.status === "failed")).toBe(false);
    await fs.writeFile(loadGate, "ready");
    if (restoreFailure) {
      const failure = await until(() => seen().find(f => f.data?.includes('"id":7') && f.data.includes('"error"')), "original request error");
      expect(JSON.parse(failure.data!)).toMatchObject({ id: 7, error: { code: -32000,
        message: "Fixture selection rejected", data: { trace: "fixture-selection-cause" } } });
      await until(() => seen().find(f => f.type === "exit"), "existing resume failure route");
      const requests = (await fs.readFile(path.join(root, "requests.jsonl"), "utf8")).trim().split("\n").map(row => JSON.parse(row));
      const resumed = requests.filter(row => row.pid !== agentPids[0]);
      expect(resumed.map(row => row.method)).toEqual(["initialize", "session/load", "session/set_config_option",
        ...(restoreFailure === "reasoning_effort" ? ["session/set_config_option"] : [])]);
      expect(resumed.some(row => row.method === "session/prompt")).toBe(false);
      await until(() => existsSync(record) ? undefined : true, "the failed resume record to clear");
      return;
    }
    const answer = await until(() => seen().find((f) => f.data?.includes("\"id\":7")
      && (f.data.includes('"result"') || f.data.includes('"error"'))), "the original prompt's answer");
    expect(JSON.parse(answer.data!)).toMatchObject({ id: 7, result: { stopReason: "end_turn" } });
    const result = await until(() => seen().find((f) => f.type === "recovery_result"), "the recovery result");
    expect(result.recoveryResult).toMatchObject({ submissionId: "sub-5", status: "completed" });
    expect(result.recoveryResult?.text).toContain("resumed ok");
    // The reload's history replay is not the controller's to see again.
    expect(seen().some((f) => f.data?.includes("replayed history"))).toBe(false);
    if (selectors) {
      const requests = (await fs.readFile(path.join(root, "requests.jsonl"), "utf8")).trim().split("\n").map(row => JSON.parse(row));
      const resumed = requests.filter(row => row.pid !== agentPids[0]);
      expect(resumed.map(row => row.method)).toEqual(["initialize", "session/load", ...(modeId ? ["session/set_mode"] : []),
        "session/set_config_option", ...(!fixed ? ["session/set_config_option"] : []), "session/prompt"]);
      expect(resumed.filter(row => row.method === "session/set_config_option").map(row => row.params)).toEqual([
        { sessionId: "s1", configId: "model", value: fixed ? "fixture-fixed" : "fixture-deep" },
        ...(!fixed ? [{ sessionId: "s1", configId: "reasoning_effort", value: "max" }] : []),
      ]);
      expect(resumed.find(row => row.method === "session/load").params.mcpServers).toEqual(mcpServers);
      expect(resumed.filter(row => row.method === "session/prompt")).toHaveLength(1);
      expect(resumed.find(row => row.method === "session/prompt").params.sessionId).toBe("s1");
    }
    await until(() => existsSync(record) ? undefined : true, "the record to be cleared");
  }, 60_000);
});
