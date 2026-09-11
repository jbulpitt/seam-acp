import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
const PARENT = "111111111111111111";
const OTHER = "222222222222222222";
let dir: string;
let store: SessionStore;

const profile = {
  id: "copilot",
  displayName: "Copilot",
  defaultModel: "gpt-5.4",
  staticModels: [{ modelId: "gpt-5.4", name: "GPT-5.4" }],
  effort: { mechanism: "none", levels: [] },
} as unknown as AgentProfile;

function record(): SessionRecord {
  return {
    id: "discord:333333333333333333",
    platform: "discord",
    channelRef: "333333333333333333",
    parentRef: PARENT,
    agentId: "copilot",
    acpSessionId: "acp-1",
    repoPath: "/repo",
    configJson: JSON.stringify({ model: "gpt-5.4" }),
    createdUtc: "2026-09-11T00:00:00.000Z",
    updatedUtc: "2026-09-11T00:00:00.000Z",
  };
}

function restrict(agentId = "copilot", channels = [OTHER]) {
  store.recordConfigMutation({
    id: `audit-${Math.random()}`,
    tier: "agent-channel-restriction",
    scope: `agent-channel-restriction:${agentId}`,
    summary: "test restriction",
    beforeJson: JSON.stringify({ restriction: null }),
    afterJson: JSON.stringify({ restriction: { agentId, allowedChannelIds: channels } }),
  });
}

function router() {
  return new SessionRouter({
    logger: silent,
    store,
    profiles: [profile],
    modelCatalog: fixtureModelCatalog([profile]),
    defaultAgentId: "copilot",
    defaultModel: "gpt-5.4",
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agent-restriction-"));
  store = new SessionStore(path.join(dir, "seam.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("agent channel restriction resolution (#308)", () => {
  it("leaves an agent unrestricted when there is no rule", () => {
    const rec = record();
    store.upsert(rec);
    expect(router().planRuntimeSpawn(rec).agentId).toBe("copilot");
  });

  it("refuses a planned runtime with the agent, channel, and rule in the error", () => {
    const rec = record();
    store.upsert(rec);
    restrict();
    expect(() => router().planRuntimeSpawn(rec)).toThrow(
      'agent "copilot" cannot run in channel "111111111111111111". Rule: "copilot" is allowed only in channel(s): 222222222222222222.'
    );
  });

  it("rechecks a warm cached runtime before every turn", async () => {
    const rec = record();
    store.upsert(rec);
    const subject = router();
    const warm = { markActivity: vi.fn() };
    (subject as unknown as { runtimes: Map<string, unknown> }).runtimes.set(rec.id, warm);
    restrict();

    await expect(subject.getOrStartRuntime(rec)).rejects.toThrow(
      'agent "copilot" cannot run in channel "111111111111111111"'
    );
    // If the getOrStartRuntime preflight is removed, this returns `warm` and
    // the cached process receives a forbidden next turn.
    expect(warm.markActivity).not.toHaveBeenCalled();
  });
});
