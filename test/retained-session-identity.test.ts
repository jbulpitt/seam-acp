import { afterEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { AgentProfile, BridgeSlotHealth } from "@seam/adapters";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const stores: SessionStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = new SessionStore(":memory:"); stores.push(store);
  const now = new Date().toISOString();
  const record = { id: "discord:owner", platform: "discord", channelRef: "owner", parentRef: null,
    agentId: "codex", acpSessionId: "saved-acp", repoPath: "/repo", configJson: "{}", createdUtc: now, updatedUtc: now };
  store.upsert(record);
  const profile = { id: "codex", defaultModel: "default" } as AgentProfile;
  const router = new SessionRouter({ logger: pino({ level: "silent" }), store,
    profiles: [profile], modelCatalog: fixtureModelCatalog([profile]), defaultAgentId: "codex", defaultModel: "default",
    threadPresets: new Map([["owner", { location: "remote" }]]) });
  const slot: BridgeSlotHealth = { slot: 65, alive: true, pid: 99, lastStdoutMsAgo: 0, lastStdinMsAgo: 0,
    session: { agentId: "codex", acpSessionId: record.acpSessionId, threadId: "owner", busy: false, updatedUtc: now } };
  return { router, store, record, slot, now };
}

describe("retained session identity", () => {
  it("matches the persisted ACP, agent, host and thread without an active turn", () => {
    const h = setup();
    expect(h.router.retainedSlotSession("remote", h.slot)?.id).toBe(h.record.id);
  });

  it.each(["ACP", "agent", "host", "thread"])("does not adopt a mismatched %s identity", dimension => {
    const h = setup();
    if (dimension === "ACP") h.slot.session!.acpSessionId = "different-session";
    if (dimension === "agent") h.slot.session!.agentId = "claude";
    if (dimension === "thread") h.slot.session!.threadId = "different-thread";
    expect(h.router.retainedSlotSession(dimension === "host" ? "local" : "remote", h.slot)).toBeNull();
  });

  it("retains an old child's unknown identity rather than calling it an orphan", () => {
    const h = setup(); delete h.slot.session;
    expect(h.router.retainedSlotSession("remote", h.slot)).toBeUndefined();
  });

  it("uses an older child's completed recovery and durable execution identity", () => {
    const h = setup(); delete h.slot.session;
    h.store.turnAttempts.registerOwner("boot");
    const attempt = h.store.turnAttempts.claim({ id: "completed", target: "owner", prompt: "work",
      session: "live", createdUtc: h.now }, executionIdentity({ agent: "codex", location: "remote", session: "live" }), "boot");
    h.store.turnAttempts.bind(attempt, h.record.acpSessionId);
    h.store.turnAttempts.startPrompt(attempt);
    h.store.turnAttempts.recordRemoteRecovery(attempt, { version: 1, location: "remote", slot: 65,
      acpSessionId: h.record.acpSessionId, submissionId: "sub", delegatedUtc: h.now });
    h.store.turnAttempts.complete(attempt, { id: "completed", target: "owner", status: "completed", finishedUtc: h.now });
    h.slot.recovery = { version: 1, owner: "bridge", rung: 1, submissionId: "sub", acpSessionId: h.record.acpSessionId,
      phase: "succeeded", retry: 0, budget: 0, remaining: 0, disposition: "none", updatedUtc: h.now };
    expect(h.router.retainedSlotSession("remote", h.slot)?.id).toBe(h.record.id);
  });
});
