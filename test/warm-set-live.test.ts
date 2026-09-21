/**
 * #452 live packing proof. Copies production seam.db + channel-presets.json
 * and runs the selector. Must not write session rows.
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
import { selectWarmSet } from "../packages/core/src/core/warm-set/select.js";
import { budgetForHost, holdingMb } from "../packages/core/src/core/warm-set/footprint.js";

function mainCheckoutRoot(): string {
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
  return path.resolve(common, "..");
}

function fingerprint(dbPath: string): { count: number; digest: string } {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare("SELECT id, channel_ref, agent_id, acp_session_id, updated_utc FROM sessions ORDER BY id").all();
    return { count: rows.length, digest: createHash("sha256").update(JSON.stringify(rows)).digest("hex") };
  } finally {
    db.close();
  }
}

const liveRoot = mainCheckoutRoot();
const liveDb = path.join(liveRoot, "data", "seam.db");
const livePresets = path.join(liveRoot, "data", "channel-presets.json");
const hasLive = (() => {
  try { readFileSync(livePresets, "utf8"); fingerprint(liveDb); return true; } catch { return false; }
})();

describe.skipIf(!hasLive)("#452 live snapshot packing", () => {
  let dir: string | undefined;
  let copyDb: string;
  let before: { count: number; digest: string };
  let afterOpen: { count: number; digest: string };
  let store: SessionStore | undefined;
  let presets: ReturnType<typeof buildChannelPresetMaps>;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "seam-452-live-"));
    copyDb = path.join(dir, "seam.db");
    const live = new Database(liveDb, { readonly: true, fileMustExist: true });
    try { await live.backup(copyDb); } finally { live.close(); }
    before = fingerprint(copyDb);
    store = new SessionStore(copyDb);
    afterOpen = fingerprint(copyDb);
    const copyPresets = path.join(dir, "channel-presets.json");
    copyFileSync(livePresets, copyPresets);
    presets = buildChannelPresetMaps(copyPresets);
  });

  afterAll(() => {
    store?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("does not drop or rewrite session rows", () => {
    expect(afterOpen).toEqual(before);
    expect(store!.countSessions()).toBe(before.count);
  });

  it("packs fhr-server and rhc-server under their measured budgets without starting unmeasured agents", () => {
    const sessions = store!.listSessionsUncapped();
    for (const host of ["fhr-server", "rhc-server"] as const) {
      const owned = listSessionsForHost(host, { threadPresets: presets.threadPresets, sessions });
      const decisions = selectWarmSet({
        budgetMb: budgetForHost(host),
        loadSlots: 2,
        highCostLoadSlots: 1,
        candidates: owned.map((row) => {
          const rec = sessions.find((s) => s.id === row.sessionId)!;
          return {
            sessionId: row.sessionId,
            agentId: row.agentId,
            updatedUtc: row.updatedUtc,
            acpSessionId: rec.acpSessionId,
            hot: false,
            busy: false,
          };
        }),
      });
      const loads = decisions.filter((d) => d.action === "load");
      const mb = loads.reduce((sum, d) => sum + d.footprintMb, 0);
      expect(mb).toBeLessThanOrEqual(budgetForHost(host));
      expect(loads.length).toBeLessThanOrEqual(2);
      expect(loads.filter((d) => holdingMb(owned.find((o) => o.sessionId === d.sessionId)?.agentId ?? "") == null)).toHaveLength(0);
      expect(fingerprint(copyDb)).toEqual(before);
    }
  });
});
