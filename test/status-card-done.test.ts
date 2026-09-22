/**
 * #437 — a finished turn says Done. A tool title is not pending work.
 * Output that actually arrives after finalization is what unlocks Working,
 * and quiet after that returns to Done.
 *
 * Leaving the monitor-title guess in place fails the first assertion.
 * Settling that resumed output back to Monitoring fails the last one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import type { DeliveryNonceLookup } from "../packages/core/src/platforms/chat-adapter.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const f of cleanups.splice(0).reverse()) f();
  vi.restoreAllMocks();
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-437-"));
  cleanups.push(() => rmSync(dir, { force: true, recursive: true }));
  const store = new SessionStore(path.join(dir, "test.db"));
  cleanups.push(() => store.close());
  const now = new Date().toISOString();
  const record = {
    id: "discord:worker", platform: "discord", channelRef: "worker",
    parentRef: null, agentId: "codex", acpSessionId: "recorded-acp", repoPath: "/synthetic",
    configJson: "{}", createdUtc: now, updatedUtc: now,
  };
  store.upsert(record);
  store.admitInbound({
    messageId: "1", platform: "discord", channelRef: "worker",
    parentRef: null, sessionRecordId: record.id, authorId: "user", authorName: "User",
    text: "do the thing", attachments: [], createdUtc: now,
  });
  store.claimInbound("1", 0, now);
  let onEvent: (event: { kind: string; text?: string; title?: string; toolCallId?: string }) => Promise<void> =
    async () => {};
  const runtime = {
    onEvent(f: typeof onEvent) { onEvent = f; },
    getSessionInfo: () => ({ sessionId: "recorded-acp" }),
    getProcessId: () => undefined,
    getProviderIdentity: () => "synthetic-codex",
    getFastModeOutcome: () => undefined,
    getPromptCapabilities: () => ({}),
    prompt: vi.fn(async () => {
      await onEvent({ kind: "tool-start", toolCallId: "t1", title: "Monitor the build" });
      await onEvent({ kind: "agent-text", text: "finished the turn" });
      return { stopReason: "end_turn" };
    }),
    idle: async () => {},
    cancel: async () => {},
  };
  const router = {
    listProfiles: () => [],
    describeConfig: () => ({
      agent: { value: "codex" }, model: { value: "test" },
      effort: { value: null }, cwd: { value: "/synthetic" }, location: { value: "local" },
      fastMode: { value: false },
    }),
    ensureSessionRecord: () => ({ ...record }),
    getProfile: () => undefined,
    getOrStartRuntime: vi.fn(async () => runtime),
  };
  const panels: { title?: string; author?: string; fields?: { name: string; value: string }[] }[] = [];
  const take = (panel: { title?: string; author?: string; fields?: { name: string; value: string }[] }) => {
    panels.push(panel);
  };
  const adapter = {
    sendPanel: vi.fn(async (channel: { id: string }, panel: { title?: string }) => {
      take(panel);
      return { channel, id: "panel" };
    }),
    sendMessage: vi.fn(async (channel: { id: string }) => ({ channel, id: "message" })),
    sendFile: vi.fn(async () => {}),
    findMessageByNonce: vi.fn(async (): Promise<DeliveryNonceLookup> => ({ status: "absent" })),
    editPanel: vi.fn(async (_msg: unknown, panel: { title?: string }) => { take(panel); }),
    editMessage: vi.fn(async () => {}),
  };
  const orch = new Orchestrator({
    logger: pino({ level: "silent" }) as never,
    modelCatalog: fixtureModelCatalog([]),
    store,
    router: router as never,
    adapter: adapter as never,
    renderer: discordRenderer as never,
    config: {
      DATA_DIR: dir, REPOS_ROOT: "/synthetic", TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_MODEL: "test", REPO_EMOJIS: new Map(),
      channelPresets: new Map(), threadPresets: new Map(),
    } as never,
  });
  const message = {
    messageId: "1", channel: { platform: "discord", id: "worker" },
    authorId: "user", authorIsBot: false, text: "do the thing",
  };
  const label = (panel: { title?: string; author?: string }) => panel.title ?? panel.author ?? "";
  return {
    orch,
    panels,
    label,
    run: () => (orch as unknown as { handleIncomingMessageInner(m: unknown): Promise<void> })
      .handleIncomingMessageInner(message),
    emit: (event: { kind: string; text?: string; title?: string; toolCallId?: string }) => onEvent(event),
  };
}

describe("finished turn card (#437)", () => {
  it("says Done after a monitor-titled tool, and Working only when output resumes", async () => {
    const h = setup();
    await h.run();
    const states = () => h.panels.map(h.label);
    expect(states()).not.toContain("Monitoring");
    expect(states().at(-1)).toBe("Done");

    vi.useFakeTimers();
    await h.emit({ kind: "agent-text", text: "output resumed" });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(states().at(-1)).toBe("Working");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(states().at(-1)).toBe("Done");
    const last = h.panels.at(-1)!;
    const action = last.fields?.find((field) => field.name === "Action")?.value;
    expect(action).toBe("Resumed — output complete");
    expect(states()).not.toContain("Monitoring");
  });
});
