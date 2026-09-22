import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHost } from "../scripts/cli-health-observe.mjs";
import { collectReport, main, parseReportArgs, reportConfiguration, reportTargets } from "../scripts/cli-health-report.mjs";
import { renderRemoteScript, validateTargetMap } from "../scripts/lib/bridge-rollout.mjs";
import {
  beginRun, bridgeObservation, compareRelease, discoverReleases, finishRun,
  inspectTarget, nodeDrift, PUBLISHERS, qualifyCanary, readDay, renderDay,
  reachabilityHistory, reportDay, sanitizeInventory,
} from "../scripts/lib/cli-health-report.mjs";

const root = path.resolve(import.meta.dirname, "..");
const temporary: string[] = [];
async function temp() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "seam-cli-report-test-")); temporary.push(dir); return dir; }
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function put(rootDir: string, relative: string, body: string) {
  const file = path.join(rootDir, relative); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, body); return file;
}
const evidence = (version: string, sha: string, verdict = "pass") => ({
  schemaVersion: 1, kind: "agy-upgrade-evidence", sanitized: true, evidenceLevel: "live-verified",
  capturedAt: "2026-09-22T08:00:00.000Z", candidate: { version, sha256: sha.repeat(64) },
  baseline: { version: "1.2.0", sha256: "a".repeat(64) },
  comparison: { adapterCommit: "same", scenarioVersion: "same", hostClass: "same", declaredHostLoad: "same", modelId: "same" },
  capabilities: ["stream-subscription", "thinking", "mcp", "usage", "structured-output", "session-continuity", "cleanup"]
    .map((id) => ({ id, observations: 3, verdict })),
});
const release = { status: "observed", latest: "1.0.40" };
const record = (management = "reachable", preflight = "passed") => ({
  releases: { grok: release }, hosts: [{ host: "laptop", management, preflight, bridge: "observed-connected", inventory: null }], canary: null,
});

describe("nightly release/drift report (#504)", () => {
  // Necessity: without independent publisher discovery #505's ceiling hides fifteen releases.
  it("discovers outside CLI configuration and reports the ceiling's installed version as stale", async () => {
    const fetcher = vi.fn(async (url: string) => new Response(url === PUBLISHERS.grok.url ? "1.0.40\n"
      : JSON.stringify(url.includes("github.com/repos") ? { tag_name: "v1.2.8" } : { version: "2.1.0" })));
    const found = await discoverReleases(fetcher);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(Object.values(PUBLISHERS).map((p) => p.url));
    expect(PUBLISHERS.grok.url).toBe("https://x.ai/cli/stable");
    expect(PUBLISHERS["codex-acp"].url).toContain("@agentclientprotocol%2Fcodex-acp");
    expect(compareRelease("1.0.25", found.grok)).toBe("update-available");
    expect(compareRelease("1.0.40", found.grok)).toBe("matches-publisher");
  });

  // Necessity: failed discovery cannot certify a pinned host as current or disable other agents.
  it("fails narrowly to unknown for HTTP, malformed and oversized metadata", async () => {
    for (const response of [new Response("rate limit", { status: 429 }), new Response("not-a-version"), new Response("x".repeat(131073))]) {
      const found = await discoverReleases(async (url: string) => url === PUBLISHERS.grok.url ? response : new Response('{"version":"2.0.0","tag_name":"v2.0.0"}'));
      expect(found.grok.status).toBe("unknown");
      expect(found.codex.status).toBe("observed");
      expect(compareRelease("1.0.25", found.grok)).toBe("unknown");
    }
  });

  // Necessity: #415's writable --version self-updater must never run during inventory.
  it("reads manifests but never executes an agent or claims the active binding", async () => {
    const home = await temp();
    const executable = await put(home, ".local/bin/grok", "#!/bin/sh\ntouch '" + path.join(home, "EXECUTED") + "'\n");
    await fs.chmod(executable, 0o755);
    await put(home, ".nvm/versions/node/v22.22.2/lib/node_modules/@openai/codex/package.json", JSON.stringify({ name: "@openai/codex", version: "0.155.1" }));
    await put(home, ".nvm/versions/node/v22.22.2/lib/node_modules/@github/copilot/package.json", JSON.stringify({ name: "wrong-package", version: "9.0.0" }));
    const facts = await observeHost({ home, node: path.join(home, ".nvm/versions/node/v22.22.2/bin/node") });
    expect(facts.artifacts).toEqual([{ agent: "codex", version: "0.155.1", source: "npm-package-manifest", binding: "installation-only" }]);
    await expect(fs.stat(path.join(home, "EXECUTED"))).rejects.toThrow();
  });

  // Necessity: #521's working service interpreter must not conceal the default used on recreation.
  it("distinguishes service Node 22 from a floating default selecting Node 24", async () => {
    const home = await temp();
    await put(home, ".nvm/alias/default", "lts/*\n");
    await put(home, ".nvm/alias/lts/*", "v24.15.0\n");
    await fs.mkdir(path.join(home, ".nvm/versions/node/v24.15.0"), { recursive: true });
    const facts = await observeHost({ home, node: path.join(home, "node") });
    expect(facts.defaultNode).toMatchObject({ version: "24.15.0", floating: true });
    expect(nodeDrift("v22.22.2", facts.defaultNode)).toBe("different-on-recreation");
    expect(nodeDrift("v24.15.0", facts.defaultNode)).toBe("matches-today-floating-default");
    await put(home, ".nvm/alias/lts/*", "default\n");
    expect((await observeHost({ home, node: path.join(home, "node") })).defaultNode.status).toBe("unknown");
  });

  // Necessity: #537's impossible assertion must not be presented as a candidate regression.
  it("qualifies a refusal only against a separately passing, comparable incumbent", () => {
    const incumbent = evidence("1.2.0", "a", "fail"), candidate = evidence("1.2.8", "b", "fail");
    expect(qualifyCanary(incumbent, candidate).assertions.every((a: { outcome: string }) => a.outcome === "unqualified-baseline")).toBe(true);
    const good = evidence("1.2.0", "a");
    expect(qualifyCanary(good, candidate).assertions[0].outcome).toBe("recorded-regression");
    candidate.comparison.scenarioVersion = "different-task";
    expect(qualifyCanary(good, candidate).assertions[0].outcome).toBe("unqualified-baseline");
    expect(qualifyCanary(null, candidate).status).toBe("unchecked");
  });

  // Necessity: #550 separates serving presence from SSH access; stale cache cannot assert up.
  it("keeps presence, SSH refusal, sleeping and exclusion distinct", async () => {
    const cache = { lastSeen: { laptop: { agents: [] } } };
    expect(bridgeObservation(cache, 1000, "laptop", 1001)).toBe("observed-connected");
    expect(bridgeObservation(cache, 1000, "laptop", 200000)).toBe("unknown");
    expect(bridgeObservation({ lastSeen: { laptop: { agents: [], offlineSince: 1 } } }, 1000, "laptop", 1001)).toBe("observed-disconnected");
    const targets = validateTargetMap(JSON.parse(await fs.readFile(path.join(root, "ops/bridge/targets.json"), "utf8")));
    const run = vi.fn(async (_command: any) => { throw new Error("channel 0: open failed: connect failed: Connection refused secret/path"); });
    expect(await inspectTarget(targets.get("macbook-air"), {}, run)).toMatchObject({ management: "tunnel-forward-refused", preflight: "unchecked" });
    expect(await inspectTarget(targets.get("allie-laptop"), {}, run)).toMatchObject({ management: "excluded", preflight: "unchecked" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].args).toContain("StrictHostKeyChecking=yes");
  });

  // Necessity: reuse must retain the real preflight's refusal without suppressing other observations.
  it("uses the existing preflight evaluator and inventories even after refusal", async () => {
    const targets = validateTargetMap(JSON.parse(await fs.readFile(path.join(root, "ops/bridge/targets.json"), "utf8")));
    const run = vi.fn(async (command: { input?: string }) => ({ stdout: command.input === "preflight"
      ? `bridge_id=macbook-air\nidentity_bound=yes\nnode_version=v22.22.2\nnative_install_ready=no\n`
      : command.input === "observe" ? JSON.stringify({ schemaVersion: 1, artifacts: [], defaultNode: { version: "24.15.0", floating: true } }) : "" }));
    const found = await inspectTarget(targets.get("macbook-air"), { preflight: "preflight", observe: "observe" }, run);
    expect(found.preflight).toBe("refused-by-existing-preflight");
    expect(found.serviceNode).toBe("22.22.2");
    expect(found.preflightFindings[0].code).toBe("native_prebuild_unavailable");
    expect(found.inventory.defaultNode.version).toBe("24.15.0");
    expect(run).toHaveBeenCalledTimes(3);
  });

  // Necessity: one missing mapping must not shrink coverage or block otherwise observable hosts.
  it("walks union coverage with narrow divergence and local unknowns", async () => {
    const configured = JSON.parse(await fs.readFile(path.join(root, "ops/bridge/targets.json"), "utf8"));
    configured.targets["macbook-air"].nodePath = "unsafe";
    const validated = reportTargets(configured);
    expect(validated.get("macbook-air")).toBeNull();
    expect(validated.get("macbook-pro").nodePath).toMatch(/^\//);
    const inspect = vi.fn(async () => ({ host: "ok", management: "reachable", preflight: "passed" }));
    const result = await collectReport({ targets: new Map([["ok", {}], ["unregistered", {}]]), registered: new Set(["ok", "missing"]),
      scripts: {}, cache: {}, cacheMtime: 0, local: {}, canary: null },
    { inspect, discover: async () => ({ grok: release }), observe: async () => ({ schemaVersion: 1, artifacts: [] }) });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(result.hosts.map((h: { host: string }) => h.host)).toEqual(["missing", "ok", "unregistered", "control-plane"]);
    expect(result.hosts[0].management).toBe("unchecked-registry-divergence");
    expect(result.hosts.at(-1).serviceNode).toBeNull();
  });

  // Necessity: an unreadable fleet file must not suppress independent discovery or invent fleet coverage.
  it("keeps release observations when coverage configuration cannot be read", async () => {
    const config = reportConfiguration(null, { bridges: { laptop: {} } });
    expect(config.issues).toEqual(["target-map-unreadable"]);
    const found = await collectReport({ ...config, scripts: {}, cache: {}, cacheMtime: 0, local: {}, canary: null },
      { discover: async () => ({ grok: release }), observe: async () => ({ schemaVersion: 1, artifacts: [] }) });
    expect(found.releases.grok.latest).toBe("1.0.40");
    expect(found.hosts[0]).toMatchObject({ host: "laptop", management: "unchecked-registry-divergence" });
    expect(renderDay("2026-09-22", [{ ...found, coverageIssues: config.issues }])).toContain("Fleet coverage unknown: target-map-unreadable");
  });

  // Necessity: #540 reruns cannot erase failures; a killed run must not look like a pass.
  it("keeps prior refusals and incomplete runs in the one daily report", async () => {
    const dir = await temp(), day = "2026-09-22";
    const first = await beginRun(dir, day); await finishRun(first, record("reachable", "refused-by-existing-preflight"));
    const second = await beginRun(dir, day); await finishRun(second, record());
    await beginRun(dir, day);
    const daily = await readDay(dir, day);
    expect(daily).toHaveLength(3);
    const rendered = renderDay(day, daily);
    expect(rendered).toContain("refused-by-existing-preflight");
    expect(rendered).toContain("preflight passed");
    expect(rendered).toContain("Run incomplete/receipt unreadable");
    await fs.writeFile(path.join(first.dir, `${first.id}.json`), "broken");
    expect((await readDay(dir, day)).filter((r: { incomplete?: boolean }) => r.incomplete)).toHaveLength(2);
  });

  // Necessity: private SSH/environment data must not escape, and the CLI must expose no mutation flags.
  it("strips private fields and rejects mutation flags", () => {
    const safe = sanitizeInventory({ schemaVersion: 1, token: "SECRET", artifacts: [{ agent: "codex", version: "1.2.3", source: "npm-package-manifest", binding: "installation-only", path: "/private/SECRET" }], defaultNode: { version: "bad SECRET" } });
    expect(JSON.stringify(safe)).not.toContain("SECRET");
    expect(parseReportArgs(["--report", "2026-09-22"])).toEqual({ report: "2026-09-22" });
    expect(() => parseReportArgs(["--apply", "yes"])).toThrow("no mutation flags");
    expect(() => parseReportArgs(["--report", "../../secret"])).toThrow();
    expect(reportDay(new Date("2026-09-22T02:00:00Z"))).toBe("2026-09-21");
  });

  // Necessity: #550's multi-day loss of administrative access must not disappear at midnight.
  it("retains earlier daily SSH observations without claiming continuous downtime", async () => {
    const dir = await temp();
    const before = await beginRun(dir, "2026-09-20"); await finishRun(before, record());
    const missed = await beginRun(dir, "2026-09-21"); await finishRun(missed, record("ssh-connection-refused", "unchecked"));
    const again = await beginRun(dir, "2026-09-21"); await finishRun(again, record());
    const history = await reachabilityHistory(dir, "2026-09-22");
    expect(history[0]).toMatchObject({ lastReachableDay: "2026-09-21", missedProbeDays: ["2026-09-21"] });
    expect(renderDay("2026-09-22", [], history)).toContain("Not continuous downtime");
  });

  // Necessity: a helper-only test misses argv/stdin failures in the actual remote observation path.
  it("runs the rendered remote observation script offline without agent execution", async () => {
    const home = await temp(), checkout = await temp();
    const shell = await renderRemoteScript(path.join(root, "scripts/bridge-rollout-remote.sh"), path.join(root, "scripts/cli-health-observe.mjs"));
    const raw = execFileSync("/bin/sh", ["-s", "--", process.execPath, "fixture", "fixture", "grok", String(process.getuid!()), checkout, "entry", process.execPath],
      { input: shell, encoding: "utf8", env: { HOME: home, PATH: path.dirname(process.execPath) } });
    expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 1, defaultNode: { status: "unknown" } });
    expect(raw).not.toContain(home);
    expect(raw).not.toContain(checkout);
  });

  // Necessity: an administrator's nvm default must not be reported as another service owner's default.
  it("leaves inventory unknown when SSH and service ownership differ", async () => {
    const home = await temp();
    const shell = await renderRemoteScript(path.join(root, "scripts/bridge-rollout-remote.sh"), path.join(root, "scripts/cli-health-observe.mjs"));
    const raw = execFileSync("/bin/sh", ["-s", "--", process.execPath, "fixture", "fixture", "grok", String(process.getuid!() + 1), home, "entry", process.execPath],
      { input: shell, encoding: "utf8", env: { HOME: home } });
    expect(sanitizeInventory(JSON.parse(raw))).toMatchObject({ artifacts: [], reason: "ssh-user-differs-from-service-owner", defaultNode: { version: null } });
  });

  // Necessity: production scheduling must invoke the reporter, never an updater or a hold-for-wake job.
  it("wires the timer and supports an entirely offline morning re-render", async () => {
    const data = await temp();
    const run = await beginRun(path.join(data, "cli-health-reports"), "2026-09-22"); await finishRun(run, record());
    const stdout = execFileSync(process.execPath, [path.join(root, "scripts/cli-health-report.mjs"), "--data-dir", data, "--report", "2026-09-22"], { encoding: "utf8" });
    expect(stdout).toContain("Publisher grok: 1.0.40");
    const service = await fs.readFile(path.join(root, "ops/systemd/seam-cli-health-report.service"), "utf8");
    const timer = await fs.readFile(path.join(root, "ops/systemd/seam-cli-health-report.timer"), "utf8");
    expect(service).toContain("node scripts/cli-health-report.mjs");
    expect(service).not.toMatch(/ExecStart=.*(?:redeploy|rollout|update)/);
    expect(timer).toContain("Persistent=false");
    expect(timer).toContain("03:00:00 America/Chicago");
  });

  // Necessity: pure helpers alone cannot prove the scheduled entry point actually persists discovery.
  it("collects through the production entry point with offline publishers and an excluded fleet", async () => {
    const data = await temp();
    vi.stubEnv("HOME", data);
    const publishers = vi.fn(async (url: string) => new Response(url === PUBLISHERS.grok.url ? "1.0.40"
      : JSON.stringify({ tag_name: "v1.2.8", version: "1.2.8" })));
    vi.stubGlobal("fetch", publishers);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const targets = await put(data, "targets.json", JSON.stringify({ schemaVersion: 3, targets: {
      sleeping: { sshAlias: null, pm2App: null, verifyAgent: null, rolloutEnabled: false, unmanagedReason: "operator excluded" },
    } }));
    const registry = await put(data, "registry.json", JSON.stringify({ bridges: { sleeping: {} } }));
    await main(["--data-dir", data, "--targets", targets, "--registry", registry]);
    const saved = await readDay(path.join(data, "cli-health-reports"), reportDay());
    expect(saved).toHaveLength(1);
    expect(saved[0].releases.grok).toMatchObject({ latest: "1.0.40", status: "observed" });
    expect(saved[0].hosts[0]).toMatchObject({ host: "sleeping", management: "excluded", preflight: "unchecked" });
    expect(saved[0].canary.status).toBe("unchecked");
    expect(publishers).toHaveBeenCalledTimes(Object.keys(PUBLISHERS).length);
    expect(output.mock.calls[0]![0]).toContain("Publisher grok: 1.0.40");
  });

  // Necessity: duplicate, zero-observation or mismatched baseline evidence cannot qualify refusal.
  it("does not infer capability success from baseline identity alone", () => {
    const baseline = evidence("1.2.0", "a"), candidate = evidence("1.2.8", "b", "fail");
    baseline.capabilities[0]!.observations = 0;
    expect(qualifyCanary(baseline, candidate).assertions[0].outcome).toBe("unqualified-baseline");
    baseline.capabilities[0]!.observations = 3;
    baseline.capabilities.push(baseline.capabilities[0]!);
    expect(qualifyCanary(baseline, candidate).assertions[0].outcome).toBe("unqualified-baseline");
    candidate.baseline.sha256 = "c".repeat(64);
    expect(qualifyCanary(baseline, candidate).assertions[1].outcome).toBe("unqualified-baseline");
  });
});
