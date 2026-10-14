import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCodexProfile, type AgentProfile } from "@seam/adapters";
import { pino } from "pino";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { controllerMetadataAdapter } from "../packages/core/src/agents/controller-metadata.js";
import { checkFastModeEligibility, describeFastModeOutcome, fastModeNeedsFreshSession } from "../packages/core/src/core/fast-mode.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { googleChatStatusPanel } from "../packages/core/src/platforms/google-chat/status-panel.js";
import { testSessionRouter, testSessionStore } from "./helpers/session-fixture.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { RuntimeTransition } from "../packages/core/src/core/runtime-transition.js";
import type { ConfigDescription } from "../packages/core/src/core/session-router.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";

const spec = { configId: "fast-mode", onValue: "on", offValue: "off", applicationMode: "live" } as const;
afterEach(() => { vi.unstubAllEnvs(); });

function runtime(optionType: "select" | "boolean" | "missing" = "select") {
  let enabled = false;
  const options = () => optionType === "missing" ? [] : [{
    id: "fast-mode", name: "Fast mode", category: "model_config", type: optionType,
    currentValue: optionType === "boolean" ? enabled : enabled ? "on" : "off",
    ...(optionType === "select" ? { options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] } : {}),
  }];
  const connection = {
    newSession: vi.fn(async () => ({ sessionId: "codex-existing", configOptions: options(), models: { currentModelId: "gpt-fast", availableModels: [] } })),
    loadSession: vi.fn(async () => ({ sessionId: "codex-existing", configOptions: options(), models: { currentModelId: "gpt-fast", availableModels: [] } })),
    setSessionConfigOption: vi.fn(async (input: { configId: string; value: string | boolean }) => {
      enabled = input.value === "on" || input.value === true;
      return { configOptions: options() };
    }),
  };
  const rt = new AgentRuntime({ profile: { id: "codex", defaultModel: "gpt-fast", fastMode: spec } as unknown as AgentProfile,
    logger: pino({ level: "silent" }), spawnFn: () => { throw new Error("not used"); } });
  Object.assign(rt, { connection, promptCapabilities: {} });
  return { rt, connection };
}

describe("Codex Fast wire capability", () => {
  it("declares the direct Codex descriptor, not the reused Ollama profile", () => {
    expect(makeCodexProfile({ defaultModel: "default" }).fastMode).toEqual(spec);
    expect(makeCodexProfile({ id: "ollama-cloud", defaultModel: "qwen" }).fastMode).toBeUndefined();
  });

  it("derives Codex controller metadata without a Claude-only fallback", () => {
    const profile = makeCodexProfile({ defaultModel: "default" });
    expect(controllerMetadataAdapter({ id: "codex", catalog: profile.catalog }).fastMode).toEqual(spec);
  });

  it("does not apply Claude's environment kill switch to Codex", () => {
    expect(checkFastModeEligibility({ requested: true, agentId: "codex", descriptor: spec,
      env: { CLAUDE_CODE_DISABLE_FAST_MODE: "1" } })).toEqual({ ok: true });
  });

  it("requires no fresh ACP session for Codex on/off", () => {
    expect(fastModeNeedsFreshSession({ descriptor: spec, nextFastMode: true, fastModeChanged: true } as never)).toBe(false);
    expect(fastModeNeedsFreshSession({ descriptor: spec, nextFastMode: false, fastModeChanged: true } as never)).toBe(false);
  });

  it("leaves default/off silent", async () => {
    const { rt, connection } = runtime();
    await rt.newSession({ cwd: "/repo" });
    expect(connection.setSessionConfigOption).not.toHaveBeenCalled();
    expect(rt.getFastModeOutcome()).toEqual({ requested: false, applied: false });
  });

  it.each(["select", "boolean"] as const)("applies live on/off with the actual %s wire value, preserving ACP", async type => {
    const { rt, connection } = runtime(type);
    await rt.newSession({ cwd: "/repo" });
    expect(typeof (rt as any).setFastMode).toBe("function");
    await (rt as any).setFastMode(true);
    expect(rt.getFastModeOutcome()).toEqual({ requested: true, applied: true });
    await (rt as any).setFastMode(true);
    await (rt as any).setFastMode(false);
    expect(rt.getFastModeOutcome()).toEqual({ requested: false, applied: false });
    expect(connection.setSessionConfigOption.mock.calls.map(([input]) => [input.configId, input.value]))
      .toEqual([["fast-mode", type === "boolean" ? true : "on"], ["fast-mode", type === "boolean" ? false : "off"]]);
    expect(rt.getSessionInfo()?.sessionId).toBe("codex-existing");
    expect(connection.newSession).toHaveBeenCalledTimes(1);
  });

  it("restores the persisted Codex request on resume without a fresh session", async () => {
    const { rt, connection } = runtime();
    await rt.loadSession({ cwd: "/repo", sessionId: "codex-existing", fastMode: true });
    expect(connection.setSessionConfigOption).toHaveBeenCalledWith({ sessionId: "codex-existing", configId: "fast-mode", value: "on" });
    expect(rt.getFastModeOutcome()).toEqual({ requested: true, applied: true });
    expect(connection.newSession).not.toHaveBeenCalled();
  });

  it("offers Fast only when the live current session advertises it", async () => {
    const { rt, connection } = runtime("missing");
    await rt.newSession({ cwd: "/repo" });
    expect(typeof (rt as any).getFastModeAvailability).toBe("function");
    expect((rt as any).getFastModeAvailability()).toMatchObject({ available: false, reason: expect.stringContaining('"fast-mode"') });
    await expect((rt as any).setFastMode(true)).rejects.toThrow(/live codex\/gpt-fast.*fast-mode/);
    expect(connection.setSessionConfigOption).not.toHaveBeenCalled();
    expect(rt.getSessionInfo()?.sessionId).toBe("codex-existing");
  });

  it("passes the provider's real failure through without retiring context", async () => {
    const { rt, connection } = runtime();
    await rt.newSession({ cwd: "/repo" });
    connection.setSessionConfigOption.mockRejectedValueOnce(new Error("Codex account cannot use fast service tier (403)"));
    expect(typeof (rt as any).setFastMode).toBe("function");
    await expect((rt as any).setFastMode(true)).rejects.toThrow("Codex account cannot use fast service tier (403)");
    expect(rt.getSessionInfo()?.sessionId).toBe("codex-existing");
  });

  it("does not confirm an accepted enable without an echoed state", async () => {
    const { rt, connection } = runtime();
    await rt.newSession({ cwd: "/repo" });
    connection.setSessionConfigOption.mockResolvedValueOnce({} as never);
    expect(typeof (rt as any).setFastMode).toBe("function");
    await expect((rt as any).setFastMode(true)).rejects.toThrow(/did not report/);
    expect(rt.getFastModeOutcome()?.applied).toBeNull();
    await (rt as any).setFastMode(false);
    expect(connection.setSessionConfigOption.mock.calls.map(([input]) => input.value)).toEqual(["on", "off"]);
    expect(rt.getFastModeOutcome()).toEqual({ requested: false, applied: false });
    expect(rt.getSessionInfo()?.sessionId).toBe("codex-existing");
  });

  it("renders the same applied Fast status in Discord and Google Chat", async () => {
    const { rt } = runtime();
    await rt.newSession({ cwd: "/repo", fastMode: true });
    const panel = { state: "Working" as const, repoDisplay: "repo", model: "gpt-fast", action: "thinking", elapsedSeconds: 1,
      fastMode: describeFastModeOutcome(rt.getFastModeOutcome()) };
    expect(discordRenderer.statusPanel(panel).footer).toContain("⚡ fast on");
    expect(googleChatStatusPanel(panel).footer).toContain("⚡ fast on");
  });
});

describe("Codex configure_thread Fast", () => {
  it.each(["discord", "google-chat"])("changes only Fast in a warm %s session and keeps the ACP", async platform => {
    const { rt, connection } = runtime();
    await rt.newSession({ cwd: "/repo" });
    const target = { id: `${platform}:target`, platform, channelRef: "target", parentRef: platform === "discord" ? "channel" : null,
      agentId: "codex", acpSessionId: "codex-existing", repoPath: "/repo", configJson: JSON.stringify({ model: "gpt-fast" }),
      createdUtc: "2026-10-14T00:00:00Z", updatedUtc: "2026-10-14T00:00:00Z" } as SessionRecord;
    let fast = false;
    const store = testSessionStore({});
    store.upsert(target);
    const profile = { id: "codex", defaultModel: "gpt-fast", fastMode: spec, staticModels: [{ modelId: "gpt-fast", name: "Fast-capable" }],
      effort: { mechanism: "none", levels: [] } } as unknown as AgentProfile;
    const router = testSessionRouter({
      describeConfig: () => ({ sessionId: target.id, channelRef: target.channelRef, parentRef: target.parentRef,
        agent: { value: "codex", source: "session config" }, model: { value: "gpt-fast", source: "session config" },
        location: { value: "local", source: "default" }, effort: { value: null, source: "default" },
        cwd: { value: "/repo", source: "session config" }, role: { value: null, source: "default" },
        disableThreadPrefix: { value: false, source: "default" }, fastMode: { value: fast, source: "thread preset" },
        fastModeDescriptor: spec } as ConfigDescription),
      getProfile: () => profile, getOrStartRuntime: async () => rt,
      invalidate: vi.fn(async () => {}), assertAgentAllowedForRecord: () => {},
    });
    const transition = new RuntimeTransition({ store, router, modelCatalog: fixtureModelCatalog([profile]),
      mutation: { applyThreadOverlay: ({ changes }: any) => { if (changes.fastMode !== undefined) fast = changes.fastMode; return { ok: true, message: "ok", auditId: "audit" }; },
        applySessionConfig: () => ({ ok: true, result: { ok: true, message: "ok", auditId: "audit", fields: [], warnings: [] } }) } as never });
    expect(await transition.configure(target, target, { fastMode: true })).toMatchObject({ ok: true, applied: { fastMode: true }, sessionReset: false, runtimeReloaded: false });
    expect(store.get(target.id)?.acpSessionId).toBe("codex-existing");
    expect(rt.getFastModeOutcome()).toEqual({ requested: true, applied: true });
    expect(await transition.configure(target, target, { fastMode: false })).toMatchObject({ ok: true, applied: { fastMode: false }, sessionReset: false });
    expect(rt.getFastModeOutcome()).toEqual({ requested: false, applied: false });
    const calls = connection.setSessionConfigOption.mock.calls.length;
    expect(await transition.configure(target, target, { fastMode: false })).toMatchObject({ ok: true, changes: { fastMode: { changed: false } }, sessionReset: false });
    expect(connection.setSessionConfigOption).toHaveBeenCalledTimes(calls);
    expect(router.invalidate).not.toHaveBeenCalled();
    expect(connection.newSession).toHaveBeenCalledTimes(1);

    connection.setSessionConfigOption.mockRejectedValueOnce(new Error("Codex fast tier unavailable (403)"));
    expect(await transition.configure(target, target, { fastMode: true }))
      .toEqual({ ok: false, error: "Codex fast tier unavailable (403)" });
    expect(fast).toBe(false);
    expect(rt.getFastModeOutcome()).toEqual({ requested: false, applied: false });
    expect(router.invalidate).not.toHaveBeenCalled();
    expect(connection.newSession).toHaveBeenCalledTimes(1);
  });
});
