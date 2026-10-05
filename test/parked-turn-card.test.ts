import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";
import { parkedTurnAction, parkedTurnChoiceSpec } from "../packages/core/src/core/parked-turn-card.js";
import { makeChoiceCustomId } from "../packages/core/src/core/choice/types.js";

let dir: string;
let store: SessionStore;
const logger = pino({ level: "silent" });
const id = "d4a166f6-2222-3333-4444-555555555555";
const watchers: DispatchWatcher[] = [];

function controller() {
  const orch = Object.create(Orchestrator.prototype) as any;
  orch.store = store;
  orch.logger = logger;
  orch.config = { DATA_DIR: dir, REPOS_ROOT: dir, DISCORD_ALLOWED_USER_IDS: new Set(["user"]),
    channelPresets: new Map(), threadPresets: new Map() };
  orch.router = { ensureSessionRecord: ({ channelRef }: any) => ({ id: `discord:${channelRef}`, platform: "discord", channelRef, parentRef: "parent" }) };
  const watcher = new DispatchWatcher({ dataDir: dir, logger: logger as any, attempts: store.turnAttempts, onDispatch: async () => {} });
  watchers.push(watcher);
  orch.dispatchWatcher = watcher;
  orch.adapter = {
    sendMessage: vi.fn(async () => ({ id: "notice" })),
    sendChoiceCard: vi.fn(async () => ({ id: "notice" })),
    editChoiceCard: vi.fn(async () => {}),
    getThreadLiveState: async () => ({ locked: false, archived: false }),
  };
  return orch;
}

function click(choiceId: string, index: number) {
  return {
    customId: makeChoiceCustomId(choiceId, index), userId: "user", userName: "Ada",
    channel: { platform: "discord", id: "worker", parentId: "parent" }, messageId: "notice", kind: "button",
    deferUpdate: vi.fn(async () => {}), replyEphemeral: vi.fn(async () => {}),
    followUpEphemeral: vi.fn(async () => {}), showModal: vi.fn(),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-parked-card-"));
  store = new SessionStore(path.join(dir, "seam.db"));
  const spec = { id, target: "worker", kind: "handoff" as const, session: "live" as const,
    prompt: "ORIGINAL-BRIEF-DO-NOT-REPLAY", createdUtc: new Date().toISOString() };
  store.turnAttempts.registerOwner("boot");
  const attempt = store.turnAttempts.claim(spec, executionIdentity({ agent: "codex", location: "local", session: "live", model: "m", cwd: "/repo", config: {} }), "boot");
  store.turnAttempts.bind(attempt, "original-acp");
  store.turnAttempts.startPrompt(attempt);
  store.turnAttempts.markStalled(id, "connection unavailable");
});
afterEach(() => { for (const watcher of watchers.splice(0)) watcher.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("durable parked-turn notice actions", () => {
  it("persists attempt-bound actions, then Abandon works after a controller/store replacement", async () => {
    const first = controller();
    await first.postParkedTurnNotice("worker", store.turnAttempts.get(id), "real cause: connection unavailable");
    const card = store.listOpenChoiceCards("discord", "worker")[0]!;
    expect(parkedTurnAction(card.options[1]!.payload)).toEqual({ action: "abandon", attemptId: id });
    store.close();
    store = new SessionStore(path.join(dir, "seam.db"));
    const recovered = controller();
    const interaction = click(card.id, 1);
    await recovered.handleChoiceCardInteraction(interaction);
    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(store.turnAttempts.get(id)?.state).toBe("cancelled");
    expect(store.turnAttempts.get(id)?.spec.prompt).toBe("ORIGINAL-BRIEF-DO-NOT-REPLAY");
    expect(store.getChoiceCard(card.id)?.status).not.toBe("open");
    const secondClick = click(card.id, 1);
    await recovered.handleChoiceCardInteraction(secondClick);
    expect(secondClick.replyEphemeral).toHaveBeenCalledWith("This card is closed.");
  });

  it("Resume uses the existing suspended dispatcher and never enqueues a new original prompt", async () => {
    const orch = controller();
    const watcher = new DispatchWatcher({ dataDir: dir, logger: logger as any, attempts: store.turnAttempts, onDispatch: async () => {} });
    orch.dispatchWatcher = watcher;
    try {
      await orch.postParkedTurnNotice("worker", store.turnAttempts.get(id), "connection unavailable");
      const card = store.listOpenChoiceCards("discord", "worker")[0]!;
      const interaction = click(card.id, 0);
      await orch.handleChoiceCardInteraction(interaction);
      expect(interaction.followUpEphemeral).toHaveBeenCalledWith(expect.stringContaining("Continuation requested"));
      expect(store.turnAttempts.get(id)?.acpSessionId).toBe("original-acp");
      expect(store.turnAttempts.get(id)?.spec.prompt).toBe("ORIGINAL-BRIEF-DO-NOT-REPLAY");
      expect(store.turnAttempts.get(`${id}-resume`)).toBeNull();
    } finally { watcher.stop(); }
  });

  it("a refused Resume remains unclaimed so the operator can fix the cause or abandon", async () => {
    const orch = controller();
    orch.dispatchWatcher = { listStaleRunning: async () => [store.turnAttempts.get(id)!.spec] };
    orch.adapter.getThreadLiveState = async () => ({ locked: true, archived: false });
    await orch.postParkedTurnNotice("worker", store.turnAttempts.get(id), "locked target");
    const card = store.listOpenChoiceCards("discord", "worker")[0]!;
    const interaction = click(card.id, 0);
    await orch.handleChoiceCardInteraction(interaction);
    expect(interaction.followUpEphemeral).toHaveBeenCalledWith(expect.stringMatching(/Cannot resume/));
    expect(store.getChoiceCard(card.id)?.clickCount).toBe(0);
  });

  it("internal actions remain separate from ordinary prompts and reauth acceptance", () => {
    const spec = parkedTurnChoiceSpec(id, "cause", { resume: "Resume", abandon: "Abandon" });
    expect(spec.options).toHaveLength(2);
    expect(parkedTurnAction("ordinary prompt")).toBeNull();
    expect(parkedTurnAction(`reauth-accept:${id}`)).toBeNull();
  });
});
