/**
 * #631 — one ACP session has one thread. A thread that shares its session
 * with an older thread gets its own copy before its turn, and is told so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;
let dir: string;
let store: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "seam-631-fork-"));
  store = new SessionStore(path.join(dir, "seam.db"));
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

function thread(id: string, createdUtc: string) {
  const record = {
    id: `discord:${id}`, platform: "discord", channelRef: id, parentRef: "10",
    agentId: "claude", acpSessionId: "acp-shared", repoPath: "/repo", configJson: "{}", namePrefix: null,
    createdUtc, updatedUtc: createdUtc,
  };
  store.upsert(record as never);
  return record;
}

function host(forkResult: string | undefined) {
  const sent: Array<{ channel: string; text: string }> = [];
  const router = {
    forkSharedSession: vi.fn(async (record: { id: string; acpSessionId: string }) => {
      if (!forkResult) return undefined;
      store.upsert({ ...store.get(record.id)!, acpSessionId: forkResult });
      return forkResult;
    }),
    invalidate: vi.fn(async () => undefined),
  };
  const orchestrator = new Orchestrator({
    modelCatalog: fixtureModelCatalog([]),
    logger: silent,
    config: { DATA_DIR: dir, REPOS_ROOT: "/repo", channelPresets: new Map(), threadPresets: new Map(), bridgePresets: new Map() } as never,
    adapter: { sendMessage: async (channel: { id: string }, text: string) => { sent.push({ channel: channel.id, text }); return { id: "m" }; } } as never,
    router: router as never,
    store,
    renderer: {} as never,
  });
  const rebuild = vi.fn(async () => undefined);
  Object.assign(orchestrator as never, { rebuildThreadFromDiscord: rebuild });
  const ensure = (record: { channelRef: string }) =>
    (orchestrator as unknown as { ensureOwnSession(r: unknown, c: unknown): Promise<void> })
      .ensureOwnSession(record, { platform: "discord", id: record.channelRef });
  return { router, rebuild, sent, ensure };
}

describe("#631 a shared ACP session is forked for the newer thread", () => {
  it("forks the newer thread, leaves the older one alone, and tells the newer thread", async () => {
    const older = thread("older", "2026-09-01T00:00:00.000Z");
    const newer = thread("newer", "2026-09-02T00:00:00.000Z");
    const { router, sent, ensure } = host("acp-own");

    await ensure(older);
    expect(router.forkSharedSession).not.toHaveBeenCalled();

    await ensure(newer);
    expect(router.forkSharedSession).toHaveBeenCalledTimes(1);
    expect(store.get("discord:newer")?.acpSessionId).toBe("acp-own");
    expect(store.get("discord:older")?.acpSessionId).toBe("acp-shared");
    expect(sent).toEqual([{ channel: "newer", text: expect.stringContaining("<#older>") }]);
  });

  it("rebuilds from the thread's history when the agent cannot fork", async () => {
    thread("older", "2026-09-01T00:00:00.000Z");
    const newer = thread("newer", "2026-09-02T00:00:00.000Z");
    const { rebuild, sent, ensure } = host(undefined);
    await ensure(newer);
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(sent[0]?.text).toContain("rebuilt from this thread's history");
  });

  it("does nothing for a thread that is the only holder of its session", async () => {
    const only = thread("only", "2026-09-01T00:00:00.000Z");
    const { router, sent, ensure } = host("acp-own");
    await ensure(only);
    expect(router.forkSharedSession).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
