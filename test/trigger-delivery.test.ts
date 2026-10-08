import { testSessionRouter } from "./helpers/session-fixture.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { WakeManager } from "../packages/core/src/core/wake/manager.js";
import { ParkedPromptManager } from "../packages/core/src/core/parked-prompts/manager.js";
import { WatchManager } from "../packages/core/src/core/watch/manager.js";
import { DispatchWatcher } from "../packages/core/src/core/dispatch/watcher.js";
import { dispatchDirs } from "../packages/core/src/core/dispatch/types.js";
import { saveParkedAttachment } from "../packages/core/src/core/parked-prompts/attachments.js";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { WakeEvent } from "../packages/core/src/core/wake/types.js";
import type { ParkedPrompt } from "../packages/core/src/core/parked-prompts/types.js";
import type { WatchEvent } from "../packages/core/src/core/watch/types.js";

let dir: string;
let store: SessionStore;
const watchers: DispatchWatcher[] = [];
const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const target = { platform: "discord", id: "thread-1" };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-trigger-delivery-"));
  store = new SessionStore(path.join(dir, "seam.db"));
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const watcher of watchers) watcher.stop();
  await Promise.all(watchers.splice(0).map(watcher => watcher.drain()));
  vi.restoreAllMocks();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const config = { DATA_DIR: dir, REPOS_ROOT: dir, threadPresets: new Map(), bridgePresets: new Map(),
    DISCORD_ALLOWED_USER_IDS: new Set(), DISCORD_USER_NAMES: new Map() } as any;
  const adapter = new DiscordAdapter({ config, logger: logger as any });
  const fetch = vi.fn(async () => ({ isThread: () => true, locked: false, archived: false }));
  (adapter as any).client.channels.fetch = fetch;
  vi.spyOn(adapter, "sendPanel").mockResolvedValue({ channel: target, id: "notice-1" });
  vi.spyOn(adapter, "editPanel").mockResolvedValue(undefined);
  const orch = new Orchestrator({ config, adapter, store, logger: logger as any, renderer: {} as any,
    router: testSessionRouter({ ensureSessionRecord: () => ({ id: "discord:thread-1", channelRef: "thread-1", repoPath: dir,
      agentId: "claude", configJson: "{}" }) }) as any });
  const writeAttachment = vi.fn(async () => ({ path: "/repo/.seam-attachments/note.txt" }));
  const hub = { isBridgeReady: () => true, onBridgeReady: () => () => {}, markSessionBridge: () => {}, writeAttachment };
  orch.setBridgeHub(hub as any);
  return { orch, fetch, hub, writeAttachment };
}

function wake(startup = false): WakeEvent {
  return { id: "wake-1", platform: "discord", channelRef: target.id, parentRef: null,
    fireAtUtc: new Date(Date.now() - 1_000).toISOString(), prompt: "resume wake", reason: "test",
    createdBy: "discord:thread-1", correlationId: null, chainDepth: 0, catchupSeconds: 900,
    fireOnStartup: startup, createdUtc: new Date().toISOString() };
}

function parked(): ParkedPrompt {
  return { id: "park-1", platform: "discord", channelRef: target.id, parentRef: null, location: "local",
    kind: "user_queue", prompt: "resume parked", authorId: "u1", authorName: null,
    noticeMessageId: "notice-1", attachments: [], createdUtc: new Date().toISOString() };
}

function watch(over: Partial<WatchEvent> = {}): WatchEvent {
  return { id: "watch-1", platform: "discord", channelRef: target.id, parentRef: null, kind: "file",
    spec: "/repo/result.txt", match: null, intervalSeconds: 30, prompt: "resume watch", reason: "test",
    mode: "once", maxFires: 1, fireCount: 0, lastCheckedUtc: null, lastFiredUtc: null, lastObserved: null,
    expiresAtUtc: new Date(Date.now() + 3_600_000).toISOString(), createdBy: "discord:thread-1",
    correlationId: null, createdUtc: new Date().toISOString(), ...over };
}

const kinds = ["wake", "startup wake", "parked", "watch once", "watch each", "watch final", "watch expiry"] as const;
type Kind = typeof kinds[number];

function trigger(kind: Kind, f: ReturnType<typeof fixture>) {
  if (kind === "wake" || kind === "startup wake") {
    store.upsertWake(wake(kind === "startup wake"));
    const manager = new WakeManager({ store, logger: logger as any, onFire: (row, consume) => f.orch.fireWake(row, consume) });
    return { run: () => kind === "startup wake" ? manager.fireStartupWakes() : manager.sweep(),
      row: () => store.getWake("wake-1"), id: "wake-wake-1" };
  }
  if (kind === "parked") {
    store.upsertParked(parked());
    const manager = new ParkedPromptManager({ store, hub: f.hub, logger: logger as any,
      onFire: (row, consume) => f.orch.fireParked(row, consume) });
    return { run: () => manager.fireLocation("local"), row: () => store.getParked("park-1"), id: "parked-park-1" };
  }
  store.upsertWatch(watch({
    ...(kind === "watch each" ? { mode: "each", maxFires: 5 } : {}),
    ...(kind === "watch final" ? { mode: "each", maxFires: 2, fireCount: 1 } : {}),
    ...(kind === "watch expiry" ? { expiresAtUtc: new Date(Date.now() - 1_000).toISOString() } : {}),
  }));
  const manager = new WatchManager({ store, logger: logger as any,
    evaluate: async () => ({ fired: true, eventText: "captured BUILD OK", observed: "new observation" }),
    onFire: (row, event, consume) => f.orch.fireWatch(row, event, consume),
    onExpire: (row, consume) => f.orch.fireWatchExpiry(row, consume),
    onStopped: (row, reason) => f.orch.postWatchStopped(row, reason),
  });
  return { run: () => manager.sweep(), row: () => store.getWatch("watch-1"),
    id: kind === "watch expiry" ? "watch-watch-1-expiry" : `watch-watch-1-fire-${kind === "watch final" ? 2 : 1}` };
}

async function deliver() {
  const onDispatch = vi.fn(async () => ({ output: "delivered once", stopReason: "end_turn" }));
  const watcher = new DispatchWatcher({ dataDir: dir, attempts: store.turnAttempts, logger: logger as any, onDispatch });
  watchers.push(watcher);
  await watcher.start();
  watcher.stop();
  await watcher.drain();
  return onDispatch;
}

describe("trigger lookup and durable dispatch ownership", () => {
  for (const kind of kinds) {
    it.each([
      ["network", Object.assign(new Error("socket closed"), { code: "ECONNRESET" })],
      ["Discord 5xx", Object.assign(new Error("Discord unavailable"), { status: 503 })],
      ["rate limit", Object.assign(new Error("retry after 1s"), { status: 429 })],
    ])(`${kind}: a %s lookup failure hands off once instead of dropping`, async (_label, error) => {
      const f = fixture();
      const t = trigger(kind, f);
      f.fetch.mockRejectedValueOnce(error);
      await t.run();
      expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: error }), expect.stringContaining("handing off"));
      expect(store.turnAttempts.get(t.id)).toMatchObject({ state: "pending", spec: { target: target.id } });
      if (kind === "watch each") expect(t.row()).toMatchObject({ fireCount: 1, lastObserved: "new observation" });
      else expect(t.row()).toBeNull();
      await t.run();
      const onDispatch = await deliver();
      expect(onDispatch).toHaveBeenCalledTimes(1);
      expect(onDispatch.mock.calls[0]?.[0]).toMatchObject({ id: t.id });
    });

    it(`${kind}: Discord 10003 is terminal and retains the real error in the log`, async () => {
      const f = fixture();
      const t = trigger(kind, f);
      const error = Object.assign(new Error("Unknown Channel"), { code: 10003 });
      f.fetch.mockRejectedValueOnce(error);
      await t.run();
      expect(logger.warn).toHaveBeenCalledWith({ err: error, channel: target.id }, "Discord thread lookup: Unknown Channel");
      expect(store.turnAttempts.list("pending")).toEqual([]);
      expect(t.row()).toBeNull();
    });

    it(`${kind}: failed SQL admission does not consume its source`, async () => {
      const f = fixture();
      const t = trigger(kind, f);
      const before = t.row();
      vi.spyOn(store.turnAttempts, "admit").mockImplementationOnce(() => { throw new Error("SQL admission failed"); });
      await t.run();
      expect(t.row()).toEqual(before);
      expect(store.turnAttempts.list("pending")).toEqual([]);
      await t.run();
      expect(store.turnAttempts.get(t.id)?.state).toBe("pending");
    });

    it(`${kind}: restart after SQL commit, with no ingress file, delivers exactly once`, async () => {
      const f = fixture();
      const t = trigger(kind, f);
      const dirs = dispatchDirs(dir);
      fs.mkdirSync(dirs.root, { recursive: true });
      fs.writeFileSync(dirs.pending, "unavailable ingress directory");
      await t.run();
      expect(store.turnAttempts.get(t.id)?.state).toBe("pending");
      store.close();
      store = new SessionStore(path.join(dir, "seam.db"));
      const onDispatch = await deliver();
      expect(onDispatch).toHaveBeenCalledTimes(1);
      store.close();
      store = new SessionStore(path.join(dir, "seam.db"));
      expect(await deliver()).not.toHaveBeenCalled();
      expect(store.turnAttempts.get(t.id)).toMatchObject({ state: "completed", outcome: { output: "delivered once" } });
    });
  }

  it("rolls back both dispatch admission and watch advancement when the source commit fails", () => {
    store.upsertWatch(watch({ mode: "each", maxFires: 3 }));
    expect(() => store.admitTriggeredDispatch({ id: "watch-watch-1-fire-1", target: target.id,
      prompt: "captured event", session: "live" }, () => {
      store.markWatchChecked("watch-1", new Date().toISOString(), "new observation");
      store.incrementWatchFire("watch-1", new Date().toISOString());
      throw new Error("source commit failed");
    })).toThrow("source commit failed");
    expect(store.turnAttempts.list("pending")).toEqual([]);
    expect(store.getWatch("watch-1")).toMatchObject({ fireCount: 0, lastCheckedUtc: null, lastObserved: null });
  });

  it("duplicate admission preserves the captured event and never increments a watch twice", () => {
    store.upsertWatch(watch({ mode: "each", maxFires: 3 }));
    const spec = { id: "watch-watch-1-fire-1", target: target.id, prompt: "first event", session: "live" as const };
    const consume = () => store.incrementWatchFire("watch-1", new Date().toISOString());
    store.admitTriggeredDispatch(spec, consume);
    store.close();
    store = new SessionStore(path.join(dir, "seam.db"));
    expect(store.admitTriggeredDispatch({ ...spec, prompt: "different event" }, consume)).toEqual(spec);
    expect(store.getWatch("watch-1")?.fireCount).toBe(1);
  });

  it("successive recurring events get distinct durable identities and snapshots", async () => {
    const f = fixture();
    const t = trigger("watch each", f);
    await t.run();
    store.markWatchChecked("watch-1", new Date(Date.now() - 60_000).toISOString(), "new observation");
    await t.run();
    expect(store.turnAttempts.list("pending").map(a => a.id)).toEqual(["watch-watch-1-fire-1", "watch-watch-1-fire-2"]);
    expect(store.getWatch("watch-1")?.fireCount).toBe(2);
  });

  it("retains parked attachments until durable handoff and across failed admission", async () => {
    const f = fixture();
    const t = trigger("parked", f);
    const attachment = await saveParkedAttachment(dir, "park-1", { filename: "note.txt", mime: "text/plain", bytes: Buffer.from("important") });
    store.upsertParked({ ...parked(), attachments: [attachment] });
    const filename = path.join(dir, "parked-attachments", "park-1", "note.txt");
    const admit = store.turnAttempts.admit.bind(store.turnAttempts);
    vi.spyOn(store.turnAttempts, "admit")
      .mockImplementationOnce(() => { throw new Error("SQL unavailable"); })
      .mockImplementation(spec => {
        expect(fs.readFileSync(filename, "utf8")).toBe("important");
        expect(store.getParked("park-1")).not.toBeNull();
        return admit(spec);
      });
    f.fetch.mockRejectedValueOnce(new Error("temporary Discord lookup failure"));
    await t.run();
    expect(fs.readFileSync(filename, "utf8")).toBe("important");
    await t.run();
    expect(fs.existsSync(filename)).toBe(false);
    expect(store.turnAttempts.get(t.id)?.spec.prompt).toContain("/repo/.seam-attachments/note.txt");
    expect(f.writeAttachment).toHaveBeenCalledWith("local", dir, "note.txt", Buffer.from("important"));
  });

  it.each(["cancel", "replace", "newer message", "busy"])("parked %s during transfer is not dispatched", async action => {
    const f = fixture();
    const t = trigger("parked", f);
    const attachment = await saveParkedAttachment(dir, "park-1", { filename: "note.txt", mime: "text/plain", bytes: Buffer.from("important") });
    store.upsertParked({ ...parked(), attachments: [attachment] });
    f.writeAttachment.mockImplementationOnce(async () => {
      if (action === "cancel") await (f.orch as any).clearParkedForChannel(target.id);
      else if (action === "replace") store.upsertParked({ ...parked(), id: "new-park" });
      else if (action === "newer message") (f.orch as any).lastUserMessageAt.set(target.id, Date.now());
      else (f.orch as any).channelQueues.set(target.id, Promise.resolve());
      return { path: "/repo/.seam-attachments/note.txt" };
    });
    await t.run();
    expect(store.turnAttempts.list("pending")).toEqual([]);
    if (action === "replace") expect(store.getParkedByChannel("discord", target.id)?.id).toBe("new-park");
    if (action === "busy") {
      expect(store.getParked("park-1")).not.toBeNull();
      expect(fs.existsSync(path.join(dir, "parked-attachments", "park-1", "note.txt"))).toBe(true);
    }
  });
});
