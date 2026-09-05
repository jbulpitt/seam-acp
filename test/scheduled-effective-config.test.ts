/**
 * #208 — scheduled builder + isolated fire must inherit the binding thread's
 * *effective* agent/model/cwd (`describeConfig`), not stale session columns.
 *
 * Schedule-adjacent `record.agentId` / `record.repoPath` classification:
 *   - cmdScheduleAdd + isolated `runScheduledPromptInner`: EFFECTIVE thread
 *     identity. Covered here.
 *   - Isolated announce/result cards: same identity the runtime received.
 *   - `runIsolatedScheduledJob` `record` argument: DURABLE authoring session
 *     (MCP token reuse). `profile` is the execution agent. Covered here.
 *   - Live-mode fire: does not resolve isolated overrides; re-enters the live
 *     turn queue. Covered here.
 *   - `/seamadmin schedule list` summary line: stored schedule.model override
 *     only (schedule-row identity, not thread identity). Unchanged.
 *   - Other orchestrator `record.agentId` / `record.repoPath` readers
 *     (quota, compaction, usage, config edit, dispatch) are not schedule
 *     execution and were not rewritten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { AgentProfile } from "@seam/adapters";
import type { ThreadPreset } from "../packages/core/src/config.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const THREAD = "1545798689216397383";
const PARENT = "111111111111111111";
const REPOS_ROOT = "/repos-root";
const STALE_CWD = "/stale/copilot-cwd";
const EFFECTIVE_CWD = "/home/ubuntu/Projects/seam-acp";
const OVERRIDE_CWD = "/override/scheduled-cwd";
const STALE_MODEL = "claude-sonnet-4.6";
const EFFECTIVE_MODEL = "grok-4.6";
const COPILOT_MODEL = "gpt-5.4";

const COPILOT_MODELS = [
  { modelId: COPILOT_MODEL, name: "GPT-5.4" },
  { modelId: STALE_MODEL, name: "Claude Sonnet 4.6" },
];
const GROK_MODELS = [
  { modelId: EFFECTIVE_MODEL, name: "Grok 4.6" },
  { modelId: "grok-4.5", name: "Grok 4.5" },
];

const profiles = [
  {
    id: "copilot",
    displayName: "Copilot",
    defaultModel: COPILOT_MODEL,
    staticModels: COPILOT_MODELS,
    effort: { mechanism: "none", levels: [] },
  },
  {
    id: "grok",
    displayName: "Grok Build",
    defaultModel: EFFECTIVE_MODEL,
    staticModels: GROK_MODELS,
    effort: { mechanism: "spawnArgs", levels: ["low", "medium", "high"] },
  },
] as unknown as AgentProfile[];

function schedule(over: Partial<ScheduledPrompt> = {}): ScheduledPrompt {
  return {
    id: "sch_208",
    platform: "discord",
    channelRef: THREAD,
    parentRef: PARENT,
    name: "Nightly",
    promptText: "Follow docs/runbooks/nightly.md.",
    cron: "0 7 * * *",
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
    createdUtc: "2026-01-01T00:00:00.000Z",
    updatedUtc: "2026-01-01T00:00:00.000Z",
    lastRunUtc: null,
    lastStatus: null,
    nextRunUtc: null,
    pinnedSessionId: null,
    ...over,
  };
}

function jsonOf(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "toJSON" in value &&
    typeof (value as { toJSON: () => unknown }).toJSON === "function"
  ) {
    return (value as { toJSON: () => unknown }).toJSON();
  }
  return value;
}

function collectModelOptions(
  node: unknown,
  into: Array<{ label: string; value: string }>
): void {
  if (!node || typeof node !== "object") return;
  const rec = node as Record<string, unknown>;
  if (rec.custom_id === "sched:model" || rec.customId === "sched:model") {
    const opts = rec.options as Array<{ label: string; value: string }> | undefined;
    if (opts) into.push(...opts);
  }
  for (const v of Object.values(rec)) {
    if (Array.isArray(v)) v.forEach((item) => collectModelOptions(item, into));
    else collectModelOptions(v, into);
  }
}

function modelSelectValues(card: { components: unknown[] }): string[] {
  const options: Array<{ label: string; value: string }> = [];
  for (const row of card.components) collectModelOptions(jsonOf(row), options);
  return options.map((o) => o.value);
}

function embedPayload(card: { embeds: unknown[] }): {
  title?: string;
  description?: string;
  fields?: Array<{ name: string; value: string }>;
} {
  return (jsonOf(card.embeds[0]) ?? {}) as {
    title?: string;
    description?: string;
    fields?: Array<{ name: string; value: string }>;
  };
}

function fieldValue(
  fields: Array<{ name: string; value: string }> | undefined,
  name: string
): string | undefined {
  return fields?.find((f) => f.name === name || f.name.includes(name))?.value;
}

interface Harness {
  dir: string;
  store: SessionStore;
  router: SessionRouter;
  threadPresets: Map<string, ThreadPreset>;
  record: SessionRecord;
}

function makeHarness(over: { repoPath?: string | null } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-208-"));
  const store = new SessionStore(path.join(dir, "seam.db"));
  const threadPresets = new Map<string, ThreadPreset>([
    [
      THREAD,
      {
        agent: { value: "grok" },
        model: { value: EFFECTIVE_MODEL },
        cwd: { value: EFFECTIVE_CWD },
        effort: { value: "high" },
      },
    ],
  ]);
  const router = new SessionRouter({
    logger: silent,
    store,
    profiles,
    defaultAgentId: "copilot",
    defaultModel: COPILOT_MODEL,
    defaultPermissionMode: "ask",
    threadPresets,
  });
  const record: SessionRecord = {
    id: `discord:${THREAD}`,
    platform: "discord",
    channelRef: THREAD,
    parentRef: PARENT,
    agentId: "copilot",
    acpSessionId: "stale-acp",
    repoPath: over.repoPath === undefined ? STALE_CWD : over.repoPath,
    configJson: JSON.stringify({ model: STALE_MODEL, reasoningEffort: "low" }),
    createdUtc: "2026-01-01T00:00:00.000Z",
    updatedUtc: "2026-01-01T00:00:00.000Z",
  };
  store.upsert(record);
  return { dir, store, router, threadPresets, record };
}

function noopLifecycle() {
  return {
    settled: false,
    state: null,
    reason: null,
    refresh: async () => true,
    transition: async () => true,
    terminal: async () => true,
    dispose: async () => true,
    expire: async () => true,
    handleEnd: async () => {},
  };
}

interface RenderedCard {
  embeds: unknown[];
  components: unknown[];
}

async function renderBuilder(
  harness: Harness,
  existing?: ScheduledPrompt,
  routerOver?: Partial<Harness["router"]> & {
    describeConfig?: SessionRouter["describeConfig"];
    getProfile?: SessionRouter["getProfile"];
  }
): Promise<{ card: RenderedCard; getProfile: ReturnType<typeof vi.fn> }> {
  let card: RenderedCard | undefined;
  const interaction = {
    isChatInputCommand: () => true,
    user: { id: "user-jesse" },
    deferred: false,
    replied: false,
    reply: async (payload: RenderedCard) => {
      card = payload;
    },
    fetchReply: async () => ({
      id: "msg-1",
      createMessageComponentCollector: () => ({ on: () => {}, stop: () => {} }),
    }),
    editReply: async () => {},
  };
  const getProfile = vi.fn((id: string) =>
    routerOver?.getProfile
      ? routerOver.getProfile.call(harness.router, id)
      : harness.router.getProfile(id)
  );
  const self = Object.create(Orchestrator.prototype) as Record<string, unknown>;
  Object.assign(self, {
    channelRefFromInteraction: () => ({
      platform: "discord",
      id: THREAD,
      parentId: PARENT,
    }),
    config: { REPOS_ROOT },
    router: {
      ensureSessionRecord: (opts: Parameters<SessionRouter["ensureSessionRecord"]>[0]) =>
        harness.router.ensureSessionRecord(opts),
      describeConfig: (rec: SessionRecord) =>
        routerOver?.describeConfig
          ? routerOver.describeConfig.call(harness.router, rec)
          : harness.router.describeConfig(rec),
      getProfile,
    },
    store: harness.store,
    logger: silent,
    attachListLifecycle: () => noopLifecycle(),
  });
  await (
    Orchestrator.prototype as unknown as {
      cmdScheduleAdd(this: unknown, i: unknown, existing?: ScheduledPrompt): Promise<void>;
    }
  ).cmdScheduleAdd.call(self, interaction, existing);
  if (!card) throw new Error("builder card was never rendered");
  return { card, getProfile };
}

interface FireCapture {
  jobs: Array<{
    profile: { id: string };
    record: SessionRecord;
    cwd: string;
    model?: string;
    effort?: string;
    promptText: string;
  }>;
  panels: Array<{ title?: string; fields?: Array<{ name: string; value: string }> }>;
  getProfile: ReturnType<typeof vi.fn>;
  describeConfig: ReturnType<typeof vi.fn>;
  queueCalls: number;
  liveMessages: Array<Record<string, unknown>>;
  statuses: string[];
}

async function fireSchedule(
  harness: Harness,
  row: ScheduledPrompt,
  over: {
    describeConfig?: SessionRouter["describeConfig"];
  } = {}
): Promise<FireCapture> {
  const jobs: FireCapture["jobs"] = [];
  const panels: FireCapture["panels"] = [];
  const liveMessages: Array<Record<string, unknown>> = [];
  const getProfile = vi.fn((id: string) => harness.router.getProfile(id));
  const describeConfig = vi.fn((rec: SessionRecord) =>
    over.describeConfig
      ? over.describeConfig.call(harness.router, rec)
      : harness.router.describeConfig(rec)
  );
  harness.store.upsertScheduled(row);
  const statuses: string[] = [];
  const origUpsert = harness.store.upsertScheduled.bind(harness.store);
  harness.store.upsertScheduled = ((next: ScheduledPrompt) => {
    if (next.lastStatus) statuses.push(next.lastStatus);
    origUpsert(next);
  }) as SessionStore["upsertScheduled"];

  const self = Object.create(Orchestrator.prototype) as Record<string, unknown>;
  let queueCalls = 0;
  Object.assign(self, {
    adapter: {
      getThreadLiveState: async () => ({ locked: false, archived: false }),
      sendPanel: async (_ch: unknown, panel: FireCapture["panels"][number]) => {
        panels.push(panel);
      },
    },
    logger: silent,
    store: harness.store,
    config: { REPOS_ROOT, TURN_TIMEOUT_SECONDS: 60 },
    router: {
      ensureSessionRecord: (opts: Parameters<SessionRouter["ensureSessionRecord"]>[0]) =>
        harness.router.ensureSessionRecord(opts),
      describeConfig,
      getProfile,
      reuseMcpServers: () => [],
    },
    runIsolatedScheduledJob: vi.fn(async (args: FireCapture["jobs"][number]) => {
      jobs.push(args);
      return { text: "isolated-ok" };
    }),
    channelGenerations: new Map<string, number>(),
    queueOnChannel: async (_c: string, fn: () => Promise<void>) => {
      queueCalls += 1;
      await fn();
    },
    handleIncomingMessageInner: async (m: Record<string, unknown>) => {
      liveMessages.push(m);
    },
    voiceConsole: null,
  });
  await (
    Orchestrator.prototype as unknown as {
      runScheduledPromptInner(this: unknown, row: ScheduledPrompt): Promise<void>;
    }
  ).runScheduledPromptInner.call(self, row);
  return { jobs, panels, getProfile, describeConfig, queueCalls, liveMessages, statuses };
}

let harness: Harness;

beforeEach(() => {
  harness = makeHarness();
});
afterEach(() => {
  harness.store.close();
  fs.rmSync(harness.dir, { recursive: true, force: true });
});

describe("#208 schedule builder inherits effective thread config", () => {
  it("uses the effective agent's catalog and default when the session row is still copilot", async () => {
    const { card, getProfile } = await renderBuilder(harness);
    const values = modelSelectValues(card);
    const fields = embedPayload(card).fields;
    const blob = JSON.stringify({
      embeds: card.embeds.map(jsonOf),
      components: card.components.map(jsonOf),
    });

    expect(getProfile).toHaveBeenCalledWith("grok");
    expect(getProfile.mock.calls.map((c) => c[0])).not.toContain("copilot");
    expect(values).toContain("__default__");
    expect(values).toContain(EFFECTIVE_MODEL);
    expect(values).toContain("grok-4.5");
    expect(values).not.toContain(STALE_MODEL);
    expect(values).not.toContain(COPILOT_MODEL);
    expect(fieldValue(fields, "Agent")).toContain("grok");
    expect(fieldValue(fields, "Agent")).not.toContain("copilot");
    expect(fieldValue(fields, "Model")).toContain(EFFECTIVE_MODEL);
    expect(fieldValue(fields, "Model")).not.toContain(STALE_MODEL);
    expect(blob).toContain(EFFECTIVE_MODEL);
    expect(blob).not.toContain(STALE_MODEL);
    expect(blob).not.toContain(COPILOT_MODEL);
  });

  it("shows the effective cwd, not REPOS_ROOT, when the session repoPath is empty", async () => {
    harness.store.close();
    fs.rmSync(harness.dir, { recursive: true, force: true });
    harness = makeHarness({ repoPath: null });
    const { card } = await renderBuilder(harness);
    const cwd = fieldValue(embedPayload(card).fields, "Working dir");
    expect(cwd).toContain(EFFECTIVE_CWD);
    expect(cwd).not.toContain(REPOS_ROOT);
    expect(cwd).not.toContain(STALE_CWD);
  });
});

describe("#208 isolated fire re-resolves effective config", () => {
  it("invokes the effective agent/model/cwd, not stale session columns", async () => {
    harness.store.close();
    fs.rmSync(harness.dir, { recursive: true, force: true });
    harness = makeHarness({ repoPath: null });
    const captured = await fireSchedule(harness, schedule());

    expect(captured.jobs).toHaveLength(1);
    const job = captured.jobs[0]!;
    expect(job.profile.id).toBe("grok");
    expect(job.model).toBe(EFFECTIVE_MODEL);
    expect(job.cwd).toBe(EFFECTIVE_CWD);
    expect(job.effort).toBe("high");
    // Durable authoring session (MCP reuse) may still be copilot; execution must not.
    expect(job.record.agentId).toBe("copilot");
    expect(job.record.repoPath).toBeNull();
    expect(job.profile.id).not.toBe("copilot");
    expect(job.model).not.toBe(STALE_MODEL);
    expect(job.cwd).not.toBe(REPOS_ROOT);
    expect(job.cwd).not.toBe(STALE_CWD);
    expect(captured.getProfile.mock.calls.map((c) => c[0])).toContain("grok");
    expect(captured.getProfile.mock.calls.map((c) => c[0])).not.toContain("copilot");
    expect(captured.describeConfig).toHaveBeenCalled();
  });

  it("applies explicit schedule model and cwd overrides after effective resolution", async () => {
    harness.store.close();
    fs.rmSync(harness.dir, { recursive: true, force: true });
    harness = makeHarness({ repoPath: null });
    const captured = await fireSchedule(
      harness,
      schedule({ model: "grok-4.5", cwd: OVERRIDE_CWD })
    );
    const job = captured.jobs[0]!;
    expect(job.profile.id).toBe("grok");
    expect(job.model).toBe("grok-4.5");
    expect(job.cwd).toBe(OVERRIDE_CWD);
    expect(job.model).not.toBe(STALE_MODEL);
    expect(job.model).not.toBe(EFFECTIVE_MODEL);
  });

  it("re-reads live effective config at fire time after the thread overlay changes", async () => {
    harness.store.close();
    fs.rmSync(harness.dir, { recursive: true, force: true });
    harness = makeHarness({ repoPath: null });
    harness.threadPresets.set(THREAD, {
      agent: { value: "copilot" },
      model: { value: COPILOT_MODEL },
      cwd: { value: "/tmp/before" },
    });
    const row = schedule();
    harness.store.upsertScheduled(row);
    harness.threadPresets.set(THREAD, {
      agent: { value: "grok" },
      model: { value: EFFECTIVE_MODEL },
      cwd: { value: EFFECTIVE_CWD },
      effort: { value: "high" },
    });
    const captured = await fireSchedule(harness, row);
    const job = captured.jobs[0]!;
    expect(job.profile.id).toBe("grok");
    expect(job.model).toBe(EFFECTIVE_MODEL);
    expect(job.cwd).toBe(EFFECTIVE_CWD);
    expect(job.cwd).not.toBe("/tmp/before");
    expect(job.profile.id).not.toBe("copilot");
  });

  it("consumes described.cwd.value even when it differs from record.repoPath (negative control)", async () => {
    const captured = await fireSchedule(harness, schedule(), {
      describeConfig: (rec) => {
        const described = harness.router.describeConfig(rec);
        return {
          ...described,
          cwd: { value: "/from-describe-config", source: "thread preset" },
        };
      },
    });
    const job = captured.jobs[0]!;
    expect(job.cwd).toBe("/from-describe-config");
    expect(job.cwd).not.toBe(STALE_CWD);
    expect(job.cwd).not.toBe(REPOS_ROOT);
    expect(job.record.repoPath).toBe(STALE_CWD);
  });

  it("fails closed on an unknown effective agent and never falls back to the session agent", async () => {
    harness.threadPresets.set(THREAD, {
      agent: { value: "not-a-real-agent" },
      model: { value: EFFECTIVE_MODEL },
    });
    const captured = await fireSchedule(harness, schedule());
    expect(captured.jobs).toEqual([]);
    expect(captured.statuses.some((s) => s.includes("unknown agent not-a-real-agent"))).toBe(
      true
    );
    expect(captured.getProfile).toHaveBeenCalledWith("not-a-real-agent");
    expect(captured.getProfile.mock.calls.map((c) => c[0])).not.toContain("copilot");
    expect(captured.panels).toEqual([]);
  });
});

describe("#208 live-mode schedule is unchanged", () => {
  it("re-enters the live turn queue and does not apply isolated model/cwd overrides", async () => {
    const captured = await fireSchedule(
      harness,
      schedule({
        sessionMode: "live",
        model: "grok-4.5",
        cwd: OVERRIDE_CWD,
      })
    );
    expect(captured.jobs).toEqual([]);
    expect(captured.queueCalls).toBe(1);
    expect(captured.liveMessages).toHaveLength(1);
    expect(captured.liveMessages[0]!.text).toContain("Follow docs/runbooks/nightly.md.");
    expect(captured.describeConfig).not.toHaveBeenCalled();
    expect(captured.getProfile).not.toHaveBeenCalled();
    expect(captured.statuses).toEqual(["ok"]);
  });
});

describe("#208 running and result cards match the isolated invocation", () => {
  it("reports the same effective agent/model/cwd the runtime received", async () => {
    harness.store.close();
    fs.rmSync(harness.dir, { recursive: true, force: true });
    harness = makeHarness({ repoPath: null });
    const captured = await fireSchedule(harness, schedule());
    const job = captured.jobs[0]!;
    expect(captured.panels.length).toBeGreaterThanOrEqual(2);
    const running = captured.panels.find((p) => p.title?.includes("Running scheduled"));
    const result = captured.panels.find((p) => p.title && !p.title.includes("Running scheduled"));
    expect(running).toBeDefined();
    expect(result).toBeDefined();
    for (const panel of [running, result]) {
      expect(fieldValue(panel!.fields, "Agent")).toBe(`\`${job.profile.id}\``);
      expect(fieldValue(panel!.fields, "Model")).toBe(`\`${job.model}\``);
      expect(fieldValue(panel!.fields, "Working dir")).toBe(`\`${job.cwd}\``);
      expect(fieldValue(panel!.fields, "Agent")).not.toContain("copilot");
      expect(fieldValue(panel!.fields, "Model")).not.toContain(STALE_MODEL);
      expect(fieldValue(panel!.fields, "Working dir")).not.toContain(REPOS_ROOT);
    }
  });
});
