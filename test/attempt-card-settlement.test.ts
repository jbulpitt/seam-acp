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
import { parkedTurnChoiceSpec } from "../packages/core/src/core/parked-turn-card.js";

let dir: string;
let store: SessionStore;
let host: Orchestrator;
let edits: StructuredPanel[];
let choiceEdits: ReturnType<typeof vi.fn>;
const spec = { id: "child", target: "worker", prompt: "work", session: "isolated" as const,
  kind: "handoff" as const, stream: false, createdUtc: "2026-10-04T22:59:31.000Z" };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "seam-terminal-card-"));
  store = new SessionStore(path.join(dir, "test.db"));
  edits = [];
  choiceEdits = vi.fn(async () => {});
  host = makeHost();
});

function makeHost() {
  let choicePosts = 0;
  return new Orchestrator({ logger: pino({ level: "silent" }) as any,
    config: { DATA_DIR: dir, REPOS_ROOT: "/synthetic", TURN_TIMEOUT_SECONDS: 60,
      channelPresets: new Map(), threadPresets: new Map(), bridgePresets: new Map() } as any,
    modelCatalog: fixtureModelCatalog([]), store, renderer: discordRenderer,
    router: { listProfiles: () => [], getProfile: () => undefined } as any,
    adapter: {
      sendPanel: async (channel: unknown) => ({ channel, id: "card" }),
      editPanel: async (_ref: unknown, panel: StructuredPanel) => { edits.push(panel); },
      sendChoiceCard: async (channel: { id: string }) => ({ channel, id: `notice-${channel.id}-${++choicePosts}` }),
      editChoiceCard: choiceEdits,
    } as any,
  });
}

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

describe("terminal card settlement", () => {
  it.each((["completed", "failed", "cancelled"] as const).flatMap(status =>
    [false, true].map(restart => ({ status, restart }))))("retires notices with the recorded $status label (restart: $restart)", async ({ status, restart }) => {
    const attempt = store.turnAttempts.claim(spec, "identity", "boot");
    store.turnAttempts.bind(attempt, "acp");
    store.turnAttempts.startPrompt(attempt);
    const binding = { version: 1 as const, location: "local", slot: 19,
      submissionId: "parked-submission", acpSessionId: "acp", delegatedUtc: new Date().toISOString() };
    expect(store.turnAttempts.recordRemoteRecovery(attempt, binding)).toBe(true);
    store.turnAttempts.markStalled(attempt.id, "connection unavailable");
    for (const channelRef of ["worker", "requester"]) {
      const card = parkedTurnChoiceSpec(attempt.id, "connection unavailable", { resume: "Resume", cancel: "Cancel" });
      if (channelRef === "requester") card.options[1] = { label: "Abandon", kind: "prompt", payload: `parked-turn:abandon:${attempt.id}` };
      await (host as any).publishChoiceCard({ id: `discord:${channelRef}`, platform: "discord", channelRef, parentRef: null },
        card);
    }
    const notices = store.listOpenChoiceCards("discord");
    expect(notices).toHaveLength(2);
    const unrelated = await (host as any).publishChoiceCard({ id: "discord:worker", platform: "discord", channelRef: "worker", parentRef: null },
      parkedTurnChoiceSpec("other-turn", "another cause", { resume: "Resume", cancel: "Cancel" }));
    expect(unrelated.ok).toBe(true);
    expect(attempt.statusCard).toBeNull();
    await drain();
    expect(choiceEdits).not.toHaveBeenCalled();
    expect(store.listOpenChoiceCards("discord")).toHaveLength(3);

    if (restart) {
      store.close();
      store = new SessionStore(path.join(dir, "test.db"));
      host = makeHost();
    }
    if (status === "cancelled") expect(store.turnAttempts.cancel(attempt.id)).toBe(true);
    else expect(store.turnAttempts.adoptRemoteResult(store.turnAttempts.get(attempt.id)!, { version: 1,
      submissionId: binding.submissionId, acpSessionId: binding.acpSessionId, status,
      text: "captured output", ...(status === "failed" ? { error: "real provider cause" } : {}),
      finishedUtc: new Date().toISOString() }, {
      id: attempt.id, target: spec.target, status, output: "captured output", finishedUtc: new Date().toISOString(),
    })).toBe(true);
    await drain();
    for (const card of notices) expect(store.getChoiceCard(card.id)?.status).toBe("cancelled");
    expect(store.listOpenChoiceCards("discord").map(card => card.id)).toEqual([unrelated.choiceId]);
    expect(choiceEdits).toHaveBeenCalledTimes(2);
    const label = status.charAt(0).toUpperCase() + status.slice(1);
    for (const card of notices) expect(choiceEdits).toHaveBeenCalledWith(
      { id: card.messageId, channel: { platform: "discord", id: card.channelRef } },
      expect.objectContaining({ disabled: true, hideButtons: true, panel: expect.objectContaining({
        fields: [{ name: "Status", value: label }], footer: label,
      }) }));
    expect(store.turnAttempts.get(attempt.id)?.deliveryDone).toBe(false);
    expect(edits).toEqual([]);
    // Duplicate terminal signals cannot retire an unrelated notice or re-edit these.
    expect(store.turnAttempts.cancel(attempt.id)).toBe(false);
    await drain();
    expect(choiceEdits).toHaveBeenCalledTimes(2);

    // Re-rendering the persisted closed notice still reads the attempt's result.
    store.close();
    store = new SessionStore(path.join(dir, "test.db"));
    host = makeHost();
    await (host as any).refreshChoiceCard(store.getChoiceCard(notices[0]!.id));
    expect(choiceEdits.mock.calls.at(-1)?.[1].panel).toMatchObject({
      fields: [{ name: "Status", value: label }], footer: label,
    });
  });

  it("keeps explicit cancellation of an ordinary choice card labelled Cancelled", async () => {
    const posted = await (host as any).publishChoiceCard({ id: "discord:worker", platform: "discord",
      channelRef: "worker", parentRef: null }, { title: "Pick one", options: [{ label: "Continue",
      kind: "prompt", payload: "continue" }] });
    expect(posted.ok).toBe(true);
    expect(store.cancelChoiceCard(posted.choiceId, "worker")).toBe(true);
    await (host as any).refreshChoiceCard(store.getChoiceCard(posted.choiceId));
    expect(choiceEdits.mock.calls.at(-1)?.[1]).toMatchObject({ disabled: true, hideButtons: true,
      panel: { fields: [{ name: "Status", value: "Cancelled" }], footer: "Cancelled" } });
  });

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
