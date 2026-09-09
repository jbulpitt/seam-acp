import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { planAgyIdentityMigration, readAgyHandleOwnership, rebuildMigratedAgySession } from "../packages/core/src/core/agy-identity-migration.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { pino } from "pino";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";

const stores: SessionStore[] = [];
const dirs: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup() { const store = new SessionStore(":memory:"); stores.push(store); return store; }
function row(id: string, agentId = "agy", acpSessionId = id): SessionRecord {
  return { id, agentId, acpSessionId, platform: "discord", channelRef: id, parentRef: "parent", repoPath: "/repo", namePrefix: "custom", configJson: '{"model":"exact-high","reasoningEffort":"default","role":"worker","availableTools":["safe"]}', createdUtc: "before", updatedUtc: "before" };
}
const ownership = { native: new Set(["native"]), packaged: new Set(["package"]) };
const binding = (r: SessionRecord) => ({ agent: r.agentId, location: r.id === "remote" ? "remote-host" : "local" });

describe("owner-approved local AGY restoration", () => {
  it("retains the one-shot marker and rebuild requirement across process restart", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-migrate-restart-")); dirs.push(root);
    const file = path.join(root, "seam.db");
    const first = new SessionStore(file);
    first.upsert(row("package"));
    first.applyAgyIdentityMigration(planAgyIdentityMigration(first.list(), ownership, binding));
    first.close();
    const restarted = new SessionStore(file); stores.push(restarted);
    expect(restarted.agyIdentityRestored()).toBe(true);
    expect(restarted.needsAgyIdentityRebuild("package")).toBe(true);
    expect(restarted.get("package")).toEqual({ ...row("package"), acpSessionId: "" });
    expect(restarted.applyAgyIdentityMigration([])).toBe(false);
  });
  it("refuses runtime creation while the durable migration rebuild is pending", () => {
    const store = setup(); store.upsert(row("package"));
    store.applyAgyIdentityMigration(planAgyIdentityMigration(store.list(), ownership, binding));
    const router = new SessionRouter({ logger: pino({ level: "silent" }) as unknown as Logger,
      store, profiles: [], modelCatalog: {} as ModelCatalogService, defaultAgentId: "agy", defaultModel: "exact-high", threadPresets: new Map() });
    expect(() => router.planRuntimeSpawn(store.get("package")!)).toThrow(/requires Discord reconstruction/);
  });
  it("preserves all columns except exact identity/handle, excludes remote and other agents, and is one-shot", () => {
    const store = setup();
    const before = [row("native", "agy-old"), row("package"), row("unknown"), row("unbound", "agy", ""), row("remote"), row("other", "codex")];
    before.forEach(r => store.upsert(r));
    const plan = planAgyIdentityMigration(store.list(), ownership, binding);
    expect(plan.map(c => c.reason).sort()).toEqual(["native", "package", "unbound", "unrecognized"]);
    expect(store.applyAgyIdentityMigration(plan)).toBe(true);
    for (const r of before) expect(store.get(r.id)).toEqual({ ...r, agentId: r.id === "native" ? "agy" : r.agentId, acpSessionId: ["package", "unknown"].includes(r.id) ? "" : r.acpSessionId });
    expect(store.needsAgyIdentityRebuild("package")).toBe(true);
    expect(store.needsAgyIdentityRebuild("unbound")).toBe(false);
    expect(store.applyAgyIdentityMigration(plan)).toBe(false);
    store.rollbackAgyIdentityMigration();
    before.forEach(r => expect(store.get(r.id)).toEqual(r));
    expect(store.agyIdentityRestored()).toBe(false);
  });

  it("rolls back the entire transaction on a stale row, without losing other config", () => {
    const store = setup(); [row("package"), row("unknown")].forEach(r => store.upsert(r));
    const plan = planAgyIdentityMigration(store.list(), ownership, binding);
    const changed = { ...plan[1]!.before, configJson: '{"model":"changed"}' }; store.upsert(changed);
    expect(() => store.applyAgyIdentityMigration(plan)).toThrow(/snapshot changed/);
    expect(store.get(plan[0]!.before.id)).toEqual(plan[0]!.before);
    expect(store.get(changed.id)).toEqual(changed);
    expect(store.agyIdentityRestored()).toBe(false);
  });

  it("fails closed on ambiguous ownership or a conflicting effective agent", () => {
    expect(() => planAgyIdentityMigration([row("native")], { native: ownership.native, packaged: ownership.native }, binding)).toThrow(/Ambiguous/);
    expect(() => planAgyIdentityMigration([row("other", "codex")], ownership, () => ({ agent: "agy", location: "local" }))).toThrow(/conflicting/);
    expect(() => planAgyIdentityMigration([row("native", "agy-old")], ownership, () => ({ agent: "agy-old", explicitAgent: "agy-old", location: "local" }))).toThrow(/preset/);
  });

  it("retains recovery after failed reconstruction; successful CAS attachment consumes it once", async () => {
    const store = setup(); store.upsert(row("package"));
    store.applyAgyIdentityMigration(planAgyIdentityMigration(store.list(), ownership, binding));
    const pending = store.get("package")!;
    await expect(rebuildMigratedAgySession(store, pending, { agent: "agy", location: "local" }, async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(store.needsAgyIdentityRebuild(pending.id)).toBe(true);
    await expect(rebuildMigratedAgySession(store, pending, { agent: "agy", location: "remote" }, async () => ({ attached: true, newSessionId: "new" }))).rejects.toThrow(/binding changed/);
    await expect(rebuildMigratedAgySession(store, pending, { agent: "agy", location: "local" }, async () => ({ attached: false, newSessionId: "new" }))).rejects.toThrow(/did not attach/);
    let calls = 0;
    const rebuild = async () => { calls++; store.compareAndSwapAcpSession(pending.id, "", "new-native"); return { attached: true, newSessionId: "new-native" }; };
    await rebuildMigratedAgySession(store, pending, { agent: "agy", location: "local" }, rebuild);
    await rebuildMigratedAgySession(store, pending, { agent: "agy", location: "local" }, rebuild);
    expect(calls).toBe(1);
    expect(store.needsAgyIdentityRebuild(pending.id)).toBe(false);
    expect(() => store.rollbackAgyIdentityMigration()).toThrow(/session changed/);
    expect(store.get(pending.id)?.acpSessionId).toBe("new-native");
  });

  it("validates native maps including legacy location; malformed maps cannot clear handles", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-migrate-")); dirs.push(root);
    fs.mkdirSync(path.join(root, ".gemini/antigravity-cli"), { recursive: true });
    fs.writeFileSync(path.join(root, "agy-sessions.json"), JSON.stringify({ native: { cascadeId: "cascade", cwd: "/repo" } }));
    fs.writeFileSync(path.join(root, ".gemini/antigravity-cli/seam_sessions.json"), JSON.stringify({ legacy: "cascade2" }));
    fs.writeFileSync(path.join(root, "sessions.json"), JSON.stringify({ sessions: { package: { conversationId: "pkg" } } }));
    const result = readAgyHandleOwnership(root, root, root);
    expect([...result.native]).toEqual(["native", "legacy"]);
    expect([...result.packaged]).toEqual(["package"]);
    fs.writeFileSync(path.join(root, "agy-sessions.json"), "broken");
    expect(() => readAgyHandleOwnership(root, root, root)).toThrow(/safely classify/);
  });
});
