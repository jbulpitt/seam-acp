/**
 * #610 — during the 30s start-failure cooldown, every retry used to say only
 * "Agent recently failed to start", with the actual failure gone. The retry
 * must repeat the cause it is waiting out.
 */
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
import { localBridgeWiring } from "./local-bridge-fixture.js";

const profile = {
  id: "agy",
  displayName: "Antigravity",
  defaultModel: "gemini-3.8-flash-high",
  staticModels: [{ modelId: "gemini-3.8-flash-high", name: "Gemini" }],
  effort: { mechanism: "none", levels: [] },
} as unknown as AgentProfile;

let dir: string;
let store: SessionStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-610-cooldown-"));
  store = new SessionStore(path.join(dir, "seam.db"));
});
afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const record: SessionRecord = {
  id: "discord:333333333333333333",
  platform: "discord",
  channelRef: "333333333333333333",
  parentRef: "111111111111111111",
  agentId: "agy",
  acpSessionId: "acp-1",
  repoPath: "/repo",
  configJson: JSON.stringify({ model: "gemini-3.8-flash-high" }),
  createdUtc: "2026-09-23T00:00:00.000Z",
  updatedUtc: "2026-09-23T00:00:00.000Z",
};

describe("#610 start-failure cooldown", () => {
  it("repeats the first line of the failure it is waiting out", async () => {
    store.upsert(record);
    const router = new SessionRouter({
      logger: pino({ level: "silent" }) as unknown as Logger,
      store,
      profiles: [profile],
      modelCatalog: fixtureModelCatalog([profile]),
      defaultAgentId: "agy",
      defaultModel: "gemini-3.8-flash-high",
      seamMcp: localBridgeWiring(profile),
    });
    const cause = "remote agent supervisor exited before initialize on host 'local' (code=1, signal=null): agent stdin is closed";
    const start = vi.spyOn(router as unknown as { startRuntime: () => Promise<never> }, "startRuntime")
      .mockRejectedValue(new Error(`${cause}\nagent stderr (last lines):\nnoise`));

    await expect(router.getOrStartRuntime(record)).rejects.toThrow(cause);
    await expect(router.getOrStartRuntime(record)).rejects.toThrow(
      new RegExp(`^Agent recently failed to start \\(${cause.replace(/[()]/g, "\\$&")}\\); waiting \\d+s before retry\\.$`),
    );
    expect(start).toHaveBeenCalledTimes(1);
  });
});
