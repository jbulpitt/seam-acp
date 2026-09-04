/**
 * #192 — drain model refreshes and close manager admission.
 *
 * Production sequence (not source-text order): stop() gates admission, HTTP
 * ingress drains, then store-writing managers drain, then the #174
 * safe-to-close predicate decides whether SQLite may close.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseAaModels,
} from "../packages/core/src/core/model-metadata/artificial-analysis.js";
import { ModelMetadataManager } from "../packages/core/src/core/model-metadata/manager.js";
import { ModelMetadataStore } from "../packages/core/src/core/model-metadata/store.js";
import type { AgentModelAvailability } from "../packages/core/src/core/model-metadata/types.js";
import {
  parseAaModels as parseValueAaModels,
  parseCopilotPricingMarkdown,
} from "../packages/core/src/core/model-value/sources.js";
import { ModelValueManager } from "../packages/core/src/core/model-value/manager.js";
import { ModelValueStore } from "../packages/core/src/core/model-value/store.js";
import { ScheduledPromptManager } from "../packages/core/src/core/scheduled-prompts/manager.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import { WakeManager } from "../packages/core/src/core/wake/manager.js";
import type { WakeEvent } from "../packages/core/src/core/wake/types.js";
import { WatchManager } from "../packages/core/src/core/watch/manager.js";
import type { WatchEvent } from "../packages/core/src/core/watch/types.js";
import { ParkedPromptManager } from "../packages/core/src/core/parked-prompts/manager.js";
import type { ParkedPrompt } from "../packages/core/src/core/parked-prompts/types.js";
import type { SessionStore } from "../packages/core/src/core/session-store.js";
import {
  runBoundedStep,
  safeToCloseResources,
  undrainedStages,
  type DrainVerdict,
} from "../packages/core/src/lib/shutdown-budget.js";
import {
  drainStoreWritingManagers,
  MANAGER_CALLBACKS_STAGE,
  MODEL_METADATA_REFRESH_STAGE,
  MODEL_VALUE_REFRESH_STAGE,
  type DrainableManager,
  type StoreWritingManagers,
} from "../packages/core/src/lib/shutdown-managers.js";

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return path.join(dir, "seam.db");
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
};

const idle: DrainableManager = { drain: async () => {} };

const aaPayload = {
  data: [
    {
      id: "aa-sol",
      name: "GPT-5.6 Sol (max)",
      slug: "gpt-5-6-sol",
      release_date: "2026-03-01",
      model_creator: { id: "openai-id", name: "OpenAI", slug: "openai" },
      evaluations: { artificial_analysis_intelligence_index: 60, coding_index: 90 },
      pricing: {
        price_1m_input_tokens: 1,
        price_1m_output_tokens: 4,
        price_1m_blended_3_to_1: 1.75,
      },
    },
  ],
};

const catalog: AgentModelAvailability[] = [
  {
    agentId: "copilot",
    modelId: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    contextWindow: 1_000_000,
    vision: false,
  },
];

const pricingMarkdown = `
## OpenAI

| Model | Release status | Category | Input | Cached input | Output |
| --- | --- | --- | ---: | ---: | ---: |
| GPT-5.6 Sol | GA | Standard | $1.00 | $0.10 | $4.00 |
`;

const copilotModels = [
  {
    modelId: "gpt-5.6-sol",
    displayName: "GPT-5.6 Sol",
    validEffortTiers: ["low", "high"],
    priceCategory: "medium",
  },
];

function httpDrained(): DrainVerdict[] {
  return [
    { stage: "seam-mcp-ingress", drained: true },
    { stage: "health-ingress", drained: true },
  ];
}

function laterStagesDrained(): DrainVerdict[] {
  return [
    { stage: "pre-dispose-quiesce", drained: true },
    { stage: "voice-console-shutdown", drained: true },
    { stage: "live-help-shutdown", drained: true },
    { stage: "router-dispose", drained: true },
    { stage: "post-dispose-drain", drained: true },
  ];
}

function instrument<T extends object>(store: T, methods: (keyof T)[]) {
  let closed = false;
  const violations: string[] = [];
  for (const name of methods) {
    const orig = (store[name] as (...args: never[]) => unknown).bind(store);
    (store as Record<string, unknown>)[String(name)] = (...args: never[]) => {
      if (closed) {
        violations.push(String(name));
        throw new TypeError("The database connection is not open");
      }
      return orig(...args);
    };
  }
  if ("close" in store && typeof store.close === "function") {
    const origClose = store.close.bind(store);
    (store as { close: () => void }).close = () => {
      closed = true;
      origClose();
    };
  }
  return {
    get closed() {
      return closed;
    },
    violations,
  };
}

function runGroup(timeoutMs: number) {
  return (label: string, work: () => Promise<unknown>) =>
    runBoundedStep({ label, timeoutMs, work });
}

async function productionClose(
  managers: StoreWritingManagers,
  close: () => void,
  timeoutMs = 2_000
): Promise<DrainVerdict[]> {
  const managerVerdicts = await drainStoreWritingManagers(managers, runGroup(timeoutMs));
  const verdicts = [...httpDrained(), ...managerVerdicts, ...laterStagesDrained()];
  if (safeToCloseResources(verdicts)) close();
  return verdicts;
}

function makeMetadata(fetch: () => Promise<ReturnType<typeof parseAaModels>>) {
  const store = new ModelMetadataStore(tempDbPath("seam-192-meta-"));
  const guard = instrument(store, ["getAll", "replaceSnapshot"]);
  const manager = new ModelMetadataManager({
    store,
    logger: silentLogger,
    source: { name: "fixture", fetch },
    getCatalog: async () => catalog,
    now: () => new Date("2026-09-03T00:00:00.000Z"),
  });
  return { store, manager, guard };
}

function makeValue(fetchAa: () => Promise<ReturnType<typeof parseValueAaModels>>) {
  const store = new ModelValueStore(tempDbPath("seam-192-value-"), {
    inputTokens: 8000,
    outputTokens: 2000,
  });
  const guard = instrument(store, ["saveSnapshot"]);
  const manager = new ModelValueManager({
    store,
    logger: silentLogger,
    aaApiKey: "test",
    inputTokens: 8000,
    outputTokens: 2000,
    fetchAa,
    fetchPricing: async () => parseCopilotPricingMarkdown(pricingMarkdown),
    fetchCopilot: async () => copilotModels,
  });
  return { store, manager, guard };
}

describe("#192 production-sequence manager drains", () => {
  it("awaits an in-flight metadata refresh before the store can close", async () => {
    const gate = deferred();
    const { store, manager, guard } = makeMetadata(async () => {
      await gate.promise;
      return parseAaModels(aaPayload);
    });
    const running = manager.refresh();
    manager.stop();
    let drained = false;
    const closing = productionClose(
      {
        scheduled: idle,
        wake: idle,
        watch: idle,
        parked: idle,
        modelMetadata: manager,
        modelValue: idle,
      },
      () => store.close()
    ).then((verdicts) => {
      drained = true;
      return verdicts;
    });
    await flush();
    expect(drained).toBe(false);
    expect(guard.closed).toBe(false);
    gate.resolve();
    const verdicts = await closing;
    await running;
    expect(verdicts.find((v) => v.stage === MODEL_METADATA_REFRESH_STAGE)?.drained).toBe(true);
    expect(safeToCloseResources(verdicts)).toBe(true);
    expect(guard.closed).toBe(true);
    expect(guard.violations).toEqual([]);
  });

  it("awaits an in-flight value refresh before the store can close", async () => {
    const gate = deferred();
    const { store, manager, guard } = makeValue(async () => {
      await gate.promise;
      return parseValueAaModels(aaPayload);
    });
    const running = manager.refresh();
    manager.stop();
    let drained = false;
    const closing = productionClose(
      {
        scheduled: idle,
        wake: idle,
        watch: idle,
        parked: idle,
        modelMetadata: idle,
        modelValue: manager,
      },
      () => store.close()
    ).then((verdicts) => {
      drained = true;
      return verdicts;
    });
    await flush();
    expect(drained).toBe(false);
    expect(guard.closed).toBe(false);
    gate.resolve();
    const verdicts = await closing;
    await running;
    expect(verdicts.find((v) => v.stage === MODEL_VALUE_REFRESH_STAGE)?.drained).toBe(true);
    expect(safeToCloseResources(verdicts)).toBe(true);
    expect(guard.closed).toBe(true);
    expect(guard.violations).toEqual([]);
  });

  it("NEGATIVE CONTROL: skipping the metadata drain closes the store under the refresh", async () => {
    const gate = deferred();
    const { store, manager, guard } = makeMetadata(async () => {
      await gate.promise;
      return parseAaModels(aaPayload);
    });
    const running = manager.refresh();
    manager.stop();
    const verdicts = await productionClose(
      {
        scheduled: idle,
        wake: idle,
        watch: idle,
        parked: idle,
        modelMetadata: { drain: async () => {} },
        modelValue: idle,
      },
      () => store.close()
    );
    expect(safeToCloseResources(verdicts)).toBe(true);
    expect(guard.closed).toBe(true);
    gate.resolve();
    await running.catch(() => {});
    await flush();
    expect(guard.violations.some((name) => name === "getAll" || name === "replaceSnapshot")).toBe(
      true
    );
  });

  it("NEGATIVE CONTROL: skipping the value drain closes the store under the refresh", async () => {
    const gate = deferred();
    const { store, manager, guard } = makeValue(async () => {
      await gate.promise;
      return parseValueAaModels(aaPayload);
    });
    const running = manager.refresh();
    manager.stop();
    const verdicts = await productionClose(
      {
        scheduled: idle,
        wake: idle,
        watch: idle,
        parked: idle,
        modelMetadata: idle,
        modelValue: { drain: async () => {} },
      },
      () => store.close()
    );
    expect(safeToCloseResources(verdicts)).toBe(true);
    expect(guard.closed).toBe(true);
    gate.resolve();
    await running.catch(() => {});
    await flush();
    expect(guard.violations).toContain("saveSnapshot");
  });

  it("a rejected model drain is reported and keeps the store open", async () => {
    const { store, guard } = makeMetadata(async () => parseAaModels(aaPayload));
    const verdicts = await productionClose(
      {
        scheduled: idle,
        wake: idle,
        watch: idle,
        parked: idle,
        modelMetadata: {
          drain: async () => {
            throw new Error("drain exploded");
          },
        },
        modelValue: idle,
      },
      () => store.close()
    );
    expect(verdicts.find((v) => v.stage === MODEL_METADATA_REFRESH_STAGE)?.drained).toBe(false);
    expect(verdicts.find((v) => v.stage === MANAGER_CALLBACKS_STAGE)?.drained).toBe(false);
    expect(undrainedStages(verdicts)).toEqual(
      expect.arrayContaining([MANAGER_CALLBACKS_STAGE, MODEL_METADATA_REFRESH_STAGE])
    );
    expect(safeToCloseResources(verdicts)).toBe(false);
    expect(guard.closed).toBe(false);
  });

  it("a timed-out model drain is reported and keeps the store open", async () => {
    const { store, guard } = makeValue(async () => parseValueAaModels(aaPayload));
    const verdicts = await productionClose(
      {
        scheduled: idle,
        wake: idle,
        watch: idle,
        parked: idle,
        modelMetadata: idle,
        modelValue: { drain: () => new Promise(() => {}) },
      },
      () => store.close(),
      40
    );
    expect(verdicts.find((v) => v.stage === MODEL_VALUE_REFRESH_STAGE)?.drained).toBe(false);
    expect(safeToCloseResources(verdicts)).toBe(false);
    expect(guard.closed).toBe(false);
  });
});

describe("#192 manager admission after stop", () => {
  it("a metadata tick queued after stop does not write SQLite", async () => {
    const fetch = vi.fn(async () => parseAaModels(aaPayload));
    const { store, manager } = makeMetadata(fetch);
    manager.stop();
    (manager as unknown as { onRefreshTick(): void }).onRefreshTick();
    await manager.refresh();
    expect(fetch).not.toHaveBeenCalled();
    expect(store.getAll()).toEqual([]);
  });

  it("a value tick queued after stop does not write SQLite", async () => {
    const fetchAa = vi.fn(async () => parseValueAaModels(aaPayload));
    const { store, manager } = makeValue(fetchAa);
    manager.stop();
    (manager as unknown as { onRefreshTick(): void }).onRefreshTick();
    await manager.refresh();
    expect(fetchAa).not.toHaveBeenCalled();
    expect(store.getRankings().fetched_at).toBeNull();
  });

  it("NEGATIVE CONTROL: skipping the metadata admission gate writes after stop", async () => {
    const { store, manager } = makeMetadata(async () => parseAaModels(aaPayload));
    manager.stop();
    await (manager as unknown as { refreshInner(): Promise<void> }).refreshInner();
    expect(store.getAll()).toHaveLength(1);
  });

  it("a scheduled cron tick after stop does not touch SQLite or enqueue work", async () => {
    const row = makeScheduledRow();
    const { store, upserts } = makeScheduledStore(row);
    const onFire = vi.fn(async () => {});
    const manager = new ScheduledPromptManager({ store, onFire, logger: silentLogger });
    manager.stop();
    (manager as unknown as { onCronTick(id: string): void }).onCronTick(row.id);
    await flush();
    expect(onFire).not.toHaveBeenCalled();
    expect(upserts).toEqual([]);
    manager.armFromRow(row);
    expect(upserts).toEqual([]);
  });

  it("runNow after stop still registers so an admitted HTTP fire is not dropped", async () => {
    const row = makeScheduledRow();
    const { store } = makeScheduledStore(row);
    const gate = deferred();
    const onFire = vi.fn(async () => gate.promise);
    const manager = new ScheduledPromptManager({ store, onFire, logger: silentLogger });
    manager.stop();
    const running = manager.runNow(row.id);
    let drained = false;
    const drain = manager.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);
    gate.resolve();
    await Promise.all([running, drain]);
    expect(drained).toBe(true);
  });

  it("a wake sweep tick after stop does not delete or fire", async () => {
    const wake = makeWake();
    const { store, deletes } = makeWakeStore([wake]);
    const onFire = vi.fn(async () => {});
    const manager = new WakeManager({ store, onFire, logger: silentLogger });
    manager.stop();
    (manager as unknown as { onSweepTick(): void }).onSweepTick();
    await manager.sweep();
    expect(onFire).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
  });

  it("NEGATIVE CONTROL: skipping the wake admission gate deletes after stop", async () => {
    const wake = makeWake();
    const { store, deletes } = makeWakeStore([wake]);
    const onFire = vi.fn(async () => {});
    const manager = new WakeManager({ store, onFire, logger: silentLogger });
    manager.stop();
    await (manager as unknown as { sweepInner(): Promise<void> }).sweepInner();
    expect(deletes).toEqual(["wake-1"]);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("a watch sweep tick after stop does not evaluate or write", async () => {
    const { store, deletes } = makeWatchStore([makeWatch()]);
    const evaluate = vi.fn(async () => ({ fired: true, eventText: "x", observed: "x" }));
    const onFire = vi.fn(async () => {});
    const manager = new WatchManager({
      store,
      evaluate,
      onFire,
      onExpire: async () => {},
      onStopped: async () => {},
      logger: silentLogger,
    });
    manager.stop();
    (manager as unknown as { onSweepTick(): void }).onSweepTick();
    await manager.sweep();
    expect(evaluate).not.toHaveBeenCalled();
    expect(onFire).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
  });

  it("a parked hub event after stop does not delete or fire", async () => {
    const parked = makeParked();
    const { store, deletes } = makeParkedStore([parked]);
    const onFire = vi.fn(async () => {});
    const manager = new ParkedPromptManager({
      store,
      hub: {
        isBridgeReady: () => true,
        onBridgeReady: () => () => {},
      },
      onFire,
      logger: silentLogger,
    });
    manager.stop();
    (manager as unknown as { onHubReady(id: string): void }).onHubReady("mac");
    await manager.fireLocation("mac");
    expect(onFire).not.toHaveBeenCalled();
    expect(deletes).toEqual([]);
  });
});

function makeScheduledRow(): ScheduledPrompt {
  return {
    id: "sch_live",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    name: "live nightly",
    promptText: "summarize the day",
    cron: "0 9 * * *",
    timezone: "UTC",
    model: null,
    cwd: null,
    targetChannel: null,
    outputType: "card",
    sessionMode: "live",
    catchupSeconds: 900,
    enabled: true,
    legacyAttachmentCount: 0,
    createdBy: "user-1",
    createdUtc: new Date().toISOString(),
    updatedUtc: new Date().toISOString(),
    lastRunUtc: null,
    lastStatus: null,
    nextRunUtc: null,
    pinnedSessionId: null,
  };
}

function makeScheduledStore(row: ScheduledPrompt) {
  const upserts: ScheduledPrompt[] = [];
  const store = {
    getScheduled: (id: string) => (id === row.id ? { ...row } : null),
    upsertScheduled: (s: ScheduledPrompt) => {
      upserts.push(s);
      Object.assign(row, s);
    },
    listScheduledEnabled: () => (row.enabled ? [{ ...row }] : []),
  } as unknown as SessionStore;
  return { store, upserts };
}

function makeWake(over: Partial<WakeEvent> = {}): WakeEvent {
  const now = Date.now();
  return {
    id: "wake-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    fireAtUtc: new Date(now - 1000).toISOString(),
    prompt: "resume",
    reason: "why",
    createdBy: "discord:thread-1",
    correlationId: null,
    chainDepth: 0,
    catchupSeconds: 900,
    fireOnStartup: false,
    createdUtc: new Date(now).toISOString(),
    ...over,
  };
}

function makeWakeStore(initial: WakeEvent[]) {
  const rows = new Map(initial.map((w) => [w.id, w]));
  const deletes: string[] = [];
  const store = {
    listDueWakes: (nowIso: string) =>
      [...rows.values()]
        .filter((w) => w.fireAtUtc <= nowIso && !w.fireOnStartup)
        .sort((a, b) => a.fireAtUtc.localeCompare(b.fireAtUtc)),
    listStartupWakes: () => [...rows.values()].filter((w) => w.fireOnStartup),
    deleteWake: (id: string) => {
      deletes.push(id);
      rows.delete(id);
    },
  } as unknown as SessionStore;
  return { store, rows, deletes };
}

function makeWatch(): WatchEvent {
  const now = Date.now();
  return {
    id: "w1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: null,
    kind: "file",
    spec: "/tmp/x",
    match: null,
    intervalSeconds: 30,
    prompt: "resume",
    reason: "why",
    mode: "once",
    maxFires: 1,
    fireCount: 0,
    lastCheckedUtc: null,
    lastFiredUtc: null,
    lastObserved: null,
    expiresAtUtc: new Date(now + 3600_000).toISOString(),
    createdBy: "discord:thread-1",
    correlationId: null,
    createdUtc: new Date(now).toISOString(),
  };
}

function makeWatchStore(initial: WatchEvent[]) {
  const rows = new Map(initial.map((w) => [w.id, { ...w }]));
  const deletes: string[] = [];
  const store = {
    listAllWatches: () => [...rows.values()],
    markWatchChecked: (id: string, checkedUtc: string, observed: string | null) => {
      const w = rows.get(id);
      if (w) {
        w.lastCheckedUtc = checkedUtc;
        w.lastObserved = observed;
      }
    },
    incrementWatchFire: (id: string, firedUtc: string) => {
      const w = rows.get(id);
      if (w) {
        w.fireCount += 1;
        w.lastFiredUtc = firedUtc;
      }
    },
    deleteWatch: (id: string) => {
      deletes.push(id);
      rows.delete(id);
    },
  };
  return { store, rows, deletes };
}

function makeParked(): ParkedPrompt {
  return {
    id: "park-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "channel-1",
    location: "mac",
    kind: "bridge_offline",
    prompt: "hello",
    authorId: "u1",
    authorName: "Jesse",
    noticeMessageId: "m1",
    attachments: [],
    createdUtc: "2026-08-18T00:00:00.000Z",
  };
}

function makeParkedStore(initial: ParkedPrompt[]) {
  const rows = new Map(initial.map((p) => [p.id, p]));
  const deletes: string[] = [];
  const store = {
    listParked: () => [...rows.values()],
    listParkedByLocation: (location: string) =>
      [...rows.values()].filter((p) => p.location === location),
    deleteParked: (id: string) => {
      deletes.push(id);
      rows.delete(id);
    },
  } as unknown as SessionStore;
  return { store, rows, deletes };
}
