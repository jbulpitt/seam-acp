import { describe, it, expect } from "vitest";
import { pino } from "pino";
import { SessionRouter, simpleCardGifForRender, statusCardStyleForRender } from "../packages/core/src/core/session-router.js";
import { TurnStatus } from "../packages/core/src/core/status-panel.js";
import type { SessionStore } from "../packages/core/src/core/session-store.js";
import type { AgentProfile } from "@seam/adapters";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord, SessionConfigState } from "../packages/core/src/core/types.js";
import type { ChannelPreset, ThreadPreset } from "../packages/core/src/config.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

// Stub profiles: `claude` supports effort levels; `copilot` has no effort concept.
const profiles = [
  { id: "claude", effort: { mechanism: "configOption", levels: ["low", "medium", "high"] } },
  { id: "copilot", effort: { mechanism: "none", levels: [] } },
] as unknown as AgentProfile[];

/** A SessionStore stub that only implements what describeConfig reads. */
function stubStore(): SessionStore {
  return {
    readConfig: (record: SessionRecord): SessionConfigState => {
      if (!record.configJson) return {};
      try {
        return JSON.parse(record.configJson) as SessionConfigState;
      } catch {
        return {};
      }
    },
  } as unknown as SessionStore;
}

function makeRouter(opts?: {
  channelPresets?: Map<string, ChannelPreset>;
  threadPresets?: Map<string, ThreadPreset>;
}): SessionRouter {
  return new SessionRouter({
    logger: silent,
    store: stubStore(),
    profiles,
    defaultAgentId: "copilot",
    defaultModel: "gpt-5.4",
    defaultPermissionMode: "ask",
    channelPresets: opts?.channelPresets ?? new Map(),
    threadPresets: opts?.threadPresets ?? new Map(),
  });
}

function makeRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "discord:thread-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "chan-1",
    agentId: "copilot",
    acpSessionId: "acp-1",
    repoPath: "/repo/session",
    configJson: JSON.stringify({ model: "gpt-5.4" } satisfies SessionConfigState),
    createdUtc: "2026-01-01T00:00:00Z",
    updatedUtc: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("SessionRouter.describeConfig — layer provenance (#58 P1)", () => {
  it("attributes each value to session config / default when no presets exist", () => {
    const router = makeRouter();
    const d = router.describeConfig(makeRecord());

    expect(d.agent).toEqual({ value: "copilot", source: "session config" });
    expect(d.model).toEqual({ value: "gpt-5.4", source: "session config" });
    expect(d.cwd).toEqual({ value: "/repo/session", source: "session config" });
    // No effort set anywhere → null / default.
    expect(d.effort).toEqual({ value: null, source: "default" });
    // No policy in config → bot default.
    expect(d.permission).toEqual({ value: "ask", source: "default" });
    expect(d.locked).toBe(false);
  });

  it("model falls to bot default when neither preset nor session config sets it", () => {
    const router = makeRouter();
    const d = router.describeConfig(makeRecord({ configJson: "{}" }));
    expect(d.model).toEqual({ value: "gpt-5.4", source: "default" });
  });

  it("a channel preset wins over session config", () => {
    const channelPresets = new Map<string, ChannelPreset>([
      ["chan-1", { model: { value: "claude-opus-4.6" }, agent: { value: "claude" }, locked: true }],
    ]);
    const router = makeRouter({ channelPresets });
    const d = router.describeConfig(makeRecord());

    expect(d.model).toEqual({ value: "claude-opus-4.6", source: "channel preset" });
    expect(d.agent).toEqual({ value: "claude", source: "channel preset" });
    expect(d.locked).toBe(true);
  });

  it("a thread preset overrides the channel preset per field", () => {
    const channelPresets = new Map<string, ChannelPreset>([
      ["chan-1", { model: { value: "claude-opus-4.6" }, cwd: { value: "/repo/chan" }, locked: false }],
    ]);
    const threadPresets = new Map<string, ThreadPreset>([
      ["thread-1", { model: { value: "claude-haiku-4.5" } }],
    ]);
    const router = makeRouter({ channelPresets, threadPresets });
    const d = router.describeConfig(makeRecord());

    // Thread wins model; channel still supplies cwd.
    expect(d.model).toEqual({ value: "claude-haiku-4.5", source: "thread preset" });
    expect(d.cwd).toEqual({ value: "/repo/chan", source: "channel preset" });
  });

  it("honors a preset effort the resolved agent supports", () => {
    const channelPresets = new Map<string, ChannelPreset>([
      ["chan-1", { agent: { value: "claude" }, effort: { value: "high" }, locked: false }],
    ]);
    const router = makeRouter({ channelPresets });
    const d = router.describeConfig(makeRecord());

    expect(d.agent.value).toBe("claude");
    expect(d.effort).toEqual({ value: "high", source: "channel preset" });
    expect(d.effortIgnoredNote).toBeUndefined();
  });

  it("Trap 2: a preset effort the agent can't support is ignored and noted", () => {
    // Resolved agent is copilot (mechanism "none"); the preset effort is dropped.
    const channelPresets = new Map<string, ChannelPreset>([
      ["chan-1", { effort: { value: "high" }, locked: false }],
    ]);
    const router = makeRouter({ channelPresets });
    const d = router.describeConfig(makeRecord({ agentId: "copilot" }));

    expect(d.agent.value).toBe("copilot");
    expect(d.effort).toEqual({ value: null, source: "default" });
    expect(d.effortIgnoredNote).toMatch(/does not support/);
  });

  it("falls back to session-config effort when a preset effort is unusable", () => {
    const channelPresets = new Map<string, ChannelPreset>([
      ["chan-1", { effort: { value: "high" }, locked: false }],
    ]);
    const router = makeRouter({ channelPresets });
    const d = router.describeConfig(
      makeRecord({
        agentId: "copilot",
        configJson: JSON.stringify({ model: "gpt-5.4", reasoningEffort: "medium" }),
      })
    );
    expect(d.effort).toEqual({ value: "medium", source: "session config" });
  });

  it("reports the session permission policy over the default", () => {
    const router = makeRouter();
    const d = router.describeConfig(
      makeRecord({ configJson: JSON.stringify({ permissionPolicy: "always" }) })
    );
    expect(d.permission).toEqual({ value: "always", source: "session config" });
  });

  it("maps legacy autoApprovePermissions=true to always/session config", () => {
    const router = makeRouter();
    const d = router.describeConfig(
      makeRecord({ configJson: JSON.stringify({ autoApprovePermissions: true }) })
    );
    expect(d.permission).toEqual({ value: "always", source: "session config" });
  });

  it("reports detached:true sourced from the thread preset (#80)", () => {
    const threadPresets = new Map<string, ThreadPreset>([
      ["thread-1", { detached: true }],
    ]);
    const router = makeRouter({ threadPresets });
    const d = router.describeConfig(makeRecord());
    expect(d.detached).toEqual({ value: true, source: "thread preset" });
  });

  it("reports detached:false from default when the thread is attached", () => {
    const router = makeRouter();
    const d = router.describeConfig(makeRecord());
    expect(d.detached).toEqual({ value: false, source: "default" });
  });

  it("reports tts:true sourced from the thread preset", () => {
    const threadPresets = new Map<string, ThreadPreset>([["thread-1", { tts: true }]]);
    const router = makeRouter({ threadPresets });
    const d = router.describeConfig(makeRecord());
    expect(d.tts).toEqual({ value: true, source: "thread preset" });
  });

  it("reports tts:false from default", () => {
    const router = makeRouter();
    const d = router.describeConfig(makeRecord());
    expect(d.tts).toEqual({ value: false, source: "default" });
  });

  it("reports ttsVoice from the thread preset", () => {
    const threadPresets = new Map<string, ThreadPreset>([
      ["thread-1", { tts: true, ttsVoice: "Puck" }],
    ]);
    const router = makeRouter({ threadPresets });
    const d = router.describeConfig(makeRecord());
    expect(d.ttsVoice).toEqual({ value: "Puck", source: "thread preset" });
  });

  it("default location is local when the thread preset omits it (#86)", () => {
    const router = makeRouter();
    const d = router.describeConfig(makeRecord());
    expect(d.location).toEqual({ value: "local", source: "default" });
  });

  it("reports location from the thread preset (#86)", () => {
    const threadPresets = new Map<string, ThreadPreset>([["thread-1", { location: "mac" }]]);
    const router = makeRouter({ threadPresets });
    const d = router.describeConfig(makeRecord());
    expect(d.location).toEqual({ value: "mac", source: "thread preset" });
  });

  it("reports channel and thread riders separately (#90)", () => {
    const channelPresets = new Map<string, ChannelPreset>([
      ["chan-1", { rider: { value: "channel rule" }, locked: false }],
    ]);
    const threadPresets = new Map<string, ThreadPreset>([
      ["thread-1", { rider: { value: "thread rule" } }],
    ]);
    const router = makeRouter({ channelPresets, threadPresets });
    const d = router.describeConfig(makeRecord());
    expect(d.rider).toEqual({ channel: "channel rule", thread: "thread rule" });
  });

  it("omits missing rider sides (#90)", () => {
    const router = makeRouter();
    const d = router.describeConfig(makeRecord());
    expect(d.rider).toEqual({});
  });

  it("statusCardStyle defaults to full (#96)", () => {
    const router = makeRouter();
    const d = router.describeConfig(makeRecord());
    expect(d.statusCardStyle).toEqual({ value: "full", source: "default" });
  });

  it("statusCardStyle simple is sourced from session config (#96)", () => {
    const router = makeRouter();
    const d = router.describeConfig(
      makeRecord({ configJson: JSON.stringify({ model: "gpt-5.4", statusCardStyle: "simple" }) })
    );
    expect(d.statusCardStyle).toEqual({ value: "simple", source: "session config" });
  });

  it("statusCardStyle inherits from the channel preset when session and thread omit it", () => {
    const channelPresets = new Map<string, ChannelPreset>([
      ["chan-1", { statusCardStyle: { value: "simple" }, locked: false }],
    ]);
    const router = makeRouter({ channelPresets });
    const d = router.describeConfig(makeRecord());
    expect(d.statusCardStyle).toEqual({ value: "simple", source: "channel preset" });
  });

  it("thread-preset statusCardStyle wins over the channel preset", () => {
    const channelPresets = new Map<string, ChannelPreset>([
      ["chan-1", { statusCardStyle: { value: "simple" }, locked: false }],
    ]);
    const threadPresets = new Map<string, ThreadPreset>([
      ["thread-1", { statusCardStyle: { value: "full" } }],
    ]);
    const router = makeRouter({ channelPresets, threadPresets });
    const d = router.describeConfig(makeRecord());
    expect(d.statusCardStyle).toEqual({ value: "full", source: "thread preset" });
  });

  it("session statusCardStyle wins over thread and channel presets", () => {
    const channelPresets = new Map<string, ChannelPreset>([
      ["chan-1", { statusCardStyle: { value: "simple" }, locked: false }],
    ]);
    const threadPresets = new Map<string, ThreadPreset>([
      ["thread-1", { statusCardStyle: { value: "simple" } }],
    ]);
    const router = makeRouter({ channelPresets, threadPresets });
    const d = router.describeConfig(
      makeRecord({ configJson: JSON.stringify({ model: "gpt-5.4", statusCardStyle: "full" }) })
    );
    expect(d.statusCardStyle).toEqual({ value: "full", source: "session config" });
  });

  it("channel-set style reaches the rendered card without a thread or session value", () => {
    const channelPresets = new Map<string, ChannelPreset>([
      ["chan-1", { statusCardStyle: { value: "simple" }, locked: false }],
    ]);
    const router = makeRouter({ channelPresets });
    const record = makeRecord({ configJson: JSON.stringify({ model: "gpt-5.4" }) });
    const d = router.describeConfig(record);
    expect(d.statusCardStyle.source).toBe("channel preset");
    const style = statusCardStyleForRender(d);
    expect(style).toBe("simple");
    const card = new TurnStatus({ model: "m", repoDisplay: "r", style });
    expect(card.style).toBe("simple");
    expect(card.toInput().style).toBe("simple");
  });

  it("simpleCardGif defaults to false", () => {
    const router = makeRouter();
    const d = router.describeConfig(makeRecord());
    expect(d.simpleCardGif).toEqual({ value: false, source: "default" });
    expect(simpleCardGifForRender(d)).toBe(false);
  });

  it("simpleCardGif is sourced from session config", () => {
    const router = makeRouter();
    const d = router.describeConfig(
      makeRecord({ configJson: JSON.stringify({ model: "gpt-5.4", simpleCardGif: true }) })
    );
    expect(d.simpleCardGif).toEqual({ value: true, source: "session config" });
    expect(simpleCardGifForRender(d)).toBe(true);
  });

  it("simpleCardGif inherits from the channel preset when session and thread omit it", () => {
    const channelPresets = new Map<string, ChannelPreset>([
      ["chan-1", { simpleCardGif: { value: true }, locked: false }],
    ]);
    const router = makeRouter({ channelPresets });
    const d = router.describeConfig(makeRecord());
    expect(d.simpleCardGif).toEqual({ value: true, source: "channel preset" });
    expect(simpleCardGifForRender(d)).toBe(true);
  });

  it("thread-preset simpleCardGif wins over the channel preset", () => {
    const channelPresets = new Map<string, ChannelPreset>([
      ["chan-1", { simpleCardGif: { value: true }, locked: false }],
    ]);
    const threadPresets = new Map<string, ThreadPreset>([
      ["thread-1", { simpleCardGif: { value: false } }],
    ]);
    const router = makeRouter({ channelPresets, threadPresets });
    const d = router.describeConfig(makeRecord());
    expect(d.simpleCardGif).toEqual({ value: false, source: "thread preset" });
    expect(simpleCardGifForRender(d)).toBe(false);
  });

  it("session simpleCardGif wins over thread and channel presets", () => {
    const channelPresets = new Map<string, ChannelPreset>([
      ["chan-1", { simpleCardGif: { value: true }, locked: false }],
    ]);
    const threadPresets = new Map<string, ThreadPreset>([
      ["thread-1", { simpleCardGif: { value: true } }],
    ]);
    const router = makeRouter({ channelPresets, threadPresets });
    const d = router.describeConfig(
      makeRecord({ configJson: JSON.stringify({ model: "gpt-5.4", simpleCardGif: false }) })
    );
    expect(d.simpleCardGif).toEqual({ value: false, source: "session config" });
    expect(simpleCardGifForRender(d)).toBe(false);
  });
});
