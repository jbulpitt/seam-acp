import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { attachErrorClassification } from "@seam/adapters";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { createRuntimeDispatchWatcher, type DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { enqueueDispatchSpec, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import { TurnStatus } from "../packages/core/src/core/status-panel.js";
import { makeChoiceCustomId } from "../packages/core/src/core/choice/types.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import type { MessageRef } from "../packages/core/src/platforms/chat-adapter.js";
import type { StructuredPanel } from "../packages/core/src/core/types.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { testSessionRouter } from "./helpers/session-fixture.js";

const target = "1563093512415875127";
const spec: DispatchSpec = { id: "retained-forward", target, kind: "forward", session: "live",
  prompt: "ORIGINAL-BRIEF-DO-NOT-REPLAY", stream: false, reportBack: false,
  returnTo: "ie_disposable", originThreadRef: "ie_disposable", createdUtc: "2026-10-23T07:39:43Z" };
const logger = pino({ level: "silent" });
let dir: string;
let store: SessionStore;
let host: Orchestrator;
let watcher: DispatchWatcher;
let sequence: number;
let messages: Map<string, StructuredPanel>;
let edits: Array<{ ref: MessageRef; panel: StructuredPanel }>;
let acquire: ReturnType<typeof vi.fn>;

function controller() {
  const record = store.getByChannel("discord", target)!;
  const router = testSessionRouter({
    listProfiles: () => [], getProfile: () => undefined,
    ensureSessionRecord: () => record,
    describeConfig: () => ({ agent: { value: "agy", source: "session config" },
      location: { value: "local", source: "session config" },
      model: { value: "unknown-agy-model", source: "session config" },
      effort: { value: null, source: "default" }, cwd: { value: dir, source: "session config" } }),
    getOrStartRuntime: acquire,
  });
  host = new Orchestrator({ logger: logger as any, store, router: router as any,
    renderer: discordRenderer, modelCatalog: fixtureModelCatalog([]),
    config: { DATA_DIR: dir, REPOS_ROOT: dir, TURN_TIMEOUT_SECONDS: 60,
      DISCORD_ALLOWED_USER_IDS: new Set(["tester"]), channelPresets: new Map(),
      threadPresets: new Map(), bridgePresets: new Map() } as any,
    adapter: {
      sendPanel: async (channel: MessageRef["channel"], panel: StructuredPanel) => {
        const ref = { channel, id: `status-${++sequence}` };
        messages.set(ref.id, panel); return ref;
      },
      editPanel: async (ref: MessageRef, panel: StructuredPanel) => {
        edits.push({ ref, panel }); messages.set(ref.id, panel);
      },
      sendMessage: vi.fn(async (channel: MessageRef["channel"]) => ({ channel, id: `text-${++sequence}` })),
      sendChoiceCard: vi.fn(async (channel: MessageRef["channel"]) => ({ channel, id: `notice-${++sequence}` })),
      editChoiceCard: vi.fn(async () => {}),
      getThreadLiveState: async () => ({ archived: false, locked: false }),
    } as any,
  });
  watcher = createRuntimeDispatchWatcher({ dataDir: dir, logger: logger as any,
    attempts: store.turnAttempts, runtime: host, pollMs: 60_000 });
  host.setDispatchWatcher(watcher);
}

async function drain() { await (host as any).settleTrackedContinuations(); }
async function stop() { watcher.stop(); host.suspendForRestart(); await drain(); }
async function boot() {
  await stop(); store.close(); store = new SessionStore(path.join(dir, "seam.db"));
  controller(); await watcher.start(); await drain();
}
async function refuse() {
  await enqueueDispatchSpec(dir, spec, store.turnAttempts);
  await watcher.start(); await drain();
  expect(acquire).toHaveBeenCalledOnce();
  const attempt = store.turnAttempts.get(spec.id)!;
  expect(attempt).toMatchObject({ state: "suspended", promptStarted: false, acpSessionId: null,
    stalledReason: "provider acquisition failed during execution: unknown AGY model unknown-agy-model" });
  expect(attempt.submissions ?? []).toEqual([]);
  expect(attempt.statusCard).not.toBeNull();
  return attempt;
}
function action(panel: StructuredPanel | undefined) { return panel?.fields.find(field => field.name === "Action")?.value; }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-retained-forward-"));
  store = new SessionStore(path.join(dir, "seam.db"));
  store.upsert({ id: `discord:${target}`, platform: "discord", channelRef: target, parentRef: "parent",
    agentId: "agy", acpSessionId: "", repoPath: dir, configJson: "{}",
    createdUtc: spec.createdUtc, updatedUtc: spec.createdUtc });
  sequence = 0; messages = new Map(); edits = [];
  const refusal = new Error("unknown AGY model unknown-agy-model");
  attachErrorClassification(refusal, { agentId: "agy", errorKind: "model_not_found" });
  acquire = vi.fn(async () => { throw refusal; });
  controller();
});
afterEach(async () => {
  await stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

describe("retained forward status ownership", () => {
  it("paints the acquisition refusal as Waiting, then product Cancel paints its original card terminal", async () => {
    const parked = await refuse();
    const messageId = parked.statusCard!.messageId;
    expect.soft(messages.get(messageId)?.title).toBe("📤 Forward · Waiting");
    expect.soft(action(messages.get(messageId))).toContain("Suspended");
    const notices = store.listOpenChoiceCards("discord", target);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.body).toContain(parked.stalledReason);
    const click = { customId: makeChoiceCustomId(notices[0]!.id, 1), userId: "tester", userName: "Tester",
      channel: { platform: "discord", id: target, parentId: "parent" }, messageId: notices[0]!.messageId,
      kind: "button", replyEphemeral: vi.fn(async () => {}), followUpEphemeral: vi.fn(async () => {}) };

    await host.handleChoiceCardInteraction(click as any); await drain();

    expect(store.turnAttempts.get(spec.id)).toMatchObject({ state: "cancelled", generation: 1, promptStarted: false });
    expect(store.getChoiceCard(notices[0]!.id)).toMatchObject({ status: "exhausted", clickCount: 1 });
    expect.soft(messages.get(messageId)?.title).toBe("📤 Forward · Failed");
    expect.soft(action(messages.get(messageId))).toContain("Cancelled");
    expect(store.turnAttempts.get(spec.id)?.statusCard).toEqual(parked.statusCard);
    expect(store.turnAttempts.get(spec.id)?.statusCardState?.status.input.state).toBe("Failed");

    acquire.mockClear(); await boot();
    expect(acquire).not.toHaveBeenCalled();
    expect(messages.get(messageId)?.title).toBe("📤 Forward · Failed");
    expect(store.turnAttempts.get(spec.id)?.submissions ?? []).toEqual([]);
    expect(store.listOpenChoiceCards("discord", target)).toEqual([]);
  });

  it("boot paints a cancellation missed during shutdown once, without repainting 413 settled history cards", async () => {
    const parked = await refuse();
    const messageId = parked.statusCard!.messageId;
    await stop(); store.close();
    // No controller is alive when the terminal commit wins before its paint.
    store = new SessionStore(path.join(dir, "seam.db"));
    expect(store.turnAttempts.cancel(spec.id)).toBe(true);
    for (let index = 0; index < 413; index++) {
      const history = store.turnAttempts.claim({ ...spec, id: `history-${index}` }, "history", "old-boot");
      store.turnAttempts.bindStatusCard(history, { channelId: target, messageId: `history-card-${index}` });
      const terminal = new TurnStatus({ model: "old", repoDisplay: dir });
      terminal.setState("Failed"); terminal.setAction("Cancelled");
      store.turnAttempts.saveStatusCardState(history, terminal.snapshot());
      store.turnAttempts.cancel(history.id);
    }
    store.close(); store = new SessionStore(path.join(dir, "seam.db"));
    acquire.mockClear(); edits.length = 0; controller();

    await watcher.start(); await drain();

    expect(messages.get(messageId)?.title).toBe("📤 Forward · Failed");
    expect(action(messages.get(messageId))).toBe("Cancelled");
    expect(edits).toHaveLength(1);
    expect(edits[0]!.ref.id).toBe(messageId);
    expect(acquire).not.toHaveBeenCalled();
    expect(store.turnAttempts.get(spec.id)?.submissions ?? []).toEqual([]);
    edits.length = 0; await boot();
    expect(edits).toEqual([]);
    expect(acquire).not.toHaveBeenCalled();
  });
});
