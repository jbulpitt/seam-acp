import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import { PresetsFileSchema, threadPresetKey, type Config, type ThreadPreset } from "../packages/core/src/config.js";
import { createConfigFacades } from "../packages/core/src/core/config-apply-plan.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { executeGoogleChatCommand } from "../packages/core/src/platforms/google-chat/command-actions.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { localBridgeWiring } from "./local-bridge-fixture.js";

// Only the provider is synthetic; overlays, audit, binding and transitions are real.
vi.mock("../packages/core/src/agents/agent-runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../packages/core/src/agents/agent-runtime.js")>();
  return { ...actual, AgentRuntime: class {
    busy = false;
    disposed = false;
    sessionId = "";
    lastActivityAtMs = Date.now();
    modelOverride?: string;
    effortOverride?: string;
    cwd = "";
    finishPrompt?: () => void;
    constructor(readonly options: { profile: AgentProfile }) {}
    async start() {}
    markActivity() { this.lastActivityAtMs = Date.now(); }
    async loadSession(input: { sessionId: string; cwd: string; model?: string; effort?: string }) {
      this.sessionId = input.sessionId; this.cwd = input.cwd; this.modelOverride = input.model; this.effortOverride = input.effort;
    }
    async newSession(input: { cwd: string; model?: string; effort?: string }) {
      this.sessionId = "new-context"; this.cwd = input.cwd; this.modelOverride = input.model; this.effortOverride = input.effort;
      return { sessionId: this.sessionId };
    }
    getSessionInfo() { return { sessionId: this.sessionId, currentModelId: this.modelOverride }; }
    async dispose() { this.disposed = true; }
    async setModel(model: string) { this.modelOverride = model; }
    async setConfigOption(_id: string, value: string) { this.effortOverride = value; }
    getConfigSelectValues() { return ["low", "high", "provider-special"]; }
    async prompt() {
      this.busy = true;
      try {
        await new Promise<void>(resolve => { this.finishPrompt = resolve; });
        return { cwd: this.cwd, effort: this.effortOverride };
      } finally { this.busy = false; }
    }
  } };
});

const logger = pino({ level: "silent" });
const actor = { id: "users/42", name: "Tester" };
const channel = { platform: "google-chat", id: "dm.thread", parentId: "dm" };
const root = "/execution/projects";
const oldCwd = `${root}/old`;
const nextCwd = `${root}/other repo`;
const profile = { id: "codex", defaultModel: "native", staticModels: [{ modelId: "native", name: "Native" }],
  effort: { mechanism: "configOption", configId: "effort", levels: ["low", "high", "provider-special"] } } as unknown as AgentProfile;
let dir: string;
let store: SessionStore;
let router: SessionRouter;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gchat-session-config-"));
  store = new SessionStore(path.join(dir, "seam.db"));
});
afterEach(async () => { await router?.disposeAll(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function fixture() {
  const modelCatalog = fixtureModelCatalog([profile]);
  const presetsFile = path.join(dir, "presets.json");
  const key = threadPresetKey(channel.platform, channel.id);
  fs.writeFileSync(presetsFile, JSON.stringify({ threads: { [key]: { location: "remote", cwd: { value: oldCwd } } } }));
  const threadPresets = new Map<string, ThreadPreset>([[channel.id, { location: "remote", cwd: { value: oldCwd } }]]);
  const wiring = localBridgeWiring([profile]);
  // Record the real host selection, while the fake provider stays non-live.
  const bound = new Map<string, string>();
  const bridge = {
    ...wiring,
    bindSessionLocation: (id: string, location: string) => bound.set(id, location),
    locationForSession: (id: string) => bound.get(id),
    get: vi.fn(() => ({ host: { workspaceRoot: root } })),
    listWorkspaces: vi.fn(async () => [{ path: oldCwd }, { path: nextCwd }]),
    hostExec: vi.fn(async (_location: string, input: { cwd?: string }) => {
      if (input.cwd !== oldCwd && input.cwd !== nextCwd) throw new Error(`spawn /bin/sh ENOENT: ${input.cwd}`);
      return { stdout: `${input.cwd}\n`, stderr: "", exitCode: 0, signal: null, timedOut: false };
    }),
  };
  router = new SessionRouter({ store, logger, profiles: [profile], modelCatalog, threadPresets,
    defaultAgentId: "codex", defaultModel: "native", defaultCwd: "/controller/projects",
    seamMcp: wiring, executionBridge: bridge as any, bindSessionLocation: bridge.bindSessionLocation });
  const row = router.ensureSessionRecord({ platform: channel.platform, channelRef: channel.id, parentRef: channel.parentId, cwd: "/controller/projects" });
  store.upsert({ ...row, acpSessionId: "existing-context", configJson: JSON.stringify({ model: "native", reasoningEffort: "low" }) }, { source: "fixture", cause: "existing provider session" });
  const record = store.get(row.id)!;
  const mutation = new ConfigMutationService({ store, logger, modelCatalog, presetsFile,
    describeConfig: row => router.describeConfig(row), isAgentAvailable: id => !!router.getProfile(id),
    reloadPresets: () => {
      const doc = PresetsFileSchema.parse(JSON.parse(fs.readFileSync(presetsFile, "utf8")));
      threadPresets.clear();
      for (const [id, preset] of Object.entries(doc.threads ?? {})) threadPresets.set(id.replace(/^google-chat:/, ""), preset);
      return { ok: true };
    } });
  const { plan, runtime } = createConfigFacades({ store, router, mutation, modelCatalog, logger, bridgeHub: bridge as any,
    config: { REPOS_ROOT: "/controller/projects", channelPresets: new Map(), threadPresets } as Config,
    identityCommitted: async () => {}, persistConfig: () => {}, repoDisplay: repo => repo ?? "",
    unregisteredAgentMessage: (_id, fallback) => fallback });
  const deps = { channelFor: () => channel, createThread: vi.fn(), store, router, mutation,
    runtimeTransition: runtime, configPlan: plan, modelCatalog, cwd: "/controller/projects", location: "local",
    cancelChannel: vi.fn(), respond: vi.fn(async () => {}) } as any;
  const run = (command: "repo" | "effort", args: string) => executeGoogleChatCommand({ command, args, user: actor,
    space: "spaces/dm", thread: "spaces/dm/threads/thread" } as any, deps);
  return { record, mutation, plan, bridge, run, threadPresets, presetsFile, respond: deps.respond };
}

describe("Google Chat per-session repo and effort", () => {
  it("persists cwd under the Google Chat overlay, using the bound host root rather than controller REPOS_ROOT", async () => {
    const h = await fixture();
    const result = await h.run("repo", "other repo");
    expect(result).toMatchObject({ command: "repo", outcome: { ok: true, sessionReset: true, resetPending: false } });
    expect(JSON.parse(fs.readFileSync(h.presetsFile, "utf8")).threads[threadPresetKey(channel.platform, channel.id)].cwd.value).toBe(nextCwd);
    expect(h.bridge.hostExec).toHaveBeenCalledWith("remote", expect.objectContaining({ cwd: nextCwd }));
    expect(store.get(h.record.id)?.repoPath).toBeNull();
    expect(store.get(h.record.id)?.acpSessionId).toBe("");
    expect(store.listConfigMutations()).toEqual([expect.objectContaining({ actorId: actor.id, actorName: actor.name })]);
    const next = await router.getOrStartRuntime(store.get(h.record.id)!);
    expect((next as any).cwd).toBe(nextCwd);
    expect(next.getSessionInfo()?.sessionId).toBe("new-context");
  });

  it("finishes the running turn in the old cwd, then replaces context before the next turn", async () => {
    const h = await fixture();
    const warm = await router.getOrStartRuntime(h.record);
    const running = warm.prompt("Keep working");
    expect(await h.run("repo", nextCwd)).toMatchObject({ outcome: { ok: true, sessionReset: false, resetPending: true } });
    expect((warm as any).disposed).toBe(false);
    expect(store.get(h.record.id)?.acpSessionId).toBe("existing-context");
    (warm as any).finishPrompt();
    expect(await running).toMatchObject({ cwd: oldCwd });
    const next = await router.getOrStartRuntime(store.get(h.record.id)!);
    expect((warm as any).disposed).toBe(true);
    expect((next as any).cwd).toBe(nextCwd);
    expect(next.getSessionInfo()?.sessionId).toBe("new-context");
  });

  it("does not reset an unchanged cwd", async () => {
    const h = await fixture();
    const warm = await router.getOrStartRuntime(h.record);
    expect(await h.run("repo", oldCwd)).toMatchObject({ outcome: { ok: true, sessionReset: false, resetPending: false } });
    expect(await router.getOrStartRuntime(store.get(h.record.id)!)).toBe(warm);
    expect(store.get(h.record.id)?.acpSessionId).toBe("existing-context");
  });

  it("returns the host's missing-directory cause without saving or resetting", async () => {
    const h = await fixture();
    const missing = `${root}/missing`;
    expect(await h.run("repo", missing)).toMatchObject({ outcome: { ok: false, error: `spawn /bin/sh ENOENT: ${missing}` } });
    expect(h.respond).toHaveBeenCalledWith(channel, `spawn /bin/sh ENOENT: ${missing}`);
    expect(router.describeConfig(store.get(h.record.id)!).cwd.value).toBe(oldCwd);
    expect(store.get(h.record.id)?.acpSessionId).toBe("existing-context");
    expect(store.listConfigMutations()).toHaveLength(0);
  });

  it("keeps the existing workspace-root refusal without saving", async () => {
    const h = await fixture();
    expect(await h.run("repo", "/outside/repo")).toMatchObject({ outcome: { ok: false, error: expect.stringContaining("outside host `remote` workspace root") } });
    expect(h.bridge.hostExec).not.toHaveBeenCalled();
    expect(store.listConfigMutations()).toHaveLength(0);
  });

  it("uses configure_thread for a catalog-specific effort with no context reset", async () => {
    const h = await fixture();
    const warm = await router.getOrStartRuntime(h.record);
    expect(await h.run("effort", "provider-special")).toMatchObject({ outcome: { ok: true, sessionReset: false } });
    expect((warm as any).effortOverride).toBe("provider-special");
    expect(store.get(h.record.id)?.acpSessionId).toBe("existing-context");
    expect(h.threadPresets.get(channel.id)?.effort?.value).toBe("provider-special");
    expect(store.listConfigMutations()).toEqual([expect.objectContaining({ actorId: actor.id })]);
  });

  it("surfaces the existing catalog refusal for invalid effort with no mutation", async () => {
    const h = await fixture();
    expect(await h.run("effort", "ultra")).toMatchObject({ outcome: { ok: false,
      error: "Effort \"ultra\" is not supported for codex/native. Valid values: default, low, high, provider-special." } });
    expect(store.get(h.record.id)?.acpSessionId).toBe("existing-context");
    expect(store.listConfigMutations()).toHaveLength(0);
  });
});
