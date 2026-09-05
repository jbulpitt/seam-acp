import { describe, expect, it, vi } from "vitest";
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
  staticModels?: Array<{ modelId: string; name: string; contextLimit?: number }> | null;
  botId?: string | undefined;
  channelPresets?: Map<string, { rider?: { value: string }; agent?: { value: string }; model?: { value: string } }>;
  threadPresets?: Map<string, { rider?: { value: string }; agent?: { value: string }; model?: { value: string } }>;
  duringSeed?: (bound: { value: string }) => void;
  seedError?: Error;
  alwaysFullPage?: boolean;
  recordOver?: Partial<SessionRecord>;
  profiles?: Record<string, any>;
  describeConfig?: (record: SessionRecord) => any;
  getModelMetadata?: (id: string) => { context_window: number | null } | null;
  listPickerModels?: () => Promise<Array<{ modelId: string; name: string; contextLimit?: number }>>;
}) {
  const rec = record(over?.recordOver);
  const bound = { value: rec.acpSessionId };
  const seedCalls: any[] = [];
  const injectCalls: any[] = [];
  const casCalls: any[] = [];
  const compactCalls: string[] = [];
  const describeCalls: SessionRecord[] = [];
  const fetchCalls: number[] = [];
  const panels: Array<{ title?: string; description?: string; footer?: string; fields: unknown[] }> = [];
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
    ...(over?.listPickerModels ? { listPickerModels: over.listPickerModels } : {}),
  };
  const profiles = { claude: profile, ...(over?.profiles ?? {}) };
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
        fetchCalls.push(1);
        if (over?.alwaysFullPage) {
          return Array.from({ length: 100 }, (_, i) => post(String(i + 1), `page-item ${i + 1}`));
        }
        return posts;
      },
      sendPanel: async (_ch: unknown, panel: unknown) => {
        panels.push(panel as { title?: string; description?: string; footer?: string; fields: unknown[] });
        return { id: `rebuild-card-${panels.length}`, channel: { platform: "discord", id: "thread-r" } };
      },
      editPanel: async (_ref: unknown, panel: unknown) => {
        panels.push(panel as { title?: string; description?: string; footer?: string; fields: unknown[] });
      },
    } as any,
    router: {
      listProfiles: () => Object.values(profiles),
      describeConfig: (session: SessionRecord) => {
        describeCalls.push(session);
        if (over?.describeConfig) return over.describeConfig(session);
        const thread = (over?.threadPresets ?? new Map()).get(session.channelRef);
        const agentId = thread?.agent?.value ?? session.agentId;
        const model = thread?.model?.value ?? over?.cfg?.model ?? profiles[agentId]?.defaultModel ?? "claude-opus-4.8";
        return {
          agent: { value: agentId, source: thread?.agent ? "thread preset" : "session config" },
          model: { value: model, source: thread?.model ? "thread preset" : "session config" },
          effort: { value: over?.cfg?.reasoningEffort ?? null, source: "session config" },
          cwd: { value: session.repoPath ?? "/repo", source: "session config" },
        };
      },
      getProfile: (id: string) => profiles[id],
      invalidate: async () => {},
    } as any,
    ...(over?.getModelMetadata ? { getModelMetadata: over.getModelMetadata } : {}),
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
  return { orch, rec, seedCalls, injectCalls, casCalls, bound, compactCalls, describeCalls, fetchCalls, panels };
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
    expect(t.fetchCalls).toHaveLength(0);
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
    expect(t.fetchCalls).toHaveLength(0);
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

  it("resolves grok-4.6 at 500K on first use when the env list has only a cosmetic (500k) label", async () => {
    const t = makeOrch({
      recordOver: { agentId: "grok" },
      cfg: { model: "grok-4.6" },
      profiles: {
        grok: {
          id: "grok",
          defaultModel: "grok-4.6",
          staticModels: [{ modelId: "grok-4.6", name: "Grok 4.6 (500k)" }],
          sessionManager: { name: "mgr" },
        },
      },
    });
    const res = await (t.orch as any).reconstructSessionFromDiscord({
      record: t.rec,
      channel: { platform: "discord", id: "thread-r" },
      observedAtStart: "acp-active",
      attachIntent: "attach",
    });
    expect(t.describeCalls.length).toBeGreaterThan(0);
    expect(res.destination).toEqual({ agentId: "grok", model: "grok-4.6", contextWindow: 500_000 });
    expect(res.seed.contextWindow).toBe(500_000);
    expect(res.seed.budgetTokens).toBe(300_000);
    expect(t.seedCalls[0].profile.id).toBe("grok");
    expect(t.seedCalls[0].model).toBe("grok-4.6");
  });

  it("does not let stale record.agentId / cfg.model override a thread-preset identity", async () => {
    const t = makeOrch({
      cfg: { model: "claude-opus-4.8" },
      threadPresets: new Map([
        ["thread-r", { agent: { value: "grok" }, model: { value: "grok-4.6" } }],
      ]),
      profiles: {
        grok: {
          id: "grok",
          defaultModel: "grok-4.6",
          staticModels: [{ modelId: "grok-4.6", name: "Grok 4.6 (500k)" }],
          sessionManager: { name: "mgr" },
        },
      },
    });
    const res = await (t.orch as any).reconstructSessionFromDiscord({
      record: t.rec,
      channel: { platform: "discord", id: "thread-r" },
      observedAtStart: "acp-active",
      attachIntent: "attach",
    });
    expect(t.rec.agentId).toBe("claude");
    expect(res.destination.agentId).toBe("grok");
    expect(res.destination.model).toBe("grok-4.6");
    expect(res.destination.contextWindow).toBe(500_000);
    expect(t.seedCalls[0].profile.id).toBe("grok");
    expect(t.seedCalls[0].model).toBe("grok-4.6");
  });

  it("uses AGY listPickerModels contextLimit without seeding first", async () => {
    let pickerCalls = 0;
    const t = makeOrch({
      recordOver: { agentId: "agy" },
      cfg: { model: "gemini-3.8-flash-high" },
      profiles: {
        agy: {
          id: "agy",
          defaultModel: "gemini-3.8-flash-high",
          staticModels: [{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High" }],
          sessionManager: { name: "mgr" },
          listPickerModels: async () => {
            pickerCalls += 1;
            return [
              { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High", contextLimit: 1_048_576 },
            ];
          },
        },
      },
    });
    const res = await (t.orch as any).reconstructSessionFromDiscord({
      record: t.rec,
      channel: { platform: "discord", id: "thread-r" },
      observedAtStart: "acp-active",
      attachIntent: "attach",
    });
    expect(pickerCalls).toBe(1);
    expect(res.destination.contextWindow).toBe(1_048_576);
    expect(res.seed.budgetTokens).toBe(Math.floor(1_048_576 * 0.6));
  });

  it("uses cached copilot metadata when the static picker has no window", async () => {
    const t = makeOrch({
      recordOver: { agentId: "copilot" },
      cfg: { model: "gpt-5.5" },
      profiles: {
        copilot: {
          id: "copilot",
          defaultModel: "gpt-5.5",
          staticModels: [{ modelId: "gpt-5.5", name: "GPT-5.5" }],
          sessionManager: { name: "mgr" },
        },
      },
      getModelMetadata: (id) => (id === "gpt-5.5" ? { context_window: 400_000 } : null),
    });
    const res = await (t.orch as any).reconstructSessionFromDiscord({
      record: t.rec,
      channel: { platform: "discord", id: "thread-r" },
      observedAtStart: "acp-active",
      attachIntent: "attach",
    });
    expect(res.destination).toEqual({ agentId: "copilot", model: "gpt-5.5", contextWindow: 400_000 });
    expect(res.seed.budgetTokens).toBe(240_000);
  });

  it("does not parse a display label for a token count", async () => {
    const t = makeOrch({
      cfg: { model: "mystery-999" },
      staticModels: [{ modelId: "mystery-999", name: "Mystery (999k)" }],
    });
    await expect(
      (t.orch as any).reconstructSessionFromDiscord({
        record: t.rec,
        channel: { platform: "discord", id: "thread-r" },
        observedAtStart: "acp-active",
        attachIntent: "attach",
      })
    ).rejects.toThrow(/agent `claude` model `mystery-999`/);
    expect(t.seedCalls).toHaveLength(0);
    expect(t.fetchCalls).toHaveLength(0);
  });

  it("posts a full Rebuild card, edits through stages, and freezes success", async () => {
    const t = makeOrch();
    const res = await (t.orch as any).reconstructSessionFromDiscord({
      record: t.rec,
      channel: { platform: "discord", id: "thread-r", parentId: "parent-r" },
      observedAtStart: "acp-active",
      attachIntent: "attach",
    });
    expect(res.newSessionId).toBe("sess-new");
    const titles = t.panels.map((p) => p.title);
    expect(titles[0]).toBe("Rebuild");
    expect(titles.at(-1)).toBe("Rebuild complete");
    const blobs = t.panels.map((p) => `${p.title ?? ""} ${p.description ?? ""}`);
    expect(blobs.some((b) => /Fetching Discord history|Fetched \d+ Discord post/.test(b))).toBe(true);
    expect(blobs.some((b) => /projected \d+ logical/.test(b))).toBe(true);
    expect(blobs.some((b) => b.includes("Seeding new session"))).toBe(true);
    expect(blobs.some((b) => /\bAttaching\b/.test(b))).toBe(true);
    const frozen = t.panels.at(-1)!;
    expect(frozen.fields).toEqual(expect.any(Array));
    const frozenBlob = `${frozen.title} ${frozen.description ?? ""} ${JSON.stringify(frozen.fields)}`;
    expect(frozenBlob).toContain("sess-new");
    expect(frozenBlob).toContain("window");
  });

  it("uses simple copy when the thread status card is simple", async () => {
    const t = makeOrch({
      describeConfig: (session) => ({
        agent: { value: session.agentId, source: "session config" },
        model: { value: "claude-opus-4.8", source: "session config" },
        effort: { value: "high", source: "session config" },
        cwd: { value: "/repo", source: "session config" },
        statusCardStyle: { value: "simple", source: "session config" },
      }),
    });
    await (t.orch as any).reconstructSessionFromDiscord({
      record: t.rec,
      channel: { platform: "discord", id: "thread-r" },
      observedAtStart: "acp-active",
      attachIntent: "attach",
    });
    expect(t.panels[0]?.title).toBe("Getting ready to continue");
    expect(t.panels.at(-1)?.title).toBe("Ready to continue");
    const blob = t.panels.map((p) => `${p.title ?? ""} ${p.description ?? ""} ${p.footer ?? ""}`).join("\n");
    expect(blob).not.toMatch(/rebuild/i);
    expect(blob).not.toMatch(/sess-new/);
    expect(blob).not.toMatch(/token/i);
  });

  it("freezes failure on the thread card and still throws", async () => {
    const t = makeOrch({ seedError: new Error("seed boom\n    at seedNewSession") });
    await expect(
      (t.orch as any).reconstructSessionFromDiscord({
        record: t.rec,
        channel: { platform: "discord", id: "thread-r" },
        observedAtStart: "acp-active",
        attachIntent: "attach",
      })
    ).rejects.toThrow(/seed boom/);
    expect(t.panels[0]?.title).toBe("Rebuild");
    expect(t.panels.at(-1)?.title).toBe("Rebuild failed");
    expect(t.panels.at(-1)?.description).toBe("seed boom");
    expect(t.panels.at(-1)?.description).not.toMatch(/at seedNewSession/);
  });

  it("heartbeats elapsed on the card while seedNewSession is in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = makeOrch({
      duringSeed: () => {
        /* opened */
      },
    });
    (t.orch as any).seedNewSession = async () => {
      await gate;
      return "sess-new";
    };
    const done = (t.orch as any).reconstructSessionFromDiscord({
      record: t.rec,
      channel: { platform: "discord", id: "thread-r" },
      observedAtStart: "acp-active",
      attachIntent: "attach",
    });
    await vi.waitFor(() => {
      expect(t.panels.some((p) => p.description === "Seeding new session")).toBe(true);
    });
    const before = t.panels.length;
    await new Promise((r) => setTimeout(r, 5_200));
    expect(t.panels.length).toBeGreaterThan(before);
    release();
    await done;
    expect(t.panels.at(-1)?.title).toBe("Rebuild complete");
  }, 15_000);
});
