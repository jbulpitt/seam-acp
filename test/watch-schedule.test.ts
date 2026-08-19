import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { WatchCreateRequest } from "../packages/core/src/core/watch/types.js";
import {
  WATCH_MIN_INTERVAL_SECONDS,
  WATCH_MAX_INTERVAL_SECONDS,
  WATCH_MAX_EXPIRY_SECONDS,
  WATCH_MAX_PENDING_PER_THREAD,
} from "../packages/core/src/core/watch/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dir: string;
let store: SessionStore;

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-1",
  platform: "discord",
  channelRef: "thread-1",
  parentRef: "channel-1",
  agentId: "claude",
  acpSessionId: "acp-1",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: new Date().toISOString(),
  updatedUtc: new Date().toISOString(),
  ...over,
});

const req = (over: Partial<WatchCreateRequest> = {}): WatchCreateRequest => ({
  kind: "http",
  spec: "https://ci/status",
  intervalSeconds: 60,
  prompt: "CI finished — resume",
  expiresInSeconds: 3600,
  ...over,
});

/** Build an Orchestrator with a config whose command-watch policy we control. */
function makeOrch(config: { WATCH_COMMAND_ENABLED?: boolean; WATCH_COMMAND_ALLOWLIST?: string[] } = {}) {
  return new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      WATCH_COMMAND_ENABLED: config.WATCH_COMMAND_ENABLED ?? false,
      WATCH_COMMAND_ALLOWLIST: config.WATCH_COMMAND_ALLOWLIST ?? [],
    } as any,
    adapter: {} as any,
    router: { listProfiles: () => [] } as any,
    store,
    renderer: {} as any,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-watch-sched-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Orchestrator.createWatch guards (#60)", () => {
  it("registers a valid http watch and persists it (self-scope)", () => {
    const orch = makeOrch();
    const res = orch.createWatch(record(), req({ match: "status:200" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = store.getWatch(res.watchId)!;
    expect(row.channelRef).toBe("thread-1"); // armed for the caller's own thread
    expect(row.kind).toBe("http");
    expect(row.match).toBe("status:200");
    expect(row.mode).toBe("once"); // default (D3)
    expect(Date.parse(row.expiresAtUtc) - Date.now()).toBeGreaterThan(3000_000);
  });

  it("defaults mode to 'once' and 'each' honours maxFires", () => {
    const orch = makeOrch();
    const each = orch.createWatch(record(), req({ mode: "each", maxFires: 4 }));
    expect(each.ok).toBe(true);
    if (!each.ok) return;
    const row = store.getWatch(each.watchId)!;
    expect(row.mode).toBe("each");
    expect(row.maxFires).toBe(4);
  });

  it("rejects an unknown kind / empty spec / empty prompt", () => {
    const orch = makeOrch();
    expect(orch.createWatch(record(), req({ kind: "socket" as any })).ok).toBe(false);
    expect(orch.createWatch(record(), req({ spec: "  " })).ok).toBe(false);
    expect(orch.createWatch(record(), req({ prompt: "" })).ok).toBe(false);
  });

  it("rejects a below-floor interval per kind (D6)", () => {
    const orch = makeOrch();
    const res = orch.createWatch(record(), req({ kind: "http", intervalSeconds: WATCH_MIN_INTERVAL_SECONDS.http - 1 }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/floor/);
    // A file watch may poll faster than http — the floor is per kind.
    expect(orch.createWatch(record(), req({ kind: "file", spec: "/tmp/x", intervalSeconds: WATCH_MIN_INTERVAL_SECONDS.file })).ok).toBe(true);
  });

  it("rejects an interval above the maximum", () => {
    const orch = makeOrch();
    const res = orch.createWatch(record(), req({ intervalSeconds: WATCH_MAX_INTERVAL_SECONDS + 1 }));
    expect(res.ok).toBe(false);
  });

  it("REQUIRES a positive expiry within the horizon (D4)", () => {
    const orch = makeOrch();
    expect(orch.createWatch(record(), req({ expiresInSeconds: 0 })).ok).toBe(false);
    expect(orch.createWatch(record(), req({ expiresInSeconds: -5 })).ok).toBe(false);
    expect(orch.createWatch(record(), req({ expiresInSeconds: WATCH_MAX_EXPIRY_SECONDS + 1 })).ok).toBe(false);
  });

  it("enforces the per-thread pending cap (D5)", () => {
    const orch = makeOrch();
    for (let n = 0; n < WATCH_MAX_PENDING_PER_THREAD; n++) {
      expect(orch.createWatch(record(), req()).ok).toBe(true);
    }
    const res = orch.createWatch(record(), req());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/pending watches/);
  });

  // --- the load-bearing command source gate (D8) ---------------------------

  it("REFUSES a command watch when WATCH_COMMAND_ENABLED is false", () => {
    const orch = makeOrch({ WATCH_COMMAND_ENABLED: false });
    const res = orch.createWatch(record(), req({ kind: "command", spec: "git status", intervalSeconds: 30 }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/disabled/);
    expect(store.countWatchesByChannel("discord", "thread-1")).toBe(0); // nothing persisted
  });

  it("REFUSES a command watch not on the allowlist even when enabled", () => {
    const orch = makeOrch({ WATCH_COMMAND_ENABLED: true, WATCH_COMMAND_ALLOWLIST: ["git status"] });
    const res = orch.createWatch(record(), req({ kind: "command", spec: "rm -rf /", intervalSeconds: 30 }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/allowlist/);
  });

  it("ALLOWS an exact allowlisted command watch when enabled", () => {
    const orch = makeOrch({ WATCH_COMMAND_ENABLED: true, WATCH_COMMAND_ALLOWLIST: ["git status"] });
    const res = orch.createWatch(record(), req({ kind: "command", spec: "git status", intervalSeconds: 30 }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(store.getWatch(res.watchId)!.kind).toBe("command");
  });

  // --- lifecycle scope (D7) ------------------------------------------------

  it("cancelWatch only removes the caller's own thread's watch (scope isolation)", () => {
    const orch = makeOrch();
    const res = orch.createWatch(record(), req());
    if (!res.ok) throw new Error("setup failed");
    // A different thread cannot cancel it.
    expect(orch.cancelWatch(record({ channelRef: "thread-other", id: "discord:thread-other" }), res.watchId)).toBe(false);
    expect(store.getWatch(res.watchId)).not.toBeNull();
    // The owning thread can — and a cancelled watch is really gone.
    expect(orch.cancelWatch(record(), res.watchId)).toBe(true);
    expect(store.getWatch(res.watchId)).toBeNull();
  });

  it("listWatches returns pending watches for the thread only", () => {
    const orch = makeOrch();
    orch.createWatch(record(), req({ reason: "a" }));
    orch.createWatch(record(), req({ reason: "b" }));
    expect(orch.listWatches("discord", "thread-1")).toHaveLength(2);
    expect(orch.listWatches("discord", "thread-other")).toHaveLength(0);
  });
});
