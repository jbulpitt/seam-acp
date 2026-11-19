import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { asLocalAdapter, manifestCatalogSource } from "@seam/adapters";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SeamMcpServer } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import { enqueueDispatchSpec, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { InjectTurnOptions, InjectTurnResult } from "../packages/core/src/core/inject-turn.js";
import type { Preset, SessionRecord, StructuredPanel } from "../packages/core/src/core/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const logger = pino({ level: "silent" }) as unknown as Logger;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-scoped-handoff-"));
  const store = new SessionStore(":memory:");
  const profiles = ["agy", "codex"].map(id => asLocalAdapter({
    id, displayName: `Fixture ${id}`, defaultModel: "caller-model",
    harness: "unknown", provider: "fixture", account: { provenance: "unknown" },
    effort: { mechanism: "configOption", configId: "effort", levels: ["low", "high"] },
    catalog: manifestCatalogSource({
      provider: "fixture", defaultModel: "caller-model", adapterVersion: 4,
      models: () => [{ modelId: "caller-model", name: "Caller model" }],
    }),
    spawn: () => { throw new Error("fixture uses controlled bridge RPC"); },
  }));
  const modelCatalog = fixtureModelCatalog(profiles);
  const threadPresets = new Map([["fixture-thread", { location: "fixture-host" }]]);
  const router = new SessionRouter({
    logger, store, profiles, modelCatalog, defaultAgentId: "codex", defaultModel: "caller-model",
    defaultCwd: root, threadPresets,
  });
  const caller = router.ensureSessionRecord({
    platform: "discord", channelRef: "fixture-thread", parentRef: "project-a", cwd: root,
  });
  const panels: StructuredPanel[] = [];
  let nextMessage = 0;
  const adapter = {
    async sendPanel(channel: unknown, panel: StructuredPanel) {
      panels.push(panel); return { channel, id: `fixture-message-${++nextMessage}` };
    },
    async editPanel(_ref: unknown, panel: StructuredPanel) { panels.push(panel); },
    async sendMessage(channel: unknown, _text: string) { return { channel, id: `fixture-message-${++nextMessage}` }; },
  };
  const orch = new Orchestrator({
    logger, store, router, modelCatalog, adapter: adapter as any, renderer: discordRenderer,
    config: {
      DATA_DIR: root, REPOS_ROOT: root, TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_AGENT: "codex", DEFAULT_MODEL: "caller-model", SEAM_DISPATCH_STATUS_PANEL: true,
      REPO_EMOJIS: new Map(),
      SEAM_DISPATCH_OUTPUT_STYLE: "messages", channelPresets: new Map(), threadPresets,
    } as any,
  });
  const requests: Array<Record<string, unknown>> = [];
  let slot = 0;
  orch.setBridgeHub({
    isBridgeReady: () => true, defaultCwdForLocation: () => root,
    markSessionBridge: vi.fn(), mcpServersForBridgeSpawn: () => undefined,
    get: () => ({ mux: {
      spawn: () => Object.assign(new EventEmitter(), {
        slot: ++slot, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
      }),
      rpc: async (method: string, params: Record<string, unknown>) => {
        if (method === "spawn") requests.push(params);
        return { ok: true };
      },
      releaseStdin: vi.fn(),
    } }),
  } as any);
  const inject = vi.spyOn(orch as unknown as {
    injectTurn(record: SessionRecord, prompt: string, opts: InjectTurnOptions): Promise<InjectTurnResult>;
  }, "injectTurn").mockImplementation(async (_record, _prompt, opts) => {
    await opts.spawnFn?.(opts.model, opts.effort);
    await opts.onSession?.("fixture-acp");
    opts.lifecycle?.beforePrompt();
    const result = { text: "FIXTURE_DONE", stopReason: "end_turn" };
    opts.lifecycle?.onOutcome(result);
    return result;
  });
  const admitted: DispatchSpec[] = [];
  const mcp = new SeamMcpServer({
    logger, resolveSession: token => token === "fixture-token" ? caller : undefined,
    resolveThread: id => store.getByChannel("discord", id) ?? undefined,
    getThreadLiveState: async () => ({ locked: false, archived: false }),
    enqueueDispatch: async spec => {
      await enqueueDispatchSpec(root, spec, store.turnAttempts); admitted.push(spec);
    },
  });
  cleanups.push(async () => {
    await mcp.stop(); await router.disposeAll(); store.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  await mcp.start();
  function preset(name: string, projectRef: string | null, overrides: Partial<Preset> = {}) {
    const row: Preset = {
      id: `fixture-${projectRef ?? "global"}-${name}`, name, projectRef,
      description: null, agentId: "agy", model: "scoped-model", effort: "high",
      repoPath: path.join(root, "preset-repo"), instructions: "FIXTURE_PRESET_IDENTITY",
      role: null, disableThreadPrefix: null, permission: null, toolsAllow: null, toolsExclude: null,
      statusCardStyle: null, createdBy: "fixture-author", createdUtc: "2026-01-01T00:00:00Z",
      updatedUtc: "2026-01-01T00:00:00Z", ...overrides,
    };
    store.upsertPreset(row); return row;
  }
  async function handoff(worker: string, token = "fixture-token") {
    const response = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", "X-Seam-Session": token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "handoff", arguments: { worker, prompt: "fixture task", reportBack: false } } }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function admit(worker: string) {
    expect((await handoff(worker)).body).not.toHaveProperty("error");
    expect(admitted).toHaveLength(1);
    return admitted[0]!;
  }
  return { root, store, router, caller, orch, panels, requests, inject, admitted, preset, handoff, admit };
}

describe("scoped preset handoff admission and selection", () => {
  it("shows the qualified preset identity and defaults on the queued card", async () => {
    const f = await fixture();
    const preset = f.preset("reviewer", "project-b");
    const spec = await f.admit("project-b/reviewer");
    await f.orch.observeQueuedDispatch(spec);
    expect(f.store.turnAttempts.get(spec.id)?.statusCardState?.status.input).toMatchObject({
      model: preset.model, effort: preset.effort, repoDisplay: "preset-repo", authorName: "Fixture agy",
    });
    expect(f.panels).toHaveLength(1);
    expect(f.inject).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });

  it.each(["project-b/reviewer", "reviewer", "global-only", "missing-project/global-only"])(
    "resolves %s from ordinary MCP admission through the bridge spawn request", async worker => {
      const f = await fixture();
      f.preset("reviewer", null, { agentId: "codex", model: "global-model" });
      f.preset("reviewer", "project-a");
      f.preset("reviewer", "project-b", { model: "other-project-model" });
      f.preset("global-only", null, { agentId: "codex", model: null, effort: null, repoPath: null, instructions: null });
      const selected = f.store.getPresetByNameScoped(worker, f.caller.parentRef)!;
      const spec = await f.admit(worker);
      await f.orch.observeQueuedDispatch(spec);
      const queued = f.store.turnAttempts.get(spec.id)?.statusCardState?.status.input;
      await expect(f.orch.dispatchInjectTurn(spec)).resolves.toMatchObject({ output: "FIXTURE_DONE" });
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]).toMatchObject({
        agentId: selected.agentId, model: selected.model ?? "caller-model", cwd: selected.repoPath ?? f.root,
        ...(selected.effort ? { effort: selected.effort } : {}),
      });
      expect(queued).toMatchObject({ model: f.requests[0]!.model, authorName: `Fixture ${selected.agentId}` });
      expect(f.inject).toHaveBeenCalledTimes(1);
      if (selected.instructions) expect(f.inject.mock.calls[0]![1]).toContain(selected.instructions);
      expect(f.store.turnAttempts.get(spec.id)?.state).toBe("completed");
    },
  );

  it("keeps direct agent@host handoffs and ordinary live/default handoffs", async () => {
    for (const worker of ["codex@other-host", "fixture-thread"]) {
      const f = await fixture();
      const spec = await f.admit(worker);
      await expect(f.orch.dispatchInjectTurn(spec)).resolves.toMatchObject({ output: "FIXTURE_DONE" });
      if (worker.includes("@")) {
        expect(spec).toMatchObject({ preset: "codex", location: "other-host", session: "isolated" });
        expect(f.requests).toEqual([expect.objectContaining({ agentId: "codex", model: "caller-model", cwd: f.root })]);
      } else {
        expect(spec).toMatchObject({ target: "fixture-thread", session: "live" });
        expect(spec.preset).toBeUndefined(); expect(f.requests).toEqual([]);
      }
    }
  });

  it("applies the existing agent restriction to the caller channel, not the qualified preset scope", async () => {
    const f = await fixture();
    f.preset("reviewer", "project-b");
    f.store.recordConfigMutation({
      id: "fixture-restriction", tier: "agent-channel-restriction", scope: "agent-channel-restriction:agy",
      summary: "fixture restriction", beforeJson: JSON.stringify({ restriction: null }),
      afterJson: JSON.stringify({ restriction: { agentId: "agy", allowedChannelIds: ["project-b"] } }),
    });
    const spec = await f.admit("project-b/reviewer");
    await expect(f.orch.dispatchInjectTurn(spec)).rejects.toThrow('agent "agy" cannot run in channel "project-a"');
    expect(f.inject).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
  });

  it("does not admit an unauthenticated handoff or borrow an unrelated scoped-only preset", async () => {
    const f = await fixture();
    f.preset("foreign-only", "project-b");
    expect((await f.handoff("project-b/foreign-only", "wrong-fixture-token")).body)
      .toMatchObject({ error: { code: -32001 } });
    expect(f.admitted).toEqual([]);
    const spec = await f.admit("foreign-only");
    await expect(f.orch.dispatchInjectTurn(spec)).rejects.toThrow('unknown preset "foreign-only"');
    expect(f.inject).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
  });
});
