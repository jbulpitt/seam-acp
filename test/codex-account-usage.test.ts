import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCodexProfile, probeCodexAccountRateLimits } from "../packages/adapters/src/profiles/codex.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(mode = "ok") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-codex-quota-"));
  roots.push(root);
  const calls = path.join(root, "calls.jsonl");
  const executable = path.join(root, "codex-acp.mjs");
  fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";
const log = value => fs.appendFileSync(process.env.QUOTA_CALLS, JSON.stringify(value) + "\\n");
log({event: "start", pid: process.pid, args: process.argv.slice(2)});
process.on("exit", () => log({event: "exit", pid: process.pid}));
process.on("SIGTERM", () => process.exit(0));
const input = readline.createInterface({input: process.stdin});
input.on("close", () => process.exit(0));
input.on("line", line => {
  const request = JSON.parse(line);
  log({event: "request", method: request.method});
  if (request.method === "initialize") {
    console.log(JSON.stringify({id: request.id, result: {userAgent: "seam/0.159.2"}}));
  } else if (request.method === "initialized") {
  } else if (request.method === "account/rateLimits/read") {
    if (process.env.QUOTA_MODE === "stall") return;
    if (process.env.QUOTA_MODE === "error") {
      console.log(JSON.stringify({id: request.id, error: {code: -32000, message: "provider: Authentication required"}}));
      return;
    }
    console.log(JSON.stringify({id: request.id, result: {
      accountId: "fixture-account", rateLimits: {planType: "pro", primary: {usedPercent: 99, windowDurationMins: 10080, resetsAt: 123}},
      rateLimitsByLimitId: {codex: {planType: "pro", primary: {usedPercent: 7, windowDurationMins: 10080, resetsAt: 456}, secondary: null}},
    }}));
  } else {
    console.log(JSON.stringify({id: request.id, error: {code: -1, message: "unexpected method"}}));
  }
});
`, { mode: 0o755 });
  const env = { PATH: process.env.PATH, QUOTA_CALLS: calls, QUOTA_MODE: mode };
  const runtime = { executable, baseArgs: [], cwd: root, env };
  const events = () => fs.readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { root, runtime, events };
}

describe("Codex prompt-free live account usage", () => {
  it("uses the configured wrapper's app server and the codex bucket, with no thread or turn", async () => {
    const f = fixture();
    const data = await probeCodexAccountRateLimits(f.runtime);
    expect(data).toMatchObject({ ok: true, plan: "pro", primary: {usedPercent: 7, windowMinutes: 10080, resetsAt: 456}, secondary: null,
      source: {kind: "live", host: os.hostname()} });
    expect(Date.parse(data.source!.observedAt!)).toBeGreaterThan(0);
    expect(f.events().filter(event => event.event === "request").map(event => event.method))
      .toEqual(["initialize", "initialized", "account/rateLimits/read"]);
    expect(f.events()[0].args).toEqual(["cli", "app-server"]);
    expect(f.events().at(-1).event).toBe("exit");
  });

  it("propagates the provider cause and reaps a failed read", async () => {
    const f = fixture("error");
    await expect(probeCodexAccountRateLimits(f.runtime)).rejects.toThrow("provider: Authentication required");
    expect(f.events().at(-1).event).toBe("exit");
  });

  it("reaps a timed-out account read", async () => {
    const f = fixture("stall");
    await expect(probeCodexAccountRateLimits(f.runtime, undefined, 250)).rejects.toThrow(/timed out/);
    const pid = f.events()[0].pid;
    expect(() => process.kill(pid, 0)).toThrow();
    expect(f.events().at(-1).event).toBe("exit");
  });

  it("cancels and reaps the read without leaving a waiting request", async () => {
    const f = fixture("stall");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("fixture quota cancelled")), 250);
    try {
      await expect(probeCodexAccountRateLimits(f.runtime, controller.signal)).rejects.toMatchObject({name: "ProbeError", code: "cancelled"});
    } finally { clearTimeout(timer); }
    expect(() => process.kill(f.events()[0].pid, 0)).toThrow();
  });

  it("reads live limits through the configured profile instead of its stale local rollout", async () => {
    const f = fixture();
    const home = path.join(f.root, "state");
    fs.mkdirSync(path.join(home, "sessions"), {recursive: true});
    fs.writeFileSync(path.join(home, "sessions", "fixture.jsonl"), JSON.stringify({timestamp: "2026-10-06T00:00:00Z", payload: {
      type: "token_count", rate_limits: {plan_type: "pro", primary: {used_percent: 100, window_minutes: 10080, resets_at: 456}},
    }}) + "\n");
    const profile = makeCodexProfile({defaultModel: "fixture", cliPath: f.runtime.executable, extraEnv: {
      CODEX_HOME: home, OPENAI_API_KEY: "", CODEX_API_KEY: "", QUOTA_CALLS: f.runtime.env.QUOTA_CALLS, QUOTA_MODE: "ok",
    }});
    const contextUsage = vi.spyOn(profile.sessionManager!, "getUsage");
    const live = await profile.accountUsage!();
    expect(live.primary?.usedPercent).toBe(7);
    expect(live.source).toMatchObject({kind: "live", host: os.hostname()});
    expect(contextUsage).not.toHaveBeenCalled();
  });

  it("falls back to the existing local snapshot with its original time and the live failure cause", async () => {
    const f = fixture("error");
    const home = path.join(f.root, "state");
    fs.mkdirSync(path.join(home, "sessions"), {recursive: true});
    fs.writeFileSync(path.join(home, "sessions", "fixture.jsonl"), JSON.stringify({timestamp: "2026-10-06T00:00:00Z", payload: {
      type: "token_count", rate_limits: {plan_type: "pro", primary: {used_percent: 100, window_minutes: 10080, resets_at: 456}},
    }}) + "\n");
    const profile = makeCodexProfile({defaultModel: "fixture", cliPath: f.runtime.executable, extraEnv: {
      CODEX_HOME: home, OPENAI_API_KEY: "", CODEX_API_KEY: "", QUOTA_CALLS: f.runtime.env.QUOTA_CALLS, QUOTA_MODE: "error",
    }});
    const snapshot = await profile.accountUsage!();
    expect(snapshot.ok).toBe(true);
    expect(snapshot.primary?.usedPercent).toBe(100);
    expect(snapshot.source).toEqual({kind: "rollout", host: os.hostname(), observedAt: "2026-10-06T00:00:00.000Z"});
    expect(snapshot.liveError).toContain("provider: Authentication required");
    expect(f.events().at(-1).event).toBe("exit");
  });

  it("reports both live and local snapshot causes when neither read succeeds", async () => {
    const f = fixture("error");
    const profile = makeCodexProfile({defaultModel: "fixture", cliPath: f.runtime.executable, extraEnv: {
      CODEX_HOME: path.join(f.root, "empty"), OPENAI_API_KEY: "", CODEX_API_KEY: "",
      QUOTA_CALLS: f.runtime.env.QUOTA_CALLS, QUOTA_MODE: "error",
    }});
    const data = await profile.accountUsage!();
    expect(data.ok).toBe(false);
    expect(data.error).toContain("provider: Authentication required");
    expect(data.error).toContain("no rate-limit data in recent codex sessions");
  });

  it("propagates owner cancellation instead of returning a fallback", async () => {
    const f = fixture();
    const profile = makeCodexProfile({defaultModel: "fixture", cliPath: f.runtime.executable, extraEnv: {
      CODEX_HOME: f.root, OPENAI_API_KEY: "", CODEX_API_KEY: "", QUOTA_CALLS: f.runtime.env.QUOTA_CALLS, QUOTA_MODE: "ok",
    }});
    const controller = new AbortController();
    controller.abort(new Error("owner cancelled"));
    await expect(profile.accountUsage!(controller.signal)).rejects.toMatchObject({name: "ProbeError", code: "cancelled"});
    expect(fs.existsSync(path.join(f.root, "calls.jsonl"))).toBe(false);
  });
});
