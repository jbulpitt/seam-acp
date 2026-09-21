/**
 * #446 live-data proof. Copies the production `seam.db` and
 * `channel-presets.json`, then enumerates. A story on this epic passed every
 * fixture test and silently dropped 21 rows from a live table — so this file
 * runs against a snapshot of the real store, not a made-up one.
 *
 * Skips when the main checkout has no live files (CI / a fresh clone).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { listSessionsForHost } from "../packages/core/src/core/host-sessions.js";
import { buildChannelPresetMaps } from "../packages/core/src/config.js";

function mainCheckoutRoot(): string {
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
  return path.resolve(common, "..");
}

function fingerprintSessions(dbPath: string): { count: number; digest: string; ids: string[] } {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      "SELECT id, channel_ref, agent_id, updated_utc FROM sessions ORDER BY id",
    ).all() as Array<{ id: string; channel_ref: string; agent_id: string; updated_utc: string }>;
    const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
    return { count: rows.length, digest, ids: rows.map((row) => row.id) };
  } finally {
    db.close();
  }
}

const liveRoot = mainCheckoutRoot();
const liveDb = path.join(liveRoot, "data", "seam.db");
const livePresets = path.join(liveRoot, "data", "channel-presets.json");
const hasLive = (() => {
  try {
    readFileSync(livePresets, "utf8");
    fingerprintSessions(liveDb);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasLive)("#446 live snapshot of seam.db + channel-presets.json", () => {
  let dir: string | undefined;
  let copyDb: string;
  let beforeCopy: { count: number; digest: string; ids: string[] };
  let afterOpen: { count: number; digest: string; ids: string[] };
  let store: SessionStore | undefined;
  let presets: ReturnType<typeof buildChannelPresetMaps>;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "seam-446-live-"));
    copyDb = path.join(dir, "seam.db");
    const live = new Database(liveDb, { readonly: true, fileMustExist: true });
    try {
      await live.backup(copyDb);
    } finally {
      live.close();
    }
    beforeCopy = fingerprintSessions(copyDb);
    store = new SessionStore(copyDb);
    afterOpen = fingerprintSessions(copyDb);
    const copyPresets = path.join(dir, "channel-presets.json");
    copyFileSync(livePresets, copyPresets);
    presets = buildChannelPresetMaps(copyPresets);
  });

  afterAll(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("opening SessionStore on the snapshot does not drop or rewrite session rows", () => {
    expect(afterOpen.count).toBe(beforeCopy.count);
    expect(afterOpen.ids).toEqual(beforeCopy.ids);
    expect(afterOpen.digest).toBe(beforeCopy.digest);
    expect(store!.countSessions()).toBe(beforeCopy.count);
    expect(store!.listSessionsUncapped()).toHaveLength(beforeCopy.count);
    expect(store!.list(100).length).toBe(Math.min(100, beforeCopy.count));
    if (beforeCopy.count > 100) {
      expect(store!.listSessionsUncapped().length).toBeGreaterThan(store!.list(100).length);
    }
  });

  it("every session belongs to exactly one host, and remote hosts match the presets that have a session row", () => {
    const sessions = store!.listSessionsUncapped();
    const hosts = new Set<string>(["local"]);
    for (const preset of presets.threadPresets.values()) {
      if (preset.location?.trim()) hosts.add(preset.location.trim());
    }
    const listed = new Map<string, string>();
    for (const host of hosts) {
      for (const row of listSessionsForHost(host, { threadPresets: presets.threadPresets, sessions })) {
        expect(listed.has(row.sessionId)).toBe(false);
        listed.set(row.sessionId, host);
        expect(row.location).toBe(host);
      }
    }
    expect(listed.size).toBe(sessions.length);
    expect([...listed.keys()].sort()).toEqual(sessions.map((row) => row.id).sort());

    const sessionByChannel = new Map(sessions.map((row) => [row.channelRef, row]));
    for (const host of hosts) {
      if (host === "local") continue;
      const expected = [...presets.threadPresets.entries()]
        .filter(([, preset]) => (preset.location ?? "").trim() === host)
        .map(([channelRef]) => channelRef)
        .filter((channelRef) => sessionByChannel.has(channelRef))
        .sort();
      const got = listSessionsForHost(host, { threadPresets: presets.threadPresets, sessions })
        .map((row) => row.channelRef)
        .sort();
      expect(got).toEqual(expected);
    }
    expect(listed.size).toBe(beforeCopy.count);
  });

  it("does not write a location onto session rows", () => {
    const db = new Database(copyDb, { readonly: true });
    try {
      const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
      expect(cols.map((col) => col.name)).not.toContain("location");
    } finally {
      db.close();
    }
  });
});
