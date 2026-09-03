import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { hashBridgeToken } from "../packages/core/src/core/bridge-pairing.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import type { ChoiceCard } from "../packages/core/src/core/choice/types.js";
import type { IngestEndpoint } from "../packages/core/src/core/choice/endpoint.js";
import type { WakeEvent } from "../packages/core/src/core/wake/types.js";
import type { WatchEvent } from "../packages/core/src/core/watch/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const now = "2026-08-24T00:00:00.000Z";

let dir: string;
let store: SessionStore;
let reposRoot: string;

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  const channelRef = over.channelRef ?? "thread-1";
  return {
    id: over.id ?? `discord:${channelRef}`,
    platform: "discord",
    channelRef,
    parentRef: over.parentRef ?? "chan-1",
    agentId: over.agentId ?? "grok",
    acpSessionId: over.acpSessionId ?? "",
    repoPath: over.repoPath ?? "/repo",
    configJson: over.configJson ?? "{}",
    createdUtc: now,
    updatedUtc: now,
    ...over,
  };
}

function autocompleteI(over: {
  group?: string | null;
  sub?: string | null;
  option?: string;
  value?: string;
  channelId?: string;
  isThread?: boolean;
  parentId?: string;
  data?: unknown[];
}) {
  const responded: unknown[][] = [];
  const i = {
    options: {
      getSubcommandGroup: (_req?: boolean) =>
        over.group !== undefined ? over.group : "config",
      getSubcommand: (_req?: boolean) => over.sub ?? "agent",
      getFocused: (_full?: boolean) => ({
        name: over.option ?? "id",
        value: over.value ?? "",
        focused: true as const,
      }),
      data: over.data ?? [],
    },
    channelId: over.channelId ?? "thread-1",
    channel: {
      isThread: () => over.isThread !== false,
      parentId: over.parentId ?? "chan-1",
    },
    responded: false,
    respond: vi.fn(async (choices: unknown[]) => {
      responded.push(choices);
      i.responded = true;
    }),
  };
  return { i, responded };
}

function makeOrch(over?: {
  getRuntime?: (id: string) => { getSessionInfo: () => { availableModes: { id: string; name: string }[] } } | undefined;
  isBusy?: (id: string) => boolean;
}) {
  const grokProfile = {
    id: "grok",
    displayName: "Grok",
    defaultModel: "grok-4",
    staticModels: [
      { modelId: "grok-4.6", name: "Grok 4.6" },
      { modelId: "grok-4", name: "Grok 4" },
    ],
    effort: { levels: ["low", "medium", "high"] },
  };
  const copilotProfile = {
    id: "copilot",
    displayName: "Copilot",
    defaultModel: "gpt-5",
    staticModels: [{ modelId: "gpt-5", name: "GPT-5" }],
    effort: { levels: [] },
  };
  const router = {
    listProfiles: () => [grokProfile, copilotProfile],
    describeConfig: (record: SessionRecord) => ({
      agent: { value: record.agentId },
      model: { value: "grok-4" },
    }),
    ensureSessionRecord: (opts: {
      platform: string;
      channelRef: string;
      parentRef?: string;
      cwd: string;
    }): SessionRecord => {
      const rec = session({
        id: `discord:${opts.channelRef}`,
        platform: opts.platform,
        channelRef: opts.channelRef,
        parentRef: opts.parentRef ?? null,
        repoPath: opts.cwd,
      });
      store.upsert(rec);
      return rec;
    },
    getProfile: (id: string) => {
      if (id === "grok") return grokProfile;
      if (id === "copilot") return copilotProfile;
      return undefined;
    },
    getRuntime: over?.getRuntime,
    isBusy: over?.isBusy ?? (() => false),
    invalidate: vi.fn(async () => {}),
  };
  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: reposRoot,
      TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_MODEL: "grok-4",
      DEFAULT_AGENT: "grok",
      CHANNEL_PRESETS_FILE: undefined,
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      REPO_EMOJIS: new Map(),
      channelPresets: new Map(),
      threadPresets: new Map(),
      bridgePresets: new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set(["admin"]),
    } as any,
    adapter: {} as any,
    router: router as any,
    store,
    renderer: { codeBlock: (s: string) => s } as any,
  });
  return { orch };
}

function schedule(over: Partial<ScheduledPrompt> = {}): ScheduledPrompt {
  return {
    id: "sch_seed01",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "chan-1",
    name: "Morning brief",
    promptText: "Summarize overnight PRs",
    cron: "0 7 * * 1-5",
    timezone: "America/Chicago",
    model: null,
    cwd: null,
    targetChannel: null,
    outputType: "card",
    sessionMode: "isolated",
    catchupSeconds: 7200,
    enabled: true,
    legacyAttachmentCount: 0,
    createdBy: "user-jesse",
    createdUtc: now,
    updatedUtc: now,
    lastRunUtc: null,
    lastStatus: null,
    nextRunUtc: null,
    pinnedSessionId: null,
    ...over,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-slash-ac-"));
  reposRoot = path.join(dir, "repos");
  fs.mkdirSync(path.join(reposRoot, "alpha-app"), { recursive: true });
  fs.mkdirSync(path.join(reposRoot, "beta-lib"), { recursive: true });
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("slash autocomplete responders", () => {
  it("config agent lists configured agent@location ids", async () => {
    const { orch } = makeOrch();
    const { i, responded } = autocompleteI({
      group: "config",
      sub: "agent",
      option: "id",
      value: "grok",
    });
    await orch.handleAutocompleteInteraction(i as any);
    const values = (responded[0] as Array<{ value: string }>).map((c) => c.value);
    expect(values).toContain("grok@local");
    expect(values).not.toContain("claude@local");
  });

  it("config repo lists REPOS_ROOT children (name = basename, value = path)", async () => {
    const { orch } = makeOrch();
    const { i, responded } = autocompleteI({
      group: "config",
      sub: "repo",
      option: "path",
      value: "alp",
    });
    await orch.handleAutocompleteInteraction(i as any);
    expect(responded[0]).toEqual([
      { name: "alpha-app", value: path.join(reposRoot, "alpha-app") },
    ]);
  });

  it("config model uses the thread agent's staticModels catalog", async () => {
    store.upsert(session({ agentId: "grok" }));
    const { orch } = makeOrch();
    const { i, responded } = autocompleteI({
      group: "config",
      sub: "model",
      option: "id",
      value: "grok-4.6",
    });
    await orch.handleAutocompleteInteraction(i as any);
    expect(responded[0]).toEqual([{ name: "Grok 4.6 (grok-4.6)", value: "grok-4.6" }]);
  });

  it("config model is empty when no session is bound", async () => {
    const { orch } = makeOrch();
    const { i, responded } = autocompleteI({
      group: "config",
      sub: "model",
      option: "id",
      value: "",
    });
    await orch.handleAutocompleteInteraction(i as any);
    expect(responded[0]).toEqual([]);
  });

  it("config mode lists live ACP modes; empty when no runtime", async () => {
    store.upsert(session());
    const { orch } = makeOrch();
    const { i, responded } = autocompleteI({
      group: "config",
      sub: "mode",
      option: "id",
      value: "",
    });
    await orch.handleAutocompleteInteraction(i as any);
    expect(responded[0]).toEqual([]);

    const { orch: live } = makeOrch({
      getRuntime: () => ({
        getSessionInfo: () => ({
          availableModes: [
            { id: "code", name: "Code" },
            { id: "ask", name: "Ask" },
          ],
        }),
      }),
    });
    const { i: i2, responded: r2 } = autocompleteI({
      group: "config",
      sub: "mode",
      option: "id",
      value: "as",
    });
    await live.handleAutocompleteInteraction(i2 as any);
    expect(r2[0]).toEqual([{ name: "Ask (ask)", value: "ask" }]);
  });

  it("schedule id lists this thread's schedules as name (id)", async () => {
    store.upsertScheduled(schedule({ id: "sch_aa", name: "Morning brief" }));
    store.upsertScheduled(schedule({ id: "sch_bb", name: "Nightly", channelRef: "thread-other" }));
    const { orch } = makeOrch();
    const { i, responded } = autocompleteI({
      group: "schedule",
      sub: "remove",
      option: "id",
      value: "Mor",
    });
    await orch.handleAutocompleteInteraction(i as any);
    expect(responded[0]).toEqual([{ name: "Morning brief (sch_aa)", value: "sch_aa" }]);
  });

  // #158: `/seam schedule addfile` / `removefile` are gone, so nothing is
  // registered for them — an invocation of either responds with no choices.
  it.each(["addfile", "removefile"])("schedule %s has no autocomplete responder", async (sub) => {
    store.upsertScheduled(schedule({ id: "sch_aa" }));
    const { orch } = makeOrch();
    const { i, responded } = autocompleteI({
      group: "schedule",
      sub,
      option: "id",
      value: "Mor",
    });
    await orch.handleAutocompleteInteraction(i as any);
    expect(responded[0]).toEqual([]);
  });

  it("workflows cancel-wake / cancel-watch are thread-scoped", async () => {
    const wake: WakeEvent = {
      id: "wake_1",
      platform: "discord",
      channelRef: "thread-1",
      parentRef: "chan-1",
      fireAtUtc: new Date(Date.now() + 120_000).toISOString(),
      prompt: "resume",
      reason: "check back",
      createdBy: "discord:thread-1",
      correlationId: null,
      chainDepth: 0,
      catchupSeconds: 900,
      fireOnStartup: false,
      createdUtc: now,
    };
    store.upsertWake(wake);
    store.upsertWake({ ...wake, id: "wake_other", channelRef: "thread-other" });
    const watch: WatchEvent = {
      id: "watch_1",
      platform: "discord",
      channelRef: "thread-1",
      parentRef: "chan-1",
      kind: "file",
      spec: "/tmp/done",
      match: null,
      intervalSeconds: 30,
      prompt: "go",
      reason: "wait for CI",
      mode: "once",
      maxFires: 1,
      fireCount: 0,
      lastCheckedUtc: null,
      lastFiredUtc: null,
      lastObserved: null,
      expiresAtUtc: new Date(Date.now() + 3600_000).toISOString(),
      createdBy: "discord:thread-1",
      correlationId: null,
      createdUtc: now,
    };
    store.upsertWatch(watch);
    const { orch } = makeOrch();
    const { i, responded } = autocompleteI({
      group: null,
      sub: "workflows",
      option: "cancel-wake",
      value: "check",
    });
    await orch.handleAutocompleteInteraction(i as any);
    expect(responded[0]).toEqual([{ name: "check back (wake_1)", value: "wake_1" }]);

    const { i: i2, responded: r2 } = autocompleteI({
      group: null,
      sub: "workflows",
      option: "cancel-watch",
      value: "wait",
    });
    await orch.handleAutocompleteInteraction(i2 as any);
    expect(r2[0]).toEqual([{ name: "wait for CI (watch_1)", value: "watch_1" }]);
  });

  it("workflows cancel-choice / cancel-ingest list open tokens in this thread", async () => {
    const card: ChoiceCard = {
      id: "ch_1",
      platform: "discord",
      channelRef: "thread-1",
      parentRef: "chan-1",
      messageId: "msg-1",
      title: "Ship this?",
      body: null,
      maxClicks: 1,
      targetUserId: null,
      defaultTarget: { type: "live" },
      options: [{ label: "Yes", kind: "prompt", payload: "yes" }],
      clickCount: 0,
      status: "open",
      lastClickerId: null,
      lastClickerName: null,
      lastOptionIndex: null,
      createdBy: "discord:thread-1",
      createdUtc: now,
      ingestTokenHash: null,
      ingestOptionIndex: null,
      resultSchema: null,
      ingestWrapper: null,
      ingestCors: null,
    };
    store.insertChoiceCard(card);
    const endpoint: IngestEndpoint = {
      id: "ie_1",
      tokenHash: hashBridgeToken("tok"),
      name: "essay-check",
      cwd: "/repo",
      agentId: "claude",
      model: "default",
      effort: null,
      wrapper: null,
      resultSchema: null,
      corsOrigins: null,
      uniqueStudent: false,
      notifyThread: null,
      preset: null,
      status: "open",
      createdBy: "discord:thread-1",
      createdUtc: now,
      authoringChannelRef: "thread-1",
      authoringParentRef: "chan-1",
      platform: "discord",
    };
    store.insertIngestEndpoint(endpoint);
    const { orch } = makeOrch();
    const { i, responded } = autocompleteI({
      group: null,
      sub: "workflows",
      option: "cancel-choice",
      value: "Ship",
    });
    await orch.handleAutocompleteInteraction(i as any);
    expect(responded[0]).toEqual([{ name: "Ship this? (ch_1)", value: "ch_1" }]);

    const { i: i2, responded: r2 } = autocompleteI({
      group: null,
      sub: "workflows",
      option: "cancel-ingest",
      value: "essay",
    });
    await orch.handleAutocompleteInteraction(i2 as any);
    expect(r2[0]).toEqual([{ name: "essay-check (ie_1)", value: "ie_1" }]);
  });

  it("steer thread lists sibling sessions in the parent channel", async () => {
    store.upsert(session({ channelRef: "thread-1", agentId: "grok" }));
    store.upsert(session({ channelRef: "thread-2", agentId: "copilot" }));
    store.upsert(session({ channelRef: "other", parentRef: "chan-other", agentId: "grok" }));
    const { orch } = makeOrch({ isBusy: (id) => id === "discord:thread-2" });
    const { i, responded } = autocompleteI({
      group: null,
      sub: "steer",
      option: "thread",
      value: "thread-2",
    });
    await orch.handleAutocompleteInteraction(i as any);
    expect(responded[0]).toEqual([
      { name: "thread-2 · copilot · busy", value: "thread-2" },
    ]);
  });

  it("preset autocomplete still works after the ctx extension", async () => {
    store.upsertPreset({
      id: "p-reviewer",
      name: "reviewer",
      projectRef: "chan-1",
      description: null,
      agentId: "grok",
      model: "grok-4",
      effort: null,
      repoPath: null,
      permission: null,
      toolsAllow: null,
      toolsExclude: null,
      instructions: null,
      statusCardStyle: null,
      createdBy: "admin",
      createdUtc: now,
      updatedUtc: now,
    });
    const { orch } = makeOrch();
    const { i, responded } = autocompleteI({
      group: "preset",
      sub: "apply",
      option: "name",
      value: "rev",
      channelId: "chan-1",
      isThread: false,
      parentId: undefined,
    });
    await orch.handleAutocompleteInteraction(i as any);
    expect((responded[0] as Array<{ value: string }>).map((c) => c.value)).toEqual(["reviewer"]);
  });
});

describe("slash autocomplete never throws", () => {
  it("store throw on schedule list → []", async () => {
    const { orch } = makeOrch();
    vi.spyOn(store, "listScheduledByChannel").mockImplementation(() => {
      throw new Error("db down");
    });
    const { i, responded } = autocompleteI({
      group: "schedule",
      sub: "toggle",
      option: "id",
      value: "x",
    });
    await expect(orch.handleAutocompleteInteraction(i as any)).resolves.toBeUndefined();
    expect(responded[0]).toEqual([]);
  });
});
