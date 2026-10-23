import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const cli = path.resolve(import.meta.dirname, "../packages/core/src/redeploy-cli.ts");
const fixture = path.resolve(import.meta.dirname, "fixtures/redeploy-health.mjs");
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

interface Event { type: string; call?: number; elapsed?: number; restarted?: boolean; timeoutMs?: number;
  healthCalls?: number; request?: { id: string; previous: { pid: number; started: string } } }

async function run(mode: "recover" | "timeout" | "http503" | "healthy", staging = false) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "redeploy-health-"));
  directories.push(cwd);
  const dataDir = path.join(cwd, "data");
  let code = 0, stdout = "", stderr = "";
  try {
    ({ stdout, stderr } = await execute(process.execPath, ["--import", fixture, "--import", import.meta.resolve("tsx"), cli], {
      cwd, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, DATA_DIR: dataDir, REDEPLOY_HEALTH_CASE: mode, LOG_LEVEL: "silent",
        TSX_TSCONFIG_PATH: path.resolve(import.meta.dirname, "../tsconfig.json"),
        SEAM_TEST_DRIVER_ACTOR_ID: staging ? "fixture-actor" : "", DISCORD_BOT_TOKEN: "fixture-token",
        SEAM_CANARY_SELF_CHANNEL_ID: "1553555541710741585" },
    }));
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    code = failed.code ?? -1; stdout = failed.stdout ?? ""; stderr = failed.stderr ?? "";
  }
  const trace = await fs.readFile(path.join(dataDir, "events.jsonl"), "utf8").catch(error => {
    throw new Error(`CLI produced no trace (exit ${code}): ${stderr}`, { cause: error });
  });
  const events: Event[] = trace.trim().split("\n").map(line => JSON.parse(line));
  const read = async (file: string) => JSON.parse(await fs.readFile(path.join(dataDir, file), "utf8"));
  return { code, stdout, stderr, events, dataDir, read };
}

describe("redeploy CLI pre-sentinel health observation", () => {
  it("recovers from the first five-second timeout, then requests exactly one verified restart", async () => {
    const result = await run("recover");
    expect(result.code, result.stderr).toBe(0);
    expect(result.events.filter(event => event.type === "sentinel")).toEqual([
      { type: "sentinel", elapsed: 6000, healthCalls: 2 },
    ]);
    expect(result.events.filter(event => event.type === "health")).toMatchObject([
      { call: 1, restarted: false, timeoutMs: 5000 },
      { call: 2, restarted: false, timeoutMs: 5000 },
      { call: 3, restarted: true },
    ]);
    const request = await result.read("deploy-canary-request.json");
    expect(request.previous).toEqual({ pid: 123, started: "linux:10" });
    const verdict = await result.read("deploy-canary-result.json");
    expect(verdict.deploy.requestId).toBe(request.id);
    expect(verdict.deploy.previous).toEqual(request.previous);
    expect(verdict.deploy.controller).toEqual({ pid: 124, started: "linux:20" });
    expect(result.stdout).toContain("GREEN");
    expect(result.stderr).toContain("The operation was aborted due to timeout");
    expect(await fs.readFile(path.join(result.dataDir, ".restart-pending"), "utf8")).toBe("");
    expect(result.events.filter(event => event.type === "card")).toHaveLength(1);
  });

  it.each([
    ["timeout", "The operation was aborted due to timeout"],
    ["http503", "/health: HTTP 503"],
  ] as const)("reports persistent %s after the bounded observation without requesting a restart", async (mode, cause) => {
    const result = await run(mode);
    expect(result.code, result.stderr).toBe(1);
    const health = result.events.filter(event => event.type === "health");
    expect(health.length).toBeGreaterThan(1);
    expect(health.at(-1)!.elapsed!).toBeLessThan(60_000);
    expect(result.events.find(event => event.type === "card")?.elapsed).toBe(60_000);
    expect(health.every(event => event.timeoutMs! > 0 && event.timeoutMs! <= 5000)).toBe(true);
    expect(result.events.filter(event => event.type === "sentinel")).toHaveLength(0);
    expect(result.events.filter(event => event.type === "request")).toHaveLength(0);
    await expect(fs.stat(path.join(result.dataDir, ".restart-pending"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(result.dataDir, "deploy-canary-request.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const verdict = await result.read("deploy-canary-result.json");
    expect(verdict.rows).toEqual([expect.objectContaining({ host: "controller", agent: "deploy", status: "failed", cause })]);
    expect(result.stdout).toContain("RED");
    expect(result.stdout).toContain(cause);
    const history = await fs.readFile(path.join(result.dataDir, "canary-self-history.jsonl"), "utf8");
    expect(history.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(history).rows[0].cause).toBe(cause);
  });

  it("leaves the healthy first read immediate", async () => {
    const result = await run("healthy");
    expect(result.code, result.stderr).toBe(0);
    expect(result.events.filter(event => event.type === "sentinel")).toEqual([{ type: "sentinel", elapsed: 0, healthCalls: 1 }]);
  });

  it("keeps staging's sentinel-only path without reading health", async () => {
    const result = await run("timeout", true);
    expect(result.code, result.stderr).toBe(0);
    expect(result.events).toEqual([{ type: "sentinel", elapsed: 0, healthCalls: 0 }]);
    expect(result.stdout).toContain("staging; production verification not run");
  });
});
