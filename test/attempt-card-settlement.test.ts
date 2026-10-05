import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { TurnStatus } from "../packages/core/src/core/status-panel.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import type { StructuredPanel } from "../packages/core/src/core/types.js";

let dir: string;
let store: SessionStore;
let host: Orchestrator;
let edits: StructuredPanel[];
const spec = { id: "child", target: "worker", prompt: "work", session: "isolated" as const,
  kind: "handoff" as const, stream: false, createdUtc: "2026-10-04T22:59:31.000Z" };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "seam-terminal-card-"));
  store = new SessionStore(path.join(dir, "test.db"));
  edits = [];
  host = new Orchestrator({ logger: pino({ level: "silent" }) as any,
    config: { DATA_DIR: dir, REPOS_ROOT: "/synthetic", TURN_TIMEOUT_SECONDS: 60,
      channelPresets: new Map(), threadPresets: new Map(), bridgePresets: new Map() } as any,
    modelCatalog: fixtureModelCatalog([]), store, renderer: discordRenderer,
    router: { listProfiles: () => [], getProfile: () => undefined } as any,
    adapter: {
      sendPanel: async (channel: unknown) => ({ channel, id: "card" }),
      editPanel: async (_ref: unknown, panel: StructuredPanel) => { edits.push(panel); },
    } as any,
  });
});

async function drain() {
  await (host as any).settleTrackedContinuations();
}

afterEach(async () => {
  await drain();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function openCard() {
  const attempt = store.turnAttempts.claim(spec, "identity", "boot");
  store.turnAttempts.bindStatusCard(attempt, { channelId: "worker", messageId: "card" });
  const status = new TurnStatus({ model: "test", repoDisplay: "synthetic", titlePrefix: "📨 Handoff" });
  store.turnAttempts.saveStatusCardState(attempt, status.snapshot());
  expect(discordRenderer.statusPanel(status.toInput()).title).toContain("Working");
  return attempt;
}

describe("pre-prompt terminal card settlement", () => {
  it.each(["operator", "superseded"])("renders %s cancellation without another boot", async cause => {
    const attempt = openCard();
    const completed = vi.fn();
    store.turnAttempts.onSettled(completed);
    if (cause === "operator") expect(store.turnAttempts.cancel(attempt.id)).toBe(true);
    else expect(store.turnAttempts.releaseUnstartedClaim(attempt, "superseded", "queue ownership changed")).toBe("cancelled");
    expect(store.turnAttempts.get(attempt.id)).toMatchObject({ state: "cancelled", promptStarted: false });
    expect(completed).toHaveBeenCalledExactlyOnceWith(attempt.id);
    await drain();
    expect(edits.at(-1)?.title).toContain("Failed");
    expect(edits.at(-1)?.fields.find(f => f.name === "Action")?.value)
      .toBe(cause === "operator" ? "Cancelled" : "Cancelled — queue ownership changed");
    expect(store.turnAttempts.cancel(attempt.id)).toBe(false);
    expect(completed).toHaveBeenCalledTimes(1);
  });

  it("renders a setup failure with its real cause", async () => {
    const attempt = openCard();
    store.turnAttempts.complete(attempt, { id: attempt.id, target: spec.target, status: "failed",
      error: "provider executable is missing", finishedUtc: new Date().toISOString() });
    await drain();
    expect(edits.at(-1)?.title).toContain("Failed");
    expect(edits.at(-1)?.fields.find(f => f.name === "Action")?.value).toContain("provider executable is missing");
  });

  it("finalizes the existing live panel so its heartbeat cannot restore Working", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const attempt = openCard();
    const panel = await (host as any).startDispatchStatusPanel({ platform: "discord", id: spec.target }, spec,
      { model: "test", cwd: "/synthetic", isolated: true }, undefined, attempt.statusCard);
    expect(panel).toBeDefined();
    store.turnAttempts.releaseUnstartedClaim(attempt, "superseded", "queue ownership changed");
    await drain();
    expect(edits.at(-1)?.title).toContain("Failed");
    const settledEdits = edits.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(edits).toHaveLength(settledEdits);
    expect(panel.status.state).toBe("Failed");
  });

  it("keeps suspension nonterminal and leaves prompted cards to their live finalizer", async () => {
    const attempt = openCard();
    expect(store.turnAttempts.releaseUnstartedClaim(attempt, "shutdown", "controller restart")).toBe("suspended");
    await drain();
    expect(edits).toEqual([]);
    const prompted = store.turnAttempts.claim({ ...spec, id: "prompted" }, "identity", "boot");
    store.turnAttempts.bindStatusCard(prompted, { channelId: "worker", messageId: "prompted-card" });
    store.turnAttempts.bind(prompted, "acp");
    store.turnAttempts.startPrompt(prompted);
    store.turnAttempts.complete(prompted, { id: prompted.id, target: spec.target, status: "completed",
      output: "answer still being delivered", finishedUtc: new Date().toISOString() });
    await drain();
    expect(edits).toEqual([]);
  });

  it("notifies once for a pending callback's terminal outcome, with no card to invent", async () => {
    store.turnAttempts.admit(spec);
    const settled = vi.fn();
    store.turnAttempts.onSettled(settled);
    const result = { id: spec.id, target: spec.target, status: "failed" as const,
      error: "callback failed", finishedUtc: new Date().toISOString() };
    expect(store.turnAttempts.completePending(spec.id, result)).toBe(true);
    expect(store.turnAttempts.completePending(spec.id, result)).toBe(false);
    expect(settled).toHaveBeenCalledExactlyOnceWith(spec.id);
    await drain();
    expect(edits).toEqual([]);
  });
});
