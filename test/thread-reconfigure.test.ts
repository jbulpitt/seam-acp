import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import { PresetsFileSchema, type Config, type ThreadPreset } from "../packages/core/src/config.js";
import { createConfigFacades } from "../packages/core/src/core/config-apply-plan.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { ThreadReconfiguration } from "../packages/core/src/core/thread-reconfigure.js";
import type { BulkPlan, BulkRequest } from "../packages/core/src/plugins/thread-reconfigure/ports.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { localBridgeWiring } from "./local-bridge-fixture.js";

// The only synthetic execution boundary is the provider; selection, persistence,
// audit and runtime transitions below are production implementations.
vi.mock("../packages/core/src/agents/agent-runtime.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../packages/core/src/agents/agent-runtime.js")>();
  return { ...actual, AgentRuntime: class {
    modelOverride?: string;
    effortOverride?: string;
    disposed = false;
    busy = false;
    lastActivityAtMs = Date.now();
    sessionId = "";
    finishPrompt?: () => void;
    rejectPrompt?: (err: Error) => void;
    constructor(readonly options: { profile: AgentProfile }) {}
    async start() {}
    getPromptCapabilities() { return undefined; }
    markActivity() { this.lastActivityAtMs = Date.now(); }
    async loadSession(input: { sessionId: string }) { this.sessionId = input.sessionId; }
    async newSession() { this.sessionId = `fresh-${this.options.profile.id}`; return { sessionId: this.sessionId }; }
    getSessionInfo() { return { sessionId: this.sessionId, currentModelId: this.modelOverride }; }
    async detach() { await this.dispose(); }
    async dispose() {
      this.disposed = true;
      this.rejectPrompt?.(new Error("provider disposed during prompt"));
    }
    onEvent?: (event: unknown) => void;
    async prompt() {
      this.onEvent?.({ type: "agent-text", text: "before" });
      this.onEvent?.({ type: "tool-start", title: "read fixture" });
      this.busy = true;
      try {
        await new Promise<void>((resolve, reject) => {
          this.finishPrompt = resolve;
          this.rejectPrompt = reject;
        });
        this.onEvent?.({ type: "agent-text", text: "after" });
        return {
          stopReason: "end_turn", cancelled: false,
          agent: this.options.profile.id, model: this.modelOverride, effort: this.effortOverride,
        };
      } finally {
        this.busy = false;
        this.finishPrompt = this.rejectPrompt = undefined;
      }
    }
    async setModel(model: string) { this.modelOverride = model; }
    async setConfigOption(_id: string, value: string) { this.effortOverride = value; }
    fast = false;
    getFastModeOutcome() { return { requested: this.fast, applied: this.fast }; }
    getConfigSelectValues(id: string) { return id === "fast-mode" ? ["off", "on"] : []; }
    async setFastMode(value: boolean) { this.fast = value; }
  } };
});

const actor = { id: "operator", name: "Operator" };
const logger = pino({ level: "silent" });
const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function fixture(count = 3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-bulk-"));
  const store = new SessionStore(path.join(dir, "seam.db"));
  const threadPresets = new Map<string, ThreadPreset>();
  const profiles = ["claude", "codex", "copilot"].map(id => ({ id, defaultModel: "old",
    staticModels: ["old", "new"].map(modelId => ({ modelId, name: modelId })),
    effort: { mechanism: id === "claude" ? "configOption" : "meta", configId: "effort", levels: ["low", "high"] } })) as unknown as AgentProfile[];
  const catalog = fixtureModelCatalog(profiles);
  const config = { REPOS_ROOT: dir, CHANNEL_PRESETS_FILE: path.join(dir, "presets.json"),
    DISCORD_ALLOWED_USER_IDS: new Set([actor.id]), channelPresets: new Map(), threadPresets } as unknown as Config;
  const doc = { channels: { "200": { role: { value: "worker" } } }, threads: {} };
  fs.writeFileSync(config.CHANNEL_PRESETS_FILE!, JSON.stringify(doc));
  const router = new SessionRouter({ store, logger, profiles, modelCatalog: catalog, threadPresets,
    defaultAgentId: "claude", defaultModel: "old", defaultPermissionMode: "ask", seamMcp: localBridgeWiring(profiles) });
  const mutation = new ConfigMutationService({ store, logger, modelCatalog: catalog,
    describeConfig: record => router.describeConfig(record), presetsFile: config.CHANNEL_PRESETS_FILE,
    isAgentAvailable: id => !!router.getProfile(id), ollamaCloudEnabled: true,
    reloadPresets: () => { const parsed = PresetsFileSchema.parse(JSON.parse(fs.readFileSync(config.CHANNEL_PRESETS_FILE!, "utf8")));
      threadPresets.clear(); for (const [id, value] of Object.entries(parsed.threads ?? {})) threadPresets.set(id, value); return { ok: true }; } });
  const identity = vi.fn(async () => {});
  const facades = createConfigFacades({ store, router, mutation, modelCatalog: catalog, logger, config,
    identityCommitted: identity, persistConfig: (row, cfg) => store.upsert({ ...row, configJson: JSON.stringify(cfg) }),
    repoDisplay: repo => repo ?? "", unregisteredAgentMessage: (_id, fallback) => fallback, parkedSelectMessage: () => null });
  const meta = new Map<string, { name: string; parentId: string; guildId: string }>();
  const live = new Map<string, { locked: boolean; archived: boolean }>();
  for (let i = 0; i < count; i++) {
    const id = String(1000 + i); const parentId = i % 2 ? "201" : "200";
    const row = router.ensureSessionRecord({ platform: "discord", channelRef: id, parentRef: parentId, cwd: dir });
    store.upsert({ ...row, acpSessionId: `context-${id}`, configJson: JSON.stringify({ model: "old", reasoningEffort: "low", role: i % 2 ? "qa" : "worker" }) });
    meta.set(id, { name: `Fixture ${i}`, parentId, guildId: i % 2 ? "301" : "300" });
    live.set(id, { locked: false, archived: false });
  }
  const occupied = new Set<string>(); const denied = new Set<string>();
  const adapter = { configParentChannels: async () => [{ id: "200", name: "A", guildId: "300", guildName: "A" }, { id: "201", name: "B", guildId: "301", guildName: "B" }],
    configurationThread: vi.fn(async ({ id }: { id: string }) => meta.get(id)),
    getThreadLiveState: vi.fn(async ({ id }: { id: string }) => live.get(id)) };
  const service = new ThreadReconfiguration({ store, router, config, adapter: adapter as never,
    runtime: () => facades.runtime, plan: () => facades.plan, allowed: (who, parent) => who.id === actor.id && !denied.has(parent),
    busy: id => occupied.has(id) });
  const preview = async (request: BulkRequest = { scope: "all", targetModel: "new" }): Promise<BulkPlan> => ({
    id: "plan", actor, origin: "origin", request, ...await service.preview(actor, request) });
  closers.push(async () => { await router.disposeAll(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, router, service, preview, config, dir, meta, live, adapter, occupied, denied, identity, ...facades,
    row: (id = "1000") => store.getByChannel("discord", id)! };
}

describe("bulk thread configuration production facade", () => {
  it("previews uncapped multi-guild rows, intersects every selector and never starts a provider or writes config/audit", async () => {
    const h = await fixture(104); const starts = vi.spyOn(h.router, "getOrStartRuntime");
    const bytes = fs.readFileSync(h.config.CHANNEL_PRESETS_FILE!, "utf8");
    h.store.presets.recordApplication(h.row().id, { id: "named-id", name: "Old name", projectRef: "200" });
    expect((await h.preview()).rows).toHaveLength(104);
    expect((await h.preview({ scope: "guild", scopeId: "301", targetModel: "new" })).rows).toHaveLength(52);
    const filtered = await h.preview({ scope: "channel", scopeId: "200", agent: "claude", model: "old", role: "worker", name: "fIXTURE 0",
      preset: "named-id", presetScope: "200", targetModel: "new" });
    expect(filtered.rows.map(r => r.before.id)).toEqual(["1000"]);
    expect((await h.preview({ ...filtered.request, presetScope: undefined })).rows).toEqual([]);
    expect(starts).not.toHaveBeenCalled(); expect(h.store.listConfigMutations()).toEqual([]);
    expect(fs.readFileSync(h.config.CHANNEL_PRESETS_FILE!, "utf8")).toBe(bytes);
  });
  it("excludes unauthorized metadata, includes quiet threads and reports archive/gone/read failures without inventing preset membership", async () => {
    const h = await fixture(6); h.denied.add("201"); h.live.set("1000", { archived: true, locked: false });
    h.meta.delete("1002"); h.adapter.configurationThread.mockImplementation(async ({ id }) => { if (id === "1004") throw new Error("Discord unavailable"); return h.meta.get(id); });
    const p = await h.preview();
    expect(p.rows).toMatchObject([{ before: { id: "1000", preset: null }, status: "skipped", reason: "archived" }]);
    expect(p.notes.join(" ")).toContain("gone"); expect(p.notes.join(" ")).toContain("Discord unavailable");
    expect(h.adapter.configurationThread.mock.calls.map(([v]) => v.id).sort()).toEqual(["1000", "1002", "1004"]);
  });
  it("keeps existing channel authorization authoritative instead of adding a Discord thread-lock policy", async () => {
    const h = await fixture(1); h.live.set("1000", { locked: true, archived: false });
    const p = await h.preview(); expect(p.rows[0].status).toBe("eligible");
    expect((await h.service.apply(actor, p))[0].status).toBe("changed");
  });
  it("applies both shared-file rows, preserves defaults and scoped identity history, and leaves no-op runtimes untouched", async () => {
    const h = await fixture(2); const p = await h.preview();
    const result = await h.service.apply(actor, p);
    expect(result.map(r => r.status)).toEqual(["changed", "changed"]);
    const written = JSON.parse(fs.readFileSync(h.config.CHANNEL_PRESETS_FILE!, "utf8"));
    expect(Object.keys(written.threads).sort()).toEqual(["1000", "1001"]);
    expect(written.channels).toEqual({ "200": { role: { value: "worker" } } });
    expect(h.store.listConfigMutations()).toHaveLength(2); expect(h.identity).toHaveBeenCalledTimes(2);
    const again = await h.preview();
    expect(again.rows.every(r => r.status === "unchanged"), JSON.stringify(again.rows)).toBe(true);
  });
  it("keeps an unresolved original prompt and its text/tool output ownership while busy rows are skipped", async () => {
    const h = await fixture(1); const p = await h.preview();
    const runtime = await h.router.getOrStartRuntime(h.row()); const events: unknown[] = [];
    const handler = (event: unknown) => events.push(event); runtime.onEvent = handler as never;
    const running = runtime.prompt("fixture");
    const original = h.store.get(h.row().id);
    expect((await h.service.apply(actor, p))[0]).toMatchObject({ status: "skipped", reason: "busy or changed during preparation" });
    expect(h.store.get(h.row().id)).toEqual(original); expect(h.router.getRuntime(h.row().id)).toBe(runtime);
    expect(runtime.onEvent).toBe(handler); expect((runtime as any).disposed).toBe(false);
    (runtime as any).finishPrompt(); expect(await running).toMatchObject({ cancelled: false, stopReason: "end_turn" });
    expect(events).toEqual([{ type: "agent-text", text: "before" }, { type: "tool-start", title: "read fixture" }, { type: "agent-text", text: "after" }]);
  });
  it("does not revisit preview-busy rows after they become idle", async () => {
    const h = await fixture(1); h.occupied.add("1000"); const p = await h.preview();
    h.occupied.clear(); expect((await h.service.apply(actor, p))[0].status).toBe("skipped");
    expect(h.router.describeConfig(h.row()).model.value).toBe("old"); expect(h.store.listConfigMutations()).toEqual([]);
  });
  it("uses D10 when a prompt starts immediately after the audited save, then resets agent context only on next acquisition", async () => {
    const h = await fixture(1); const runtime = await h.router.getOrStartRuntime(h.row());
    const originalSession = h.store.get(h.row().id)!.acpSessionId;
    const p = await h.preview({ scope: "all", targetAgent: "codex", targetModel: "new" });
    expect(p.rows[0].consequence).toBe("reset");
    let running: ReturnType<typeof runtime.prompt> | undefined;
    const apply = h.plan.applyTargetIdentity.bind(h.plan);
    vi.spyOn(h.plan, "applyTargetIdentity").mockImplementation((...args) => { const result = apply(...args); running = runtime.prompt("race"); return result; });
    expect((await h.service.apply(actor, p))[0]).toMatchObject({ status: "changed", saved: true, runtime: "pending" });
    expect((runtime as any).disposed).toBe(false); expect(h.store.get(h.row().id)?.acpSessionId).toBe(originalSession);
    (runtime as any).finishPrompt(); await running;
    const acquired = await h.router.getOrStartRuntime(h.row());
    expect(acquired.getSessionInfo()?.sessionId).toBe("fresh-codex"); expect((runtime as any).disposed).toBe(true);
  });
  it("previews and preserves the catalog Fast fresh-session consequence for model-only changes", async () => {
    const h = await fixture(1);
    Object.assign(h.router.getProfile("claude")!, { fastMode: { configId: "fast-mode", onValue: "on", offValue: "off", applicationMode: "freshSession" } });
    expect(h.plan.applyThreadOverlay({ threadId: "1000", parentRef: "200", changes: { fastMode: true }, actor }).ok).toBe(true);
    const p = await h.preview(); expect(p.rows[0]).toMatchObject({ consequence: "reset", after: { fastMode: true } });
    const starts = vi.spyOn(h.router, "getOrStartRuntime");
    expect((await h.service.apply(actor, p))[0]).toMatchObject({ status: "changed", runtime: "next-acquisition" });
    expect(h.store.get(h.row().id)!.acpSessionId).toBe(""); expect(starts).not.toHaveBeenCalled();
  });
  it("retains first native failure and saved state, and still changes an independent sibling", async () => {
    const h = await fixture(2); const runtime = await h.router.getOrStartRuntime(h.row());
    vi.spyOn(runtime, "setModel").mockRejectedValue(new Error("native model refused"));
    const result = await h.service.apply(actor, await h.preview());
    expect(result.find(r => r.before.id === "1000")).toMatchObject({ status: "failed", saved: true, runtime: "unverified", reason: "native model refused" });
    expect(result.find(r => r.before.id === "1001")!.status).toBe("changed"); expect(h.router.describeConfig(h.row()).model.value).toBe("new");
  });
  it("reports an interrupted save as unknown rather than reconstructing success or claiming no write", async () => {
    const h = await fixture(1); const p = await h.preview(); const original = h.plan.applyTargetIdentity.bind(h.plan);
    vi.spyOn(h.plan, "applyTargetIdentity").mockImplementation((...args) => { original(...args); throw new Error("mirror interrupted"); });
    const result = await h.service.apply(actor, p);
    expect(result[0]).toMatchObject({ status: "failed", runtime: "unverified", reason: "mirror interrupted" });
    expect(result[0].saved).toBeUndefined(); expect(h.store.listConfigMutations()).toHaveLength(1);
  });
  it("skips stale previews and per-target policy changes at commit", async () => {
    const h = await fixture(2); const p = await h.preview();
    h.meta.get("1000")!.name = "Renamed"; h.denied.add("201");
    expect((await h.service.apply(actor, p)).map(r => r.status)).toEqual(["skipped", "skipped"]);
    expect(h.store.listConfigMutations()).toEqual([]);
  });
  it("records exact last named-preset application at the shared successful boundary; later edits preserve history", async () => {
    const h = await fixture(1); expect(h.store.presets.getApplication(h.row().id)).toBeNull();
    const preset = { id: "preset-1", name: "Scoped", projectRef: "200", role: "qa", disableThreadPrefix: null } as any;
    await h.plan.applyPresetToSession({ platform: "discord", id: "1000", parentId: "200" }, h.row(), preset);
    expect(h.store.presets.getApplication(h.row().id)).toMatchObject({ id: "preset-1", projectRef: "200", name: "Scoped" });
    const p = await h.preview({ scope: "all", targetModel: "new", preset: "preset-1", presetScope: "200" });
    expect(p.rows).toHaveLength(1); await h.service.apply(actor, p);
    expect(h.store.presets.getApplication(h.row().id)).toMatchObject({ id: "preset-1", name: "Scoped" });
    h.store.upsert({ ...h.row(), configJson: "{}" });
    expect(h.store.presets.getApplication(h.row().id)).toMatchObject({ id: "preset-1", name: "Scoped", projectRef: "200" });
  });
});
