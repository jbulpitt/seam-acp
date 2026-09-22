/**
 * #450 — the re-auth card calls acceptReauthWait. It is a choice card, not an
 * elicitation row, and the click does not enqueue a new prompt.
 *
 * Deleting the click branch lets the payload become a dispatch. Deleting the
 * attempt-id check treats an ordinary prompt as a re-auth accept.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { dispatchDirs, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";
import { recoveryFactsFromAttempt, recoveryStory } from "../packages/core/src/core/dispatch/recovery-story.js";
import {
  negotiateReauth,
  reauthStalledReason,
  REAUTH_COMPLETED_TEXT,
} from "../packages/core/src/core/reauth-negotiation.js";
import {
  reauthAcceptAttemptId,
  reauthChoiceSpec,
} from "../packages/core/src/core/reauth-card.js";
import { makeChoiceCustomId } from "../packages/core/src/core/choice/types.js";
import type { ChoiceInteraction } from "../packages/core/src/platforms/chat-adapter.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const OAUTH = "Failed to authenticate: OAuth session expired and could not be refreshed";
const CODE = "ABCD-EFGH";
const URL = "https://device.example.com/start";

describe("reauthChoiceSpec", () => {
  it("offers one accept button and keeps the device code out of the payload", () => {
    const decision = negotiateReauth({
      errorKind: "auth_expired",
      message: `${OAUTH} ${URL} code ${CODE} http://127.0.0.1/callback`,
    });
    expect(decision.action).toBe("park");
    if (decision.action !== "park") return;
    const spec = reauthChoiceSpec("attempt-1", decision.park);
    expect(spec.options).toHaveLength(1);
    expect(spec.options[0]!.label).toBe("Authentication is done — continue");
    expect(spec.options[0]!.payload).toBe("reauth-accept:attempt-1");
    expect(spec.options[0]!.payload).not.toContain(CODE);
    expect(spec.options[0]!.payload).not.toContain("ORIGINAL");
    expect(spec.body).toContain(URL);
    expect(spec.body).toContain(CODE);
    expect(spec.body).toContain("wrong host");
    expect(spec.body).not.toContain("127.0.0.1");
    expect(spec.maxClicks).toBe(1);
    expect(reauthAcceptAttemptId(spec.options[0]!.payload)).toBe("attempt-1");
    expect(reauthAcceptAttemptId("review the pull request")).toBeNull();
    expect(reauthAcceptAttemptId("reauth-accept:")).toBeNull();
  });
});

describe("reauth card click", () => {
  let dir: string;
  let store: SessionStore;
  const watchers: DispatchWatcher[] = [];

  afterEach(() => {
    for (const watcher of watchers.splice(0)) watcher.stop();
    store?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts the parked attempt and does not enqueue a new prompt", async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-450-"));
    store = new SessionStore(path.join(dir, "seam.db"));
    const attemptId = "11111111-1111-4111-8111-111111111111";
    const drafted: DispatchSpec = {
      id: attemptId,
      target: "thread-1",
      prompt: "ORIGINAL-BRIEF-DO-NOT-REPLAY",
      session: "live",
      kind: "handoff",
      createdUtc: "2026-09-22T00:00:00.000Z",
    };
    store.turnAttempts.registerOwner("boot");
    const row = store.turnAttempts.claim(drafted, executionIdentity({
      agent: "claude", location: "local", session: "live", model: "m", cwd: "/repo", config: {},
    }), "boot");
    store.turnAttempts.bind(row, "acp-1");
    store.turnAttempts.startPrompt(row);
    const decision = negotiateReauth({
      errorKind: "auth_expired",
      message: `${OAUTH} ${URL} code ${CODE}`,
    });
    expect(decision.action).toBe("park");
    if (decision.action !== "park") return;
    expect(store.turnAttempts.markStalled(attemptId, reauthStalledReason(decision.park))).toBe(true);

    const record: SessionRecord = {
      id: "discord:thread-1",
      platform: "discord",
      channelRef: "thread-1",
      parentRef: null,
      agentId: "claude",
      acpSessionId: "acp-1",
      repoPath: "/repo",
      configJson: "{}",
      createdUtc: drafted.createdUtc,
      updatedUtc: drafted.createdUtc,
    };
    const prompts: string[] = [];
    const orch = new Orchestrator({
      logger: silent,
      config: {
        DATA_DIR: dir,
        REPOS_ROOT: dir,
        TURN_TIMEOUT_SECONDS: 60,
        DEFAULT_MODEL: "default",
        DISCORD_ALLOWED_USER_IDS: new Set(["user-1"]),
        SEAM_DISPATCH_STATUS_PANEL: false,
        channelPresets: new Map(),
        threadPresets: new Map(),
      } as never,
      adapter: {
        async sendMessage() { return { channel: { platform: "discord", id: "thread-1" }, id: "m" }; },
        async sendChoiceCard() { return { channel: { platform: "discord", id: "thread-1" }, id: "card-msg" }; },
      } as never,
      modelCatalog: fixtureModelCatalog([{ id: "claude", defaultModel: "default" } as never]),
      router: {
        ensureSessionRecord: () => record,
        describeConfig: () => ({ agent: { value: "claude" }, model: { value: "m" }, effort: { value: "" }, cwd: { value: "/repo" }, location: { value: "local" } }),
        getProfile: () => ({ id: "claude" }),
        resolveProfileForChannel: () => ({ id: "claude" }),
      } as never,
      store,
      renderer: { statusPanel: () => ({ title: "", fields: [] }), panel: () => ({ title: "", fields: [] }) } as never,
    });
    (orch as unknown as { injectTurn: (...args: unknown[]) => Promise<unknown> }).injectTurn = async (_record, prompt) => {
      prompts.push(String(prompt));
      return { text: "continued", stopReason: "end_turn" };
    };
    const watcher = new DispatchWatcher({
      dataDir: dir,
      logger: silent,
      attempts: store.turnAttempts,
      onDispatch: (spec) => orch.dispatchInjectTurn(spec),
    });
    watchers.push(watcher);
    orch.setDispatchWatcher(watcher);

    await (orch as unknown as {
      postReauthCard(channelRef: string, attemptId: string, park: typeof decision.park): Promise<void>;
    }).postReauthCard("thread-1", attemptId, decision.park);

    const cards = store.listOpenChoiceCards("discord", "thread-1");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.options[0]!.payload).not.toContain(CODE);
    const db = (store as unknown as { db: { prepare(q: string): { get(): { n: number } } } }).db;
    expect(db.prepare("SELECT COUNT(*) AS n FROM elicitations").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM wake_events").get()).toEqual({ n: 0 });

    const replies: string[] = [];
    const evt: ChoiceInteraction = {
      customId: makeChoiceCustomId(cards[0]!.id, 0),
      userId: "user-1",
      userName: "Ada",
      channel: { platform: "discord", id: "thread-1" },
      messageId: "card-msg",
      kind: "button",
      async replyEphemeral(text) { replies.push(text); },
      async followUpEphemeral(text) { replies.push(text); },
      async deferUpdate() {},
      async showModal() {},
    };
    await (orch as unknown as { handleChoiceCardInteraction(evt: ChoiceInteraction): Promise<void> })
      .handleChoiceCardInteraction(evt);

    const after = store.turnAttempts.get(attemptId)!;
    expect(after.state).toBe("suspended");
    expect(after.stalledReason).toBe(REAUTH_COMPLETED_TEXT);
    expect(after.spec.prompt).toBe("ORIGINAL-BRIEF-DO-NOT-REPLAY");
    const story = recoveryStory(recoveryFactsFromAttempt(after));
    expect(story.prompt.startsWith("continue\n")).toBe(true);
    expect(story.prompt).not.toContain("ORIGINAL-BRIEF-DO-NOT-REPLAY");
    expect(story.prompt).not.toContain(CODE);
    expect(replies.join("\n")).toContain("original prompt is not sent again");
    const pendingDir = dispatchDirs(dir).pending;
    const pending = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir) : [];
    expect(pending.filter((name) => name.endsWith(".json"))).toEqual([]);
    expect(prompts).toEqual([]);
  });
});
