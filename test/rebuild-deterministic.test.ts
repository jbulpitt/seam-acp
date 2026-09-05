import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { MessagePageItem } from "../packages/core/src/core/message-reader.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const SEAM = "seam-bot";

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-r",
  platform: "discord",
  channelRef: "thread-r",
  parentRef: "parent-r",
  agentId: "claude",
  acpSessionId: "acp-active",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: "2026-01-01T00:00:00Z",
  updatedUtc: "2026-01-01T00:00:00Z",
  ...over,
});

function post(id: string, content: string, over: Partial<MessagePageItem> = {}): MessagePageItem {
  return {
    messageId: id,
    timestampMs: 1_700_000_000_000 + Number(id) * 1000,
    authorId: over.authorType === "bot" ? (over.authorId ?? SEAM) : "human-1",
    authorName: over.authorName ?? (over.authorType === "bot" ? "Seam" : "Jesse"),
    authorType: over.authorType ?? "human",
    content,
    attachmentNames: over.attachmentNames ?? [],
    hasEmbeds: over.hasEmbeds ?? false,
    hasComponents: over.hasComponents ?? false,
  };
}

function makeOrch(over?: {
  posts?: MessagePageItem[];
  cfg?: { model?: string; reasoningEffort?: string; lastContextUsage?: { model: string; size: number } };
  staticContextLimit?: number;
  staticModels?: Array<{ modelId: string; name: string; contextLimit: number }> | null;
  botId?: string | undefined;
  channelPresets?: Map<string, { rider?: { value: string } }>;
  threadPresets?: Map<string, { rider?: { value: string } }>;
  duringSeed?: (bound: { value: string }) => void;
  seedError?: Error;
  alwaysFullPage?: boolean;
}) {
  const rec = record();
  const bound = { value: rec.acpSessionId };
  const seedCalls: any[] = [];
  const injectCalls: any[] = [];
  const casCalls: any[] = [];
  const compactCalls: string[] = [];
  const posts = over?.posts ?? [
    post("1", "hello"),
    post("2", "hi there", { authorType: "bot" }),
  ];
  const profile = {
    id: "claude",
    displayName: "Claude",
    defaultModel: "claude-opus-4.8",
    staticModels:
      over?.staticModels === null
        ? []
        : (over?.staticModels ?? [
            { modelId: "claude-opus-4.8", name: "Opus", contextLimit: over?.staticContextLimit ?? 200_000 },
          ]),
    sessionManager: { name: "mgr" },
  };
  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: "/tmp/none",
      REPOS_ROOT: "/repo",
      DEFAULT_MODEL: "default",
      CHANNEL_PRESETS_FILE: undefined,
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      channelPresets: over?.channelPresets ?? new Map(),
      threadPresets: over?.threadPresets ?? new Map(),
    } as any,
    adapter: {
      getBotUserId: () => ("botId" in (over ?? {}) ? over!.botId : SEAM),
      fetchMessagePage: async () => {
        if (over?.alwaysFullPage) {
          return Array.from({ length: 100 }, (_, i) => post(String(i + 1), `page-item ${i + 1}`));
        }
        return posts;
      },
    } as any,
    router: {
      listProfiles: () => [profile],
      describeConfig: () => ({}),
      getProfile: () => profile,
      invalidate: async () => {},
    } as any,
    store: {
      readConfig: () => over?.cfg ?? { model: "claude-opus-4.8", reasoningEffort: "high" },
      get: () => ({ ...rec, acpSessionId: bound.value }),
      compareAndSwapAcpSession: (_id: string, expected: string, next: string) => {
        const ok = bound.value === expected;
        if (ok) bound.value = next;
        casCalls.push({ expected, next, ok });
        return ok;
      },
      upsert: () => {},
      writeConfig: () => "{}",
    } as any,
    renderer: {} as any,
  });
  (orch as any).injectTurn = async (...args: unknown[]) => {
    injectCalls.push(args);
    throw new Error("injectTurn must not run during Rebuild");
  };
  (orch as any).compactThread = async () => {
    compactCalls.push("compactThread");
    throw new Error("premium compact must not run during Rebuild");
  };
  (orch as any).compactSessionFromThread = async () => {
    compactCalls.push("compactSessionFromThread");
    throw new Error("compact-thread must not run during Rebuild");
  };
  (orch as any).seedNewSession = async (args: any) => {
    seedCalls.push(args);
    over?.duringSeed?.(bound);
    if (over?.seedError) throw over.seedError;
    return "sess-new";
  };
  return { orch, rec, seedCalls, injectCalls, casCalls, bound, compactCalls };
}

describe("reconstructSessionFromDiscord", () => {
  it("seeds once on the destination profile and never calls injectTurn", async () => {
    const t = makeOrch();
    const res = await (t.orch as any).reconstructSessionFromDiscord({
      record: t.rec,
      channel: { platform: "discord", id: "thread-r", parentId: "parent-r" },
      observedAtStart: "acp-active",
      attachIntent: "attach",
    });
    expect(t.injectCalls).toHaveLength(0);
    expect(t.seedCalls).toHaveLength(1);
    expect(t.seedCalls[0].profile.id).toBe("claude");
    expect(t.seedCalls[0].model).toBe("claude-opus-4.8");
    expect(t.seedCalls[0].leadIn).toBeNull();
    expect(t.seedCalls[0].summary).toContain("deterministic reconstruction");
    expect(t.seedCalls[0].summary).toContain("Human — Jesse");
    expect(t.seedCalls[0].summary).toContain("Assistant — Seam");
    expect(res.newSessionId).toBe("sess-new");
    expect(t.casCalls).toEqual([{ expected: "acp-active", next: "sess-new", ok: true }]);
  });

  it("fails closed on an oversized opening block without seeding", async () => {
    const t = makeOrch({
      posts: [post("1", "X".repeat(50_000))],
      staticContextLimit: 1_000,
    });
    await expect(
      (t.orch as any).reconstructSessionFromDiscord({
        record: t.rec,
        channel: { platform: "discord", id: "thread-r" },
        observedAtStart: "acp-active",
        attachIntent: "attach",
      })
    ).rejects.toThrow(/exceed the .* destination budget/);
    expect(t.seedCalls).toHaveLength(0);
    expect(t.casCalls).toHaveLength(0);
    expect(t.bound.value).toBe("acp-active");
  });

  it("fails closed when the Seam bot id is unknown", async () => {
    const t = makeOrch({ botId: undefined });
    await expect(
      (t.orch as any).reconstructSessionFromDiscord({
        record: t.rec,
        channel: { platform: "discord", id: "thread-r" },
        observedAtStart: "acp-active",
        attachIntent: "attach",
      })
    ).rejects.toThrow(/bot user id/);
    expect(t.seedCalls).toHaveLength(0);
  });

  it("uses matching live usage for the 60% budget", async () => {
    const t = makeOrch({
      cfg: {
        model: "claude-opus-4.8",
        lastContextUsage: { model: "claude-opus-4.8", size: 500_000 },
      },
    });
    const res = await (t.orch as any).reconstructSessionFromDiscord({
      record: t.rec,
      channel: { platform: "discord", id: "thread-r" },
      observedAtStart: "acp-active",
      attachIntent: "attach",
    });
    expect(res.seed.contextWindow).toBe(500_000);
    expect(res.seed.budgetTokens).toBe(300_000);
  });

  it("preserves a concurrent detach instead of overwriting the binding", async () => {
    const t = makeOrch();
    t.bound.value = "";
    const res = await (t.orch as any).reconstructSessionFromDiscord({
      record: t.rec,
      channel: { platform: "discord", id: "thread-r" },
      observedAtStart: "acp-active",
      attachIntent: "attach",
    });
    expect(res.attachment.attached).toBe(false);
    expect(t.casCalls).toHaveLength(0);
    expect(t.bound.value).toBe("");
    expect(t.seedCalls).toHaveLength(1);
  });

  it("leaves the binding unchanged when the destination seed fails", async () => {
    const t = makeOrch({ seedError: new Error("seed boom") });
    await expect(
      (t.orch as any).reconstructSessionFromDiscord({
        record: t.rec,
        channel: { platform: "discord", id: "thread-r" },
        observedAtStart: "acp-active",
        attachIntent: "attach",
      })
    ).rejects.toThrow(/seed boom/);
    expect(t.casCalls).toHaveLength(0);
    expect(t.bound.value).toBe("acp-active");
  });

  it("reports created-unattached when a later attach CAS loses", async () => {
    const t = makeOrch({
      duringSeed: (bound) => {
        bound.value = "someone-else";
      },
    });
    const res = await (t.orch as any).reconstructSessionFromDiscord({
      record: t.rec,
      channel: { platform: "discord", id: "thread-r" },
      observedAtStart: "acp-active",
      attachIntent: "attach",
    });
    expect(t.seedCalls).toHaveLength(1);
    expect(res.attachment.attached).toBe(false);
    expect(res.attachment.reason).toBe("rebound-elsewhere");
    expect(t.bound.value).toBe("someone-else");
  });

  it("fails closed when the destination window cannot be resolved", async () => {
    const t = makeOrch({
      cfg: { model: "mystery-model" },
      staticModels: null,
    });
    await expect(
      (t.orch as any).reconstructSessionFromDiscord({
        record: t.rec,
        channel: { platform: "discord", id: "thread-r" },
        observedAtStart: "acp-active",
        attachIntent: "attach",
      })
    ).rejects.toThrow(/cannot resolve a context window/);
    expect(t.seedCalls).toHaveLength(0);
  });

  it("does not use another model's static window for an unknown destination", async () => {
    const t = makeOrch({ cfg: { model: "gpt-5.5" } });
    await expect(
      (t.orch as any).reconstructSessionFromDiscord({
        record: t.rec,
        channel: { platform: "discord", id: "thread-r" },
        observedAtStart: "acp-active",
        attachIntent: "attach",
      })
    ).rejects.toThrow(/cannot resolve a context window/);
    expect(t.seedCalls).toHaveLength(0);
  });

  it("fails closed when Discord history is truncated by the page cap", async () => {
    const t = makeOrch({ alwaysFullPage: true });
    await expect(
      (t.orch as any).reconstructSessionFromDiscord({
        record: t.rec,
        channel: { platform: "discord", id: "thread-r" },
        observedAtStart: "acp-active",
        attachIntent: "attach",
      })
    ).rejects.toThrow(/page cap/);
    expect(t.seedCalls).toHaveLength(0);
    expect(t.bound.value).toBe("acp-active");
  });

  it("labels a thread-only rider as thread, not channel", async () => {
    const t = makeOrch({
      threadPresets: new Map([["thread-r", { rider: { value: "thread only rule" } }]]),
    });
    const res = await (t.orch as any).reconstructSessionFromDiscord({
      record: t.rec,
      channel: { platform: "discord", id: "thread-r", parentId: "parent-r" },
      observedAtStart: "acp-active",
      attachIntent: "attach",
    });
    expect(res.seed.text).toContain("## Thread rider");
    expect(res.seed.text).toContain("thread only rule");
    expect(res.seed.text).not.toContain("## Channel rider");
  });

  it("emits channel then thread riders in precedence order", async () => {
    const t = makeOrch({
      channelPresets: new Map([["parent-r", { rider: { value: "channel rule" } }]]),
      threadPresets: new Map([["thread-r", { rider: { value: "thread rule" } }]]),
    });
    const res = await (t.orch as any).reconstructSessionFromDiscord({
      record: t.rec,
      channel: { platform: "discord", id: "thread-r", parentId: "parent-r" },
      observedAtStart: "acp-active",
      attachIntent: "attach",
    });
    const channelAt = res.seed.text.indexOf("channel rule");
    const threadAt = res.seed.text.indexOf("thread rule");
    expect(channelAt).toBeGreaterThan(-1);
    expect(threadAt).toBeGreaterThan(channelAt);
    expect(t.compactCalls).toEqual([]);
  });
});
