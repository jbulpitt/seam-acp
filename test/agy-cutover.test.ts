import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const logger = pino({ level: "silent" }) as unknown as Logger;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function profile(id: string): AgentProfile {
  return {
    id,
    displayName: id,
    defaultModel: "raw-model-high",
    effort: { mechanism: "modelBaked", levels: [] },
    spawn() {
      return Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {},
      });
    },
  } as unknown as AgentProfile;
}

describe("agy public identity cutover", () => {
  it("preserves native agy handles and clears only package handles on invalidation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-cutover-"));
    dirs.push(dir);
    const store = new SessionStore(path.join(dir, "seam.db"));
    const profiles = [profile("agy-package"), profile("agy")];
    const router = new SessionRouter({
      logger,
      store,
      profiles,
      modelCatalog: {} as ModelCatalogService,
      defaultAgentId: "agy",
      defaultModel: "raw-model-high",
      threadPresets: new Map(),
    });
    const insert = (id: string, agentId: string) => store.upsert({
      id,
      platform: "discord",
      channelRef: id,
      parentRef: null,
      agentId,
      acpSessionId: "legacy-session-handle",
      repoPath: dir,
      configJson: JSON.stringify({ model: "raw-model-high", role: "worker" }),
      createdUtc: "2026-09-09T00:00:00.000Z",
      updatedUtc: "2026-09-09T00:00:00.000Z",
    });
    insert("discord:new", "agy-package");
    insert("discord:old", "agy");

    await router.invalidate("discord:new", { clearAcpSession: true });
    await router.invalidate("discord:old", { clearAcpSession: true });

    expect(store.get("discord:new")).toMatchObject({
      agentId: "agy-package",
      acpSessionId: "",
      repoPath: dir,
      configJson: JSON.stringify({ model: "raw-model-high", role: "worker" }),
    });
    expect(store.get("discord:old")?.acpSessionId).toBe("legacy-session-handle");
    store.close();
  });
});
