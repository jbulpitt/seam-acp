import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageFlags } from "discord.js";
import { BootObserver, type BootObservation } from "../packages/core/src/lib/boot-observation.js";
import { createBridgeUpdater, type BridgeUpdaterHandle, type BridgeReleaseFacts } from "../packages/core/src/core/bridge-updater.js";
import { deployBootRows, deployFleetRows, verifyDeploy, type DeployRequest } from "../packages/core/src/core/deploy-verification.js";
import { canaryIsGreen, renderCanaryLayouts, type CanaryRunResult } from "../packages/core/src/core/canary.js";
import { legacyControllerIdentity, publishDeployCard, waitForDeployResult } from "../packages/core/src/redeploy-cli.js";
import { processOwner } from "../packages/core/src/core/dispatch/process-owner.js";
import { readProcessIdentity } from "@seam/adapters";

const request: DeployRequest = { id: "deploy640", previous: { pid: 123, started: "linux:10" },
  branch: "main", commit: "new", startedAt: "2026-10-09T12:00:00Z" };
const boot: BootObservation = { identity: { pid: 124, started: "linux:20" }, instanceId: "boot640",
  branch: "main", commit: "new", startedAt: "2026-10-09T12:00:01Z", readyAt: "2026-10-09T12:00:02Z", errorCount: 0, errors: [] };
const probeResult = (): CanaryRunResult => ({ id: "probe", target: "self", branch: "main", commit: "new",
  startedAt: request.startedAt, finishedAt: boot.readyAt!, rows: [{ host: "one", agent: "cheap", status: "passed", durationMs: 1 }] });
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deploy640-")); directories.push(dir); return dir; }

function fleet(targets: BridgeUpdaterHandle["targets"], facts: Map<string, BridgeReleaseFacts>) {
  const updater = createBridgeUpdater({ currentSha: "new", get: id => facts.get(id),
    managed: id => targets.find(target => target.bridgeId === id)?.excluded,
    older: async () => true, rollout: async () => {}, report: () => {} });
  const handle = Object.assign(() => {}, { targets, idle: updater.idle, observations: updater.observations });
  return { ...updater, handle, get: (id: string) => facts.get(id) };
}

describe("deploy startup and reconnect verdict", () => {
  it("requires new PID/start identity, requested revision, health, ready and clean boot logs", () => {
    expect(deployBootRows(request, boot, true).every(row => row.status === "passed")).toBe(true);
    for (const [changed, check] of [
      [{ ...boot, identity: request.previous }, "identity"],
      [{ ...boot, identity: { ...boot.identity, started: "unknown" } }, "identity"],
      [{ ...boot, commit: "old" }, "identity"],
      [{ ...boot, readyAt: null }, "ready"],
      [{ ...boot, errorCount: 1, errors: ["DiscordAPIError 50035: ingest ref is not a snowflake"] }, "boot logs"],
    ] as const) expect(deployBootRows(request, changed, true).find(row => row.check === check)?.status).toBe("failed");
    expect(deployBootRows(request, boot, false).find(row => row.check === "health")?.status).toBe("failed");
  });

  it("records level 50/60 real errors before ready, not warnings or later errors", async () => {
    const observer = new BootObserver();
    observer.begin(await directory(), { branch: "main", commit: "new" }, "boot");
    observer.record(40, [{ err: new Error("warning") }, "warning"]);
    observer.record(50, [{ err: new Error("Discord 50035: invalid channel_id") }, "boot recovery failed"], "dispatch-watcher");
    observer.record(60, [new Error("sqlite disk is full")]);
    observer.ready();
    observer.record(50, [{ err: new Error("later unrelated failure") }]);
    expect(observer.snapshot()).toMatchObject({ errorCount: 2, errors: [
      "level 50: dispatch-watcher: boot recovery failed: Discord 50035: invalid channel_id",
      "level 60: sqlite disk is full",
    ] });
  });

  it("names current, updated, explicitly excluded and missing managed hosts", async () => {
    const facts = new Map<string, BridgeReleaseFacts>([["current", { releaseSha: "new", sessiond: { releaseSha: "new" } }],
      ["updated", { releaseSha: "old", sessiond: { releaseSha: "old" } }]]);
    const f = fleet([{ bridgeId: "current" }, { bridgeId: "updated" }, { bridgeId: "missing" },
      { bridgeId: "mac", excluded: "operator-managed" }], facts);
    f.onReady("current"); f.onReady("updated"); await f.idle();
    facts.set("updated", { releaseSha: "new", sessiond: { releaseSha: "new" } });
    const rows = await deployFleetRows({ updater: f.handle, get: f.get, commit: "new", timeoutMs: 0 });
    expect(rows).toMatchObject([
      { host: "current", status: "passed", cause: "current" },
      { host: "updated", status: "passed", cause: "updated" },
      { host: "missing", status: "failed", cause: "unverified: managed host missing from reconnect inventory" },
      { host: "mac", status: "skipped", cause: "skipped: operator-managed" },
    ]);
  });

  it("waits for matching bridge AND daemon reconnect, not only a successful rollout command", async () => {
    const facts = new Map<string, BridgeReleaseFacts>([["host", { releaseSha: "old", sessiond: { releaseSha: "old" } }]]);
    const f = fleet([{ bridgeId: "host" }], facts);
    f.onReady("host"); await f.idle();
    expect((await deployFleetRows({ updater: f.handle, get: f.get, commit: "new", timeoutMs: 0 }))[0]).toMatchObject({ status: "failed", cause: expect.stringContaining("matching bridge/sessiond reconnect") });
    let now = 0;
    const rows = await deployFleetRows({ updater: f.handle, get: f.get, commit: "new", timeoutMs: 100,
      now: () => now, sleep: async ms => { now += ms; facts.set("host", { releaseSha: "new", sessiond: { releaseSha: "new" } }); } });
    expect(rows[0]).toMatchObject({ status: "passed", cause: "updated" });
  });

  it("keeps the updater's underlying failure and an unavailable target inventory red", async () => {
    const observed = [{ bridgeId: "host", outcome: "failed; retry on next connection", cause: "ssh: connection reset by peer" }];
    const updater = Object.assign(() => {}, { targets: [{ bridgeId: "host" }], idle: async () => {}, observations: () => observed,
      error: "target map not found: /deployment/targets.json" });
    const rows = await deployFleetRows({ updater, get: () => ({ releaseSha: "old" }), commit: "new", timeoutMs: 0 });
    expect(rows).toMatchObject([{ status: "failed", cause: expect.stringContaining("ssh: connection reset by peer") },
      { status: "failed", cause: expect.stringContaining("target map not found: /deployment/targets.json") }]);
  });

  it("keeps clean startup red if a host probe fails, without cancelling other work", async () => {
    const result = await verifyDeploy({ request, boot, health: async () => true, fleet: async () => [],
      probe: async () => { throw new Error("provider CLI exited: authentication expired"); } });
    expect(result.deploy).toEqual({ requestId: request.id, previous: request.previous, controller: boot.identity });
    expect(canaryIsGreen(result)).toBe(false);
    expect(result.rows.at(-1)?.cause).toContain("authentication expired");
  });

  it("requires a real passing turn for deploy verification even if the manual matrix would be all skipped", async () => {
    const result = await verifyDeploy({ request, boot, health: async () => true, fleet: async () => [],
      probe: async () => ({ ...probeResult(), rows: [{ host: "one", agent: "disabled", status: "skipped", durationMs: null }] }) });
    expect(canaryIsGreen(result)).toBe(false);
    expect(result.rows.at(-1)?.cause).toBe("no real canary turn passed");
  });

  it("does not replace the real health error with a generic failure", async () => {
    const result = await verifyDeploy({ request, boot, health: async () => { throw new Error("health HTTP 503: database opening"); },
      fleet: async () => [], probe: async () => probeResult() });
    expect(result.rows.find(row => row.check === "health")).toMatchObject({ status: "failed", cause: "health HTTP 503: database opening" });
  });

  it("waits past stale request results, old identities and early HTTP 200 before accepting the verdict", async () => {
    let now = 0;
    const completed = await verifyDeploy({ request, boot, health: async () => true, fleet: async () => [], probe: async () => probeResult() });
    const result = await waitForDeployResult({ request, now: () => now, timeoutMs: 4000,
      sleep: async ms => { now += ms; }, boot: async () => boot,
      health: async () => ({ status: "ok", controller: now < 2000 ? { ...boot, identity: request.previous } : boot }),
      result: async () => now === 0 ? { ...completed, deploy: { ...completed.deploy!, requestId: "previous-deploy" } }
        : now < 2000 ? undefined : completed });
    expect(now).toBe(2000);
    expect(canaryIsGreen(result)).toBe(true);
  });

  it("prints fatal boot causes when the new controller never reaches ready", async () => {
    let now = 0;
    const fatal = { ...boot, readyAt: null, errorCount: 1, errors: ["level 50: sqlite: disk is full"] };
    const result = await waitForDeployResult({ request, now: () => now, timeoutMs: 1, sleep: async ms => { now += ms; },
      health: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:3000"); }, result: async () => undefined, boot: async () => fatal });
    expect(canaryIsGreen(result)).toBe(false);
    expect(result.rows.find(row => row.check === "boot logs")?.cause).toContain("sqlite: disk is full");
    expect(result.rows.at(-1)?.cause).toContain("ECONNREFUSED");
  });

  it("renders one deploy result card rather than a host-agent matrix of pages", async () => {
    const result = await verifyDeploy({ request, boot, health: async () => true, fleet: async () => [], probe: async () => probeResult() });
    for (let host = 0; host < 5; host++) for (let agent = 0; agent < 10; agent++) result.rows.push({
      host: `host${host}`, agent: `agent${agent}`, status: "skipped", cause: "deploy probes one agent per host", durationMs: null });
    expect(renderCanaryLayouts(result)).toHaveLength(1);
  });

  it("publishes one card with the existing Discord component builder and returns its real jump link", async () => {
    const result = await verifyDeploy({ request, boot, health: async () => true, fleet: async () => [], probe: async () => probeResult() });
    const rest = { get: vi.fn().mockResolvedValue({ guild_id: "guild" }), post: vi.fn().mockResolvedValue({ id: "message" }),
      put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) };
    const published = await publishDeployCard(result, await directory(), "ops", rest);
    expect(rest.post).toHaveBeenCalledTimes(1);
    expect(rest.post).toHaveBeenCalledWith("/channels/ops/messages", expect.objectContaining({ body: expect.objectContaining({ flags: MessageFlags.IsComponentsV2 }) }));
    expect(published.jumpUrl).toBe("https://discord.com/channels/guild/ops/message");
    expect(canaryIsGreen(published)).toBe(true);
  });

  it.skipIf(process.platform !== "linux")("reads the legacy controller owner without changing its database", async () => {
    const dir = await directory();
    const db = new Database(path.join(dir, "seam.db"));
    db.exec("CREATE TABLE turn_attempt_owners (id TEXT PRIMARY KEY, process_json TEXT NOT NULL)");
    db.prepare("INSERT INTO turn_attempt_owners VALUES (?,?)").run("current", JSON.stringify(processOwner()));
    db.close();
    const before = await fs.readFile(path.join(dir, "seam.db"));
    expect(await legacyControllerIdentity(dir, process.cwd())).toEqual({ pid: process.pid, started: readProcessIdentity(process.pid)!.started });
    expect(await fs.readFile(path.join(dir, "seam.db"))).toEqual(before);
  });
});
