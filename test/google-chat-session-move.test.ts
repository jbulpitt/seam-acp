import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { pino } from "pino";
import * as actions from "../packages/core/src/core/session-actions.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); vi.restoreAllMocks(); });
const actor = { id: "operator", name: "Operator" };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-move-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(path.join(dir, "seam.db")); cleanup.push(() => store.close());
  const profiles = [{ id: "codex", defaultModel: "old", staticModels: [{ modelId: "old" }, { modelId: "new" }],
    effort: { mechanism: "configOption", configId: "effort", levels: ["low", "high"] } }] as any;
  const threadPresets = new Map();
  const router = new SessionRouter({ store, logger: pino({ level: "silent" }) as any, profiles,
    modelCatalog: fixtureModelCatalog(profiles), defaultAgentId: "codex", defaultModel: "old", threadPresets });
  const source = router.ensureSessionRecord({ platform: "google-chat", channelRef: "old.topic", parentRef: "old", cwd: dir });
  store.upsert({ ...source, acpSessionId: "same-acp", configJson: '{"model":"old","reasoningEffort":"low"}' },
    { source: "fixture", cause: "retained provider conversation" });
  const destination = router.ensureSessionRecord({ platform: "google-chat", channelRef: "new", cwd: dir });
  store.upsert({ ...destination, configJson: '{"model":"old","reasoningEffort":"low"}' });
  const runtime = { applySavedSelection: vi.fn(async () => {}), applyPermissionMode: vi.fn(async () => {}),
    retire: vi.fn(async () => {}) };
  const sendMessage = vi.fn(async (channel: any, text: string) => ({ channel, id: text }));
  const busy = vi.fn(() => false), notes: any[] = [];
  const make = () => new (actions as any).GoogleChatSessionMove({ store, router, runtime, sendMessage,
    isChannelBusy: busy, logger: pino({ level: "silent" }), identityCommitted: async () => {} });
  const move = (adoptDestinationConfig = false) => make().move({ sessionId: source.id, destination: "spaces/new", adoptDestinationConfig, actor });
  return { dir, store, router, source, destination, runtime, sendMessage, busy, threadPresets, notes, make, move };
}

describe("operator move of a legacy Chat conversation", () => {
  it("replaces only the empty root, backs up first, and keeps the ACP, stable id, token and warm runtime", async () => {
    const h = fixture(); const warm = { busy: false, markActivity: vi.fn() };
    (h.router as any).runtimes.set(h.source.id, warm);
    const binding = vi.spyOn(h.router, "bindRecordLocation");
    const result = await h.move();
    expect(result.record).toMatchObject({ id: h.source.id, channelRef: "new", parentRef: null, acpSessionId: "same-acp" });
    expect(h.store.get(h.destination.id)).toBeNull();
    expect(h.store.countSessions()).toBe(1);
    expect(h.router.getRuntime(h.source.id)).toBe(warm);
    expect(h.runtime.retire).not.toHaveBeenCalled();
    expect(h.runtime.applySavedSelection).not.toHaveBeenCalled();
    expect(binding).toHaveBeenCalledWith(expect.objectContaining({ id: h.source.id, channelRef: "new" }));
    const backup = new Database(result.backup, { readonly: true });
    try { expect(backup.prepare("SELECT channel_ref FROM sessions WHERE id=?").get(h.source.id)).toEqual({ channel_ref: "old.topic" }); }
    finally { backup.close(); }
    expect(h.store.listConfigMutations()[0]).toMatchObject({ actorId: actor.id, summary: expect.stringContaining("move"),
      beforeJson: expect.stringContaining(h.destination.id), afterJson: expect.stringContaining("new") });
    expect(h.sendMessage.mock.calls.map(([channel]) => channel)).toEqual([
      { platform: "google-chat", id: "old.topic", parentId: "old" }, { platform: "google-chat", id: "new" }]);
  });

  it("reports each effective config mismatch without writes or retirement", async () => {
    const h = fixture(); h.threadPresets.set("new", { model: { value: "new" } });
    const before = h.store.listSessionsUncapped();
    await expect(h.move()).rejects.toThrow(/model.*old.*new.*adopt-destination-config/i);
    expect(h.store.listSessionsUncapped()).toEqual(before);
    expect(h.runtime.retire).not.toHaveBeenCalled(); expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it("uses the existing runtime transition only for explicitly adopted destination settings", async () => {
    const h = fixture(); h.threadPresets.set("new", { effort: { value: "high" } });
    const result = await h.move(true);
    expect(h.router.describeConfig(result.record).effort.value).toBe("high");
    expect(result.record.acpSessionId).toBe("same-acp");
    expect(h.runtime.applySavedSelection).toHaveBeenCalledWith(expect.objectContaining({ id: h.source.id, channelRef: "new" }),
      expect.objectContaining({ effort: expect.objectContaining({ value: "low" }) }));
  });

  it("compares session-level mode and tool settings too, not only the preset selection", async () => {
    const h = fixture(); h.store.upsert({ ...h.store.get(h.source.id)!, configJson: '{"model":"old","reasoningEffort":"low","mode":"plan","excludedTools":["exec"]}' });
    await expect(h.move()).rejects.toThrow(/mode.*plan.*excludedTools.*exec/);
    expect(h.store.get(h.source.id)?.channelRef).toBe("old.topic");
  });

  it("rechecks the destination inside the transaction and rolls back on rebind failure", () => {
    const h = fixture(), source = h.store.get(h.source.id)!, target = h.store.get(h.destination.id)!;
    const cause = new Error("SQLITE_FULL: rebind failed");
    vi.spyOn(h.store, "rebindChannel").mockImplementation(() => { throw cause; });
    expect(() => (h.store as any).moveChannel(source, target, actor)).toThrow(cause);
    expect(h.store.get(source.id)).toEqual(source); expect(h.store.get(target.id)).toEqual(target);
    expect(h.store.listConfigMutations()).toEqual([]);
  });

  it.each(["source", "destination"])("refuses a nonempty %s inbound queue with the actual message id", async side => {
    const h = fixture(), record = side === "source" ? h.source : h.destination;
    h.store.admitInbound({ messageId: "unsettled-human", platform: "google-chat", channelRef: record.channelRef,
      sessionRecordId: record.id, authorId: "42", text: "Held prompt", createdUtc: new Date().toISOString() });
    await expect(h.move()).rejects.toThrow(/unsettled-human.*pending/);
    expect(h.store.get(h.source.id)?.channelRef).toBe("old.topic");
    expect(h.runtime.retire).not.toHaveBeenCalled();
  });

  it("refuses a bridge-owned suspended attempt rather than killing or moving it", async () => {
    const h = fixture(); h.store.turnAttempts.registerOwner("old-boot");
    h.store.turnAttempts.claim({ id: "held-attempt", target: h.source.channelRef, prompt: "held", session: "live", createdUtc: new Date().toISOString() },
      "codex@local", "old-boot", "inbound");
    h.store.turnAttempts.suspendBoot("old-boot");
    await expect(h.move()).rejects.toThrow(/held-attempt.*suspended/);
    expect(h.store.turnAttempts.get("held-attempt")?.state).toBe("suspended");
    expect(h.runtime.retire).not.toHaveBeenCalled();
  });

  it("refuses a destination with its own ACP session", async () => {
    const h = fixture(); h.store.upsert({ ...h.destination, acpSessionId: "other-acp" }, { source: "fixture", cause: "occupied root" });
    await expect(h.move()).rejects.toThrow(/other-acp/);
    expect(h.store.get(h.source.id)?.acpSessionId).toBe("same-acp");
  });

  it("leaves both records intact and reports the original backup failure", async () => {
    const h = fixture(), cause = Object.assign(new Error("ENOSPC: no space for backup"), { code: "ENOSPC" });
    vi.spyOn(h.store as any, "backup").mockRejectedValue(cause);
    await expect(h.move()).rejects.toBe(cause);
    expect(h.store.get(h.source.id)?.channelRef).toBe("old.topic"); expect(h.store.get(h.destination.id)).not.toBeNull();
  });

  it("rechecks admission after the asynchronous backup before committing", async () => {
    const h = fixture(); const real = (h.store as any).backup?.bind(h.store);
    vi.spyOn(h.store as any, "backup").mockImplementation(async (file: string) => {
      await real(file);
      h.store.admitInbound({ messageId: "arrived-during-backup", platform: "google-chat", channelRef: h.source.channelRef,
        sessionRecordId: h.source.id, authorId: "42", text: "new", createdUtc: new Date().toISOString() });
    });
    await expect(h.move()).rejects.toThrow(/arrived-during-backup/);
    expect(h.store.get(h.source.id)?.channelRef).toBe("old.topic");
  });

  it("reports a note failure as a committed move, not a silent rollback or a lost conversation", async () => {
    const h = fixture(), cause = new Error("Chat write refused: membership removed");
    h.sendMessage.mockRejectedValueOnce(cause);
    await expect(h.move()).rejects.toThrow(/moved.*new.*membership removed/i);
    expect(h.store.get(h.source.id)?.channelRef).toBe("new"); expect(h.store.get(h.destination.id)).toBeNull();
  });

  it("fails an atomic replacement without exposing a deleted destination", () => {
    const h = fixture();
    const observer = vi.fn(); h.store.onSessionWrite(observer);
    expect(() => (h.store as any).moveChannel({ ...h.source, id: "missing-record" }, h.destination, actor)).toThrow(/missing-record/);
    expect(h.store.get(h.destination.id)).not.toBeNull(); expect(observer).not.toHaveBeenCalled();
  });
});
