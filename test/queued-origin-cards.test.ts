import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { createRuntimeDispatchWatcher, type DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { enqueueDispatchSpec, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import { makeChoiceCustomId, makeChoiceSelectId, makeChoiceConfirmId } from "../packages/core/src/core/choice/types.js";
import type { ChannelRef, MessageRef } from "../packages/core/src/platforms/chat-adapter.js";
import type { SessionRecord, StructuredPanel } from "../packages/core/src/core/types.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { attachLocalBridge } from "./local-bridge-fixture.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
let dataDir: string;
let store: SessionStore;
let orch: Orchestrator;
let watcher: DispatchWatcher;
let tasks: Promise<unknown>[];
let releaseBusy: ReturnType<typeof deferred>;
let releaseNext: ReturnType<typeof deferred>;
let busyEntered: ReturnType<typeof deferred>;
let nextEntered: ReturnType<typeof deferred>;
let prompts: string[];
let panels: Map<string, StructuredPanel>;
let edits: Array<{ id: string; panel: StructuredPanel }>;
let messages: string[];

function record(channelRef = "worker"): SessionRecord {
  return { id: `discord:${channelRef}`, platform: "discord", channelRef, parentRef: "parent",
    agentId: "codex", acpSessionId: `acp-${channelRef}`, repoPath: dataDir, configJson: "{}",
    createdUtc: new Date().toISOString(), updatedUtc: new Date().toISOString() };
}
function spec(id: string): DispatchSpec {
  return { id, target: "worker", prompt: id, session: "live", kind: "handoff",
    reportBack: false, stream: false, createdUtc: new Date().toISOString() };
}
function dispatchCard(id: string): StructuredPanel | undefined {
  const ref = store.turnAttempts.get(id)?.statusCard;
  return ref ? panels.get(ref.messageId) : undefined;
}
function click(choiceId: string, customId = makeChoiceCustomId(choiceId, 0), values?: string[]) {
  return { customId, userId: "user", userName: "Ada", channel: { platform: "discord", id: "worker", parentId: "parent" },
    messageId: "choice", kind: "button", values, replyEphemeral: vi.fn(async () => {}),
    followUpEphemeral: vi.fn(async () => {}), showModal: vi.fn() };
}
async function busy(serial = false) {
  if (serial) {
    await enqueueDispatchSpec(dataDir, spec("BUSY"), store.turnAttempts);
    tasks.push(watcher.tick());
  } else tasks.push(orch.dispatchInjectTurn(spec("BUSY")));
  await busyEntered.promise;
}
function tick() { tasks.push(watcher.tick()); }

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "seam-queued-origin-"));
  store = new SessionStore(path.join(dataDir, "seam.db"));
  store.upsert(record());
  store.upsert(record("origin"));
  tasks = []; prompts = []; panels = new Map(); edits = []; messages = [];
  releaseBusy = deferred(); releaseNext = deferred(); busyEntered = deferred(); nextEntered = deferred();
  const runtime = {
    onEvent() {}, getSessionInfo: () => ({ sessionId: "acp-worker" }), idle: async () => {},
    prompt: vi.fn(async (text: string) => {
      prompts.push(text);
      if (text.includes("BUSY")) { busyEntered.resolve(); await releaseBusy.promise; }
      else { nextEntered.resolve(); await releaseNext.promise; }
      return { stopReason: "end_turn" };
    }),
  };
  let messageId = 0;
  const adapter = {
    sendPanel: async (channel: ChannelRef, panel: StructuredPanel): Promise<MessageRef> => {
      const id = `card-${++messageId}`; panels.set(id, panel); return { channel, id };
    },
    editPanel: async (ref: MessageRef, panel: StructuredPanel) => {
      panels.set(ref.id, panel); edits.push({ id: ref.id, panel });
    },
    sendChoiceCard: async (channel: ChannelRef, body: { panel: StructuredPanel }): Promise<MessageRef> => {
      const id = `choice-${++messageId}`; panels.set(id, body.panel); return { channel, id };
    },
    editChoiceCard: async (ref: MessageRef, body: { panel: StructuredPanel }) => {
      panels.set(ref.id, body.panel); edits.push({ id: ref.id, panel: body.panel });
    },
    sendMessage: async (channel: ChannelRef, text: string) => {
      messages.push(text); return { channel, id: `text-${++messageId}` };
    },
    editMessage: async () => {},
    getThreadLiveState: async () => ({ locked: false, archived: false }),
  };
  const router = {
    listProfiles: () => [], getProfile: () => undefined, reuseMcpServers: () => [],
    ensureSessionRecord: ({ channelRef }: { channelRef: string }) => store.getByChannel("discord", channelRef)!,
    describeConfig: (row: SessionRecord) => ({ agent: { value: row.agentId }, model: { value: "default" },
      location: { value: "local" }, cwd: { value: dataDir }, effort: { value: null } }),
    getOrStartRuntime: async () => runtime,
  };
  const config = { DATA_DIR: dataDir, REPOS_ROOT: dataDir, TURN_TIMEOUT_SECONDS: 60,
    DEFAULT_MODEL: "default", DISCORD_ALLOWED_USER_IDS: new Set(["user"]),
    SEAM_DISPATCH_STATUS_PANEL: true, SEAM_DISPATCH_OUTPUT_STYLE: "messages", REPO_EMOJIS: new Map(),
    channelPresets: new Map(), threadPresets: new Map() };
  orch = attachLocalBridge(new Orchestrator({ store, router: router as never, adapter: adapter as never,
    renderer: discordRenderer, config: config as never, logger: pino({ level: "silent" }) as never,
    modelCatalog: fixtureModelCatalog([]) }), [], dataDir);
  watcher = createRuntimeDispatchWatcher({ runtime: orch, attempts: store.turnAttempts, dataDir,
    pollMs: 60_000, logger: pino({ level: "silent" }) as never });
  orch.setDispatchWatcher(watcher);
  await watcher.start();
});
afterEach(async () => {
  releaseBusy.resolve(); releaseNext.resolve();
  await Promise.allSettled(tasks);
  watcher.stop();
  await watcher.drain();
  // onSettled projections run after the provider callback.
  await new Promise(resolve => setImmediate(resolve));
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("queued origin cards", () => {
  it.each(["live", "thread", "multi", "multi-user"] as const)("a %s choice stays Waiting until channel admission", async destination => {
    const source = record(destination === "thread" ? "origin" : "worker");
    const card = await orch.createChoice(source, { title: "Next task", options: [
      { label: "Run next", kind: "prompt", payload: "NEXT" },
      { label: "Also next", kind: "prompt", payload: "EXTRA" },
    ], ...(destination === "multi-user" ? { maxClicks: 2 } : {}),
    ...(destination === "thread" ? { defaultTarget: { type: "thread", threadId: "worker" } } : {}),
    ...(destination === "multi" ? { select: { min: 1, max: 2 } } : {}) });
    if (!card.ok) throw new Error(card.error);
    await busy();
    if (destination === "multi") {
      await (orch as any).handleChoiceCardInteraction(click(card.choiceId, makeChoiceSelectId(card.choiceId), ["0", "1"]));
      await (orch as any).handleChoiceCardInteraction(click(card.choiceId, makeChoiceConfirmId(card.choiceId)));
    } else await (orch as any).handleChoiceCardInteraction(click(card.choiceId));
    const next = store.turnAttempts.list("pending")[0]!;
    tick();
    expect(panels.get(card.messageId)?.footer).toMatch(/waiting/i);
    expect(prompts).toHaveLength(1);
    await vi.waitFor(() => expect(dispatchCard(next.id)?.title).toContain("Waiting"));
    const waitingRef = store.turnAttempts.get(next.id)!.statusCard!;
    expect(store.turnAttempts.get(next.id)).toMatchObject({ state: "pending", promptStarted: false });
    releaseBusy.resolve();
    await nextEntered.promise;
    expect(panels.get(card.messageId)?.footer).toMatch(/started/i);
    expect(store.turnAttempts.get(next.id)?.statusCard).toEqual(waitingRef);
    expect(dispatchCard(next.id)?.title).toContain("Working");
    releaseNext.resolve();
    await Promise.all(tasks);
    await vi.waitFor(() => expect(panels.get(card.messageId)?.footer).toMatch(/completed/i));
    expect(dispatchCard(next.id)?.title).toContain("Done");
    expect(prompts).toHaveLength(2);
  });

  it("a due wake shows Waiting, then edits the same card when its channel admits it", async () => {
    await busy();
    const scheduled = orch.scheduleWake(record(), { delaySeconds: 60, reason: "check later", prompt: "NEXT" });
    if (!scheduled.ok) throw new Error(scheduled.error);
    await orch.fireWake(store.getWake(scheduled.wakeId)!);
    tick();
    const id = `wake-${scheduled.wakeId}`;
    await vi.waitFor(() => expect(dispatchCard(id)?.title).toContain("Waiting"));
    expect([...panels.values()].some(panel => /Waking up|Resuming a wake/.test(JSON.stringify(panel)))).toBe(false);
    expect(prompts).toHaveLength(1);
    const waitingRef = store.turnAttempts.get(id)!.statusCard!;
    releaseBusy.resolve();
    await nextEntered.promise;
    expect(store.turnAttempts.get(id)?.statusCard).toEqual(waitingRef);
    expect(dispatchCard(id)?.fields.find(field => field.name === "Action")?.value).toMatch(/started/i);
    releaseNext.resolve();
    await Promise.all(tasks);
    expect(dispatchCard(id)?.title).toContain("Done");
  });

  it("shows a handoff Waiting even when the watcher's own target FIFO has not invoked it", async () => {
    await busy(true);
    await enqueueDispatchSpec(dataDir, { ...spec("NEXT"), originThreadRef: "origin" }, store.turnAttempts);
    tick();
    await vi.waitFor(() => expect(dispatchCard("NEXT")?.title).toContain("Waiting"));
    const waitingRef = store.turnAttempts.get("NEXT")!.statusCard!;
    expect(store.turnAttempts.get("NEXT")).toMatchObject({ state: "pending", promptStarted: false });
    expect(prompts).toHaveLength(1);
    releaseBusy.resolve();
    await nextEntered.promise;
    expect(store.turnAttempts.get("NEXT")?.statusCard).toEqual(waitingRef);
    expect(dispatchCard("NEXT")?.fields.find(field => field.name === "Action")?.value).toMatch(/started/i);
    releaseNext.resolve();
    await Promise.all(tasks);
    expect(dispatchCard("NEXT")?.title).toContain("Done");
  });

  it("cancels a waiting card without claiming the queued turn started", async () => {
    await busy(true);
    await enqueueDispatchSpec(dataDir, spec("NEXT"), store.turnAttempts);
    tick();
    await vi.waitFor(() => expect(dispatchCard("NEXT")?.title).toContain("Waiting"));
    const waitingId = store.turnAttempts.get("NEXT")!.statusCard!.messageId;
    await watcher.cancelRunning({ id: "NEXT" });
    await vi.waitFor(() => expect(dispatchCard("NEXT")?.fields.find(field => field.name === "Action")?.value).toMatch(/cancelled/i));
    expect(edits.filter(edit => edit.id === waitingId).every(edit => !/Started|Working/.test(JSON.stringify(edit.panel)))).toBe(true);
    releaseBusy.resolve();
    await Promise.all(tasks);
    expect(prompts).toHaveLength(1);
    expect(store.turnAttempts.get("NEXT")?.state).toBe("cancelled");
  });
});
