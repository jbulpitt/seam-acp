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

async function fixture() {
  const record = (channelRef: string): SessionRecord => ({
    id: `discord:${channelRef}`, platform: "discord", channelRef, parentRef: parent,
    agentId: "claude", acpSessionId: "original-context", repoPath: dir, configJson: "{}",
    createdUtc: new Date().toISOString(), updatedUtc: new Date().toISOString(),
  });
  store.upsert(record(target));
  store.upsert(record(callerRef));
  const events: string[] = [];
  const abortTurn = vi.fn(async () => "cancelled" as const);
  const invalidate = vi.fn(async () => { events.push("reset"); });
  const router = testSessionRouter({
    listProfiles: () => [], getProfile: () => ({ id: "claude" }), hasRuntime: () => true,
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
  // Only provider execution/Discord rendering are synthetic; both queue layers and SQL are real.
  (orch as any).injectTurn = async (_record: SessionRecord, prompt: string) => {
    const name = prompt.includes("<seam-interrupt>") ? "interrupt" : ["active", "first", "second"].find(value => prompt.includes(`JOB_${value}`))!;
    events.push(`start:${name}`);
    if (name === "active") await held.promise;
    events.push(`end:${name}`);
    return { text: `DONE_${name}`, stopReason: "end_turn" };
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
  const send = async (fresh = false) => {
    const response = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, { method: "POST",
      headers: { "content-type": "application/json", "X-Seam-Session": "fixture-caller" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "send", arguments: { to: target, message: "do the urgent task", interrupt: true, fresh } } }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.error).toBeUndefined();
    expect(body.result.isError, body.result.content[0]?.text).toBeFalsy();
    return body.result.content[0].text as string;
  };
  const enqueue = (id: string, name: string, second: number) => enqueueDispatchSpec(dir, {
    id, target, prompt: `JOB_${name}`, session: "live", kind: "handoff", returnTo: callerRef,
    createdUtc: `2026-01-01T00:00:0${second}.000Z`,
  }, store.turnAttempts);
  return { orch, watcher, send, enqueue, events, held, abortTurn, invalidate };
}

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
      await h.enqueue("z-first", "first", 1);
      await h.enqueue("a-second", "second", 2);
      const queued = h.watcher.tick();
      await vi.waitFor(() => expect(h.watcher.inFlightIdsForTarget(target)).toEqual(expect.arrayContaining(["z-first", "a-second"])));
      const receipt = await h.send();
      const urgent = h.watcher.tick();
      await vi.waitFor(() => expect(h.watcher.inFlightIdsForTarget(target).length).toBe(active === "dispatch" ? 4 : 3));
      expect.soft(h.abortTurn).not.toHaveBeenCalled();
      expect.soft(h.events.filter(event => event.startsWith("start:"))).toEqual(["start:active"]);
      expect.soft(receipt).toContain("Running work is not cancelled");
      h.held.release();
      await Promise.all([activeRun, queued, urgent]);
      await h.watcher.drain();
      expect(h.events.filter(event => event.startsWith("start:") || event.startsWith("end:"))).toEqual([
        "start:active", "end:active", "start:interrupt", "end:interrupt",
        "start:first", "end:first", "start:second", "end:second",
      ]);
      for (const id of ["z-first", "a-second", ...(active === "dispatch" ? ["active"] : [])]) {
        expect(store.turnAttempts.get(id)?.state).toBe("completed");
        expect(h.events).toContain(`report:${id}`);
      }
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
});
