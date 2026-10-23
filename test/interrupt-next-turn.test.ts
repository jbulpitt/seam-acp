import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { createRuntimeDispatchWatcher, type DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { enqueueDispatchSpec, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import { SeamMcpServer } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { testSessionRouter } from "./helpers/session-fixture.js";

const logger = pino({ level: "silent" });
const target = "111111111111111111";
const callerRef = "333333333333333333";
const parent = "222222222222222222";
let dir: string;
let store: SessionStore;
const releases: Array<() => void> = [];
const watchers: DispatchWatcher[] = [];
const servers: SeamMcpServer[] = [];

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  releases.push(release);
  return { promise, release };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-interrupt-next-"));
  store = new SessionStore(path.join(dir, "seam.db"));
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const watcher of watchers) watcher.stop();
  await Promise.all(watchers.splice(0).map(watcher => watcher.drain()));
  await Promise.all(servers.splice(0).map(server => server.stop()));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function fixture(workerAgent = "claude") {
  const record = (channelRef: string): SessionRecord => ({
    id: `discord:${channelRef}`, platform: "discord", channelRef, parentRef: parent,
    agentId: channelRef === target ? workerAgent : "claude", acpSessionId: "original-context", repoPath: dir, configJson: "{}",
    createdUtc: new Date().toISOString(), updatedUtc: new Date().toISOString(),
  });
  store.upsert(record(target));
  store.upsert(record(callerRef));
  const events: string[] = [];
  const contexts = new Map<string, string>();
  const abortTurn = vi.fn(async () => "cancelled" as const);
  const invalidate = vi.fn(async (sessionId: string) => {
    events.push("reset");
    const row = store.get(sessionId)!;
    store.upsert({ ...row, acpSessionId: "" }, { source: "fixture", cause: "requested fresh session" });
  });
  const router = testSessionRouter({
    listProfiles: () => [], getProfile: (id: string) => ({ id }), hasRuntime: () => true,
    ensureSessionRecord: (input: { channelRef: string }) => store.getByChannel("discord", input.channelRef) ?? record(input.channelRef),
    describeConfig: (row: SessionRecord) => ({
      agent: { value: row.agentId, source: "session config" },
      model: { value: "native", source: "default" }, effort: { value: null, source: "default" },
      location: { value: "local", source: "default" }, cwd: { value: dir, source: "default" },
    }), abortTurn, invalidate,
  });
  const orch = new Orchestrator({ store, router, logger, modelCatalog: fixtureModelCatalog([]),
    config: { DATA_DIR: dir, REPOS_ROOT: dir, channelPresets: new Map(), threadPresets: new Map(),
      DISCORD_USER_NAMES: new Map(), TURN_TIMEOUT_SECONDS: 60, DEFAULT_MODEL: "native", SEAM_DISPATCH_STATUS_PANEL: false } as any,
    adapter: {} as any, renderer: {} as any,
  });
  (orch as any).postDispatchStartIndicator = async () => undefined;
  (orch as any).postDispatchOutput = async () => {};
  (orch as any).enqueueReportBack = vi.fn(async (spec: DispatchSpec) => { events.push(`report:${spec.id}`); });
  orch.recoverInterruptedTurns = async () => {};
  orch.reconcileRemoteRecoveries = async () => {};
  const held = gate();
  const holds = new Map<string, Promise<void>>([["active", held.promise]]);
  // Only provider execution/Discord rendering are synthetic; both queue layers and SQL are real.
  (orch as any).injectTurn = async (row: SessionRecord, prompt: string, opts: any) => {
    const name = prompt.includes("<seam-steer>") ? "steer"
      : prompt.includes("<seam-interrupt>") ? prompt.includes("second urgent") ? "interrupt2" : "interrupt"
      : ["active", "first", "second"].find(value => prompt.includes(`JOB_${value}`))!;
    contexts.set(name, row.acpSessionId);
    opts.onSession?.("fixture-acp");
    opts.lifecycle?.beforePrompt?.();
    events.push(`start:${name}`);
    await holds.get(name);
    events.push(`end:${name}`);
    const outcome = { text: `DONE_${name}`, stopReason: "end_turn" };
    opts.lifecycle?.onOutcome?.(outcome);
    return outcome;
  };
  const watcher = createRuntimeDispatchWatcher({ dataDir: dir, attempts: store.turnAttempts, logger,
    runtime: orch, pollMs: 60_000 });
  watchers.push(watcher);
  orch.setDispatchWatcher(watcher);
  const mcp = new SeamMcpServer({ logger,
    resolveSession: token => token === "fixture-caller" ? store.get(`discord:${callerRef}`) ?? undefined : undefined,
    resolveThread: ref => store.getByChannel("discord", ref) ?? undefined,
    enqueueDispatch: spec => enqueueDispatchSpec(dir, spec, store.turnAttempts),
    interruptRedirect: (caller, to, message, fresh) => orch.interruptRedirect(caller, to, message, fresh),
  });
  servers.push(mcp);
  await mcp.start();
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, { method: "POST",
      headers: { "content-type": "application/json", "X-Seam-Session": "fixture-caller" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name, arguments: args } }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.error).toBeUndefined();
    expect(body.result.isError, body.result.content[0]?.text).toBeFalsy();
    return body.result.content[0].text as string;
  };
  const send = (fresh = false, message = "do the urgent task") =>
    call("send", { to: target, message, interrupt: true, fresh });
  const steer = () => call("steer", { thread: target, prompt: "focus on the failing test first" });
  const enqueue = (id: string, name: string, second: number) => enqueueDispatchSpec(dir, {
    id, target, prompt: `JOB_${name}`, session: "live", kind: "handoff", returnTo: callerRef,
    createdUtc: `2026-01-01T00:00:0${second}.000Z`,
  }, store.turnAttempts);
  return { orch, watcher, send, steer, enqueue, events, contexts, held, holds, abortTurn, invalidate };
}

describe("MCP steer delivery", () => {
  it("acknowledges queued steering behind a busy Codex turn and earlier work", async () => {
    const h = await fixture("codex");
    await h.enqueue("active", "active", 0);
    await h.watcher.start({ waitForInitialDispatches: false });
    await vi.waitFor(() => expect(h.events).toContain("start:active"));
    await h.enqueue("first", "first", 1);
    const earlier = h.watcher.tick();
    await vi.waitFor(() => expect(h.watcher.inFlightIdsForTarget(target)).toHaveLength(2));

    const receipt = await h.steer();
    const queued = h.watcher.tick();
    await vi.waitFor(() => expect(h.watcher.inFlightIdsForTarget(target)).toHaveLength(3));
    const steerAttempt = store.turnAttempts.list("pending").find(attempt => attempt.spec.prompt.includes("<seam-steer>"))!;
    expect(steerAttempt.promptStarted).toBe(false);
    expect(store.turnAttempts.get("active")?.promptStarted).toBe(true);
    expect(h.events.filter(event => event.startsWith("start:"))).toEqual(["start:active"]);
    expect.soft(receipt).toContain("Queued steering instruction");
    expect.soft(receipt).toContain("separate turn");
    expect.soft(receipt).toContain("already queued");
    expect.soft(receipt).not.toContain("injected into its live session");
    expect.soft(receipt).toContain(steerAttempt.id);

    h.held.release();
    await Promise.all([earlier, queued]);
    await h.watcher.drain();
    expect(h.events.filter(event => event.startsWith("start:") || event.startsWith("end:"))).toEqual([
      "start:active", "end:active", "start:first", "end:first", "start:steer", "end:steer",
    ]);
    expect(h.contexts.get("steer")).toBe("original-context");
    expect(h.contexts.get("steer")).toBe(h.contexts.get("active"));
    for (const id of ["active", "first", steerAttempt.id]) {
      expect(store.turnAttempts.get(id)?.state).toBe("completed");
      expect(h.events.filter(event => event === `report:${id}`)).toHaveLength(1);
    }
    await h.watcher.tick();
    expect(h.events.filter(event => event === "start:steer")).toHaveLength(1);
    expect(h.abortTurn).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
  });
});

describe("send interrupt next-turn ordering", () => {
  for (const active of ["dispatch", "typed"] as const) {
    it(`runs next behind the active ${active}, then preserves two queued dispatches and their reports`, async () => {
      const h = await fixture();
      let activeRun: Promise<unknown> | undefined;
      if (active === "dispatch") {
        await h.enqueue("active", "active", 0);
        await h.watcher.start({ waitForInitialDispatches: false });
      } else {
        activeRun = (h.orch as any).queueOnChannel(target, async () => {
          h.events.push("start:active"); await h.held.promise; h.events.push("end:active");
        });
        await h.watcher.start();
      }
      await vi.waitFor(() => expect(h.events).toContain("start:active"));
      if (active === "dispatch") expect(store.turnAttempts.get("active")?.promptStarted).toBe(true);
      await h.enqueue("z-first", "first", 1);
      await h.enqueue("a-second", "second", 2);
      const queued = h.watcher.tick();
      await vi.waitFor(() => expect(h.watcher.inFlightIdsForTarget(target)).toEqual(expect.arrayContaining(["z-first", "a-second"])));
      const receipt = await h.send();
      const urgent = active === "dispatch" ? h.watcher.tick() : Promise.resolve();
      if (active === "dispatch") await vi.waitFor(() => expect(h.watcher.inFlightIdsForTarget(target)).toHaveLength(4));
      expect.soft(h.abortTurn).not.toHaveBeenCalled();
      expect.soft(h.events.filter(event => event.startsWith("start:"))).toEqual(["start:active"]);
      expect.soft(receipt).toContain("Running work is not cancelled");
      h.held.release();
      await Promise.all([activeRun, queued, urgent]);
      await h.watcher.tick();
      await h.watcher.drain();
      expect(h.events.filter(event => event.startsWith("start:") || event.startsWith("end:"))).toEqual([
        "start:active", "end:active", "start:interrupt", "end:interrupt",
        "start:first", "end:first", "start:second", "end:second",
      ]);
      for (const id of ["z-first", "a-second", ...(active === "dispatch" ? ["active"] : [])]) {
        expect(store.turnAttempts.get(id)?.state).toBe("completed");
        expect(h.events).toContain(`report:${id}`);
      }
      const completed = store.turnAttempts.list("completed");
      expect(completed).toHaveLength(active === "dispatch" ? 4 : 3);
      for (const attempt of completed) expect(h.events.filter(event => event === `report:${attempt.id}`)).toHaveLength(1);
    });
  }

  it("fresh:true waits for the active turn before resetting for the next directive", async () => {
    const h = await fixture();
    await h.enqueue("active", "active", 0);
    await h.watcher.start({ waitForInitialDispatches: false });
    await vi.waitFor(() => expect(h.events).toContain("start:active"));
    await h.send(true);
    const urgent = h.watcher.tick();
    await vi.waitFor(() => expect(h.watcher.inFlightIdsForTarget(target)).toHaveLength(2));
    expect.soft(h.invalidate).not.toHaveBeenCalled();
    expect.soft(h.abortTurn).not.toHaveBeenCalled();
    h.held.release();
    await urgent;
    await h.watcher.drain();
    expect(h.events.filter(event => !event.startsWith("report:"))).toEqual([
      "start:active", "end:active", "reset", "start:interrupt", "end:interrupt",
    ]);
    expect(h.contexts.get("interrupt")).toBe("");
  });

  it("keeps next-turn priority in SQL when the controller has not started its watcher yet", async () => {
    const h = await fixture();
    await h.enqueue("z-first", "first", 1);
    await h.enqueue("a-second", "second", 2);
    await h.send();
    await h.watcher.start();
    h.watcher.stop();
    await h.watcher.drain();
    expect(h.events.filter(event => event.startsWith("start:"))).toEqual([
      "start:interrupt", "start:first", "start:second",
    ]);
  });

  it("a second directive accepted during the first runs next without waiting for another poll", async () => {
    const h = await fixture();
    const firstHeld = gate();
    h.holds.set("interrupt", firstHeld.promise);
    await h.enqueue("active", "active", 0);
    await h.watcher.start({ waitForInitialDispatches: false });
    await vi.waitFor(() => expect(h.events).toContain("start:active"));
    await h.enqueue("z-first", "first", 1);
    await h.enqueue("a-second", "second", 2);
    const queued = h.watcher.tick();
    await vi.waitFor(() => expect(h.watcher.inFlightIdsForTarget(target)).toHaveLength(3));
    await h.send();
    h.held.release();
    const firstPoll = h.watcher.tick();
    await vi.waitFor(() => expect(h.events).toContain("start:interrupt"));
    await h.send(false, "do the second urgent task");
    firstHeld.release();
    await Promise.all([queued, firstPoll]);
    await h.watcher.tick();
    await h.watcher.drain();
    expect(h.events.filter(event => event.startsWith("start:"))).toEqual([
      "start:active", "start:interrupt", "start:interrupt2", "start:first", "start:second",
    ]);
  });
});
