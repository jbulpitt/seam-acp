import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { finishLiveTurn, readLiveMarker, turnDirs, writeLiveMarker } from "../packages/core/src/core/dispatch/turn-resume.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { testSessionRouter } from "./helpers/session-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function fixture(states: Array<"pending" | "running" | "completed" | "missing">) {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-cancelled-boot-"));
  const db = path.join(dir, "seam.db"), now = new Date().toISOString();
  let store = new SessionStore(db);
  store.upsert({ id: "google-chat:home", platform: "google-chat", channelRef: "home", parentRef: null,
    agentId: "codex", acpSessionId: "same-acp", repoPath: dir, configJson: "{}", createdUtc: now, updatedUtc: now });
  for (const [i, state] of states.entries()) {
    const messageId = String(i);
    if (state !== "missing") {
      store.admitInbound({ messageId, platform: "google-chat", channelRef: "home", sessionRecordId: "google-chat:home",
        authorId: "42", text: "work", createdUtc: now });
      if (state !== "pending") expect(store.claimInbound(messageId, 0, now)).toBe(true);
    }
    const attempt = store.turnAttempts.claim({ id: `inbound-${messageId}`, target: "home", prompt: "work",
      session: "live", createdUtc: now }, "fixture", "previous-boot", "inbound");
    store.turnAttempts.bind(attempt, "same-acp");
    store.turnAttempts.startPrompt(attempt);
    store.turnAttempts.bindStatusCard(attempt, { channelId: "home.topic", messageId: `card-${messageId}` });
    expect(store.turnAttempts.cancel(attempt.id)).toBe(true);
    await writeLiveMarker(dir, { id: attempt.id, kind: "live", channelRef: "home", sessionRecordId: "google-chat:home",
      inboundMessageId: messageId, acpSessionId: "same-acp", startedUtc: now, promptStarted: true });
    if (state === "completed") {
      store.settleInboundExecution(messageId);
      expect(await finishLiveTurn(dir, { id: attempt.id, status: "cancelled", channelRef: "home", finishedUtc: now })).toBe(true);
    }
  }
  store.close();
  store = new SessionStore(db);
  const editPanel = vi.fn(async () => {});
  const host = new Orchestrator({ store, renderer: discordRenderer, modelCatalog: fixtureModelCatalog([]),
    logger: pino({ level: "silent" }) as any,
    router: testSessionRouter({ listProfiles: () => [], getProfile: () => undefined }) as any,
    adapter: { platform: "google-chat", editPanel } as any,
    config: { DATA_DIR: dir, REPOS_ROOT: dir, TURN_TIMEOUT_SECONDS: 60,
      channelPresets: new Map(), threadPresets: new Map() } as any });
  const render = vi.spyOn(host as any, "renderPersistedTerminalAttemptCard");
  const settle = vi.spyOn(store, "settleInboundExecution");
  cleanups.push(async () => {
    await (host as any).settleTrackedContinuations();
    host.suspendForRestart(); host.stopSentinelWatcher();
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, host, editPanel, render, settle };
}

describe("cancelled inbound boot recovery", () => {
  it("does not render or settle 413 historical cancelled attempts on repeated boots", async () => {
    const h = await fixture(Array.from({ length: 413 }, () => "completed" as const));
    expect(h.store.turnAttempts.list("cancelled")).toHaveLength(413);
    const history = Array.from({ length: 413 }, (_, i) => h.store.getInbound(String(i)));
    await h.host.recoverInterruptedTurns();
    rmSync(turnDirs(h.dir).done, { recursive: true });
    await h.host.recoverInterruptedTurns();
    expect(h.render).not.toHaveBeenCalled();
    expect(h.editPanel).not.toHaveBeenCalled();
    expect(h.settle).not.toHaveBeenCalled();
    expect(Array.from({ length: 413 }, (_, i) => h.store.getInbound(String(i)))).toEqual(history);
  });

  it.each(["pending", "running"] as const)("settles a cancelled attempt with a %s admission exactly once", async state => {
    const h = await fixture([state]);
    expect(h.store.getInbound("0")?.state).toBe(state);
    await h.host.recoverInterruptedTurns();
    expect(h.render).toHaveBeenCalledOnce();
    expect(h.settle).toHaveBeenCalledExactlyOnceWith("0");
    expect(h.editPanel).toHaveBeenCalledExactlyOnceWith(
      { channel: { platform: "google-chat", id: "home.topic" }, id: "card-0" },
      expect.objectContaining({ title: expect.not.stringContaining("Working"), fields: expect.arrayContaining([
        expect.objectContaining({ name: "Action", value: expect.stringContaining("Cancelled") }),
      ]) }));
    expect(h.store.getInbound("0")?.state).toBe("completed");
    expect(await readLiveMarker(h.dir, "inbound-0")).toBeNull();
    await h.host.recoverInterruptedTurns();
    expect(h.render).toHaveBeenCalledOnce();
    expect(h.editPanel).toHaveBeenCalledOnce();
    expect(h.settle).toHaveBeenCalledOnce();
  });

  it("does not render a cancelled attempt without an admission", async () => {
    const h = await fixture(["missing"]);
    await h.host.recoverInterruptedTurns();
    expect(h.render).not.toHaveBeenCalled();
    expect(h.editPanel).not.toHaveBeenCalled();
    expect(h.settle).not.toHaveBeenCalled();
  });
});
