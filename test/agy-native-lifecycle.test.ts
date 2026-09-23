import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { describe, it, expect, vi } from "vitest";
import { makeAgyProfile, readErrorClassification } from "@seam/adapters";
import { AgentRuntime, type AgentEvent } from "../packages/core/src/agents/agent-runtime.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { createManagedAgyFixture } from "./helpers/agy-runtime-fixture.js";
import { ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";

const fixtures = fileURLToPath(new URL("./fixtures/agy-native-capabilities/", import.meta.url));
const logger = pino({ level: "silent" }) as unknown as Logger;
type Row = { scenario?: string; pid?: number; prompt?: string; args?: string[]; home?: string; signal?: string; mcpConfig?: unknown };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function fixture(timeoutSeconds = 10, fixtureLogger: Logger = logger) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r5-"));
  const log = path.join(root, "invocations");
  const managed = createManagedAgyFixture({
    source: path.join(fixtures, "fake-native-agy.mjs"), version: "agy fixture 1.1.28", cwd: root,
    approvedEnvironment: { SEAM_AGY_CAPABILITY_FIXTURE_DIR: fixtures, SEAM_AGY_CAPABILITY_INVOCATIONS: log },
  });
  const profile = makeAgyProfile({
    runtime: managed.runtime, dataDir: root, defaultModel: "Fixture Native Model",
    printTimeoutSeconds: timeoutSeconds, exposeGlobalStaging: false,
    mcpServers: [{ type: "http", name: "must-not-inherit", url: "http://127.0.0.1:9", headers: [] }],
  });
  const runtime = new AgentRuntime({ logger: fixtureLogger, profile, spawnFn: profile.spawn.bind(profile) });
  const events: AgentEvent[] = [];
  runtime.onEvent(event => { events.push(event); });
  await runtime.start();
  await runtime.newSession({ cwd: root, model: "fixture-native-model", strictModel: true });
  const rows = (): Row[] => fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as Row);
  return { root, runtime, managed, events, rows, async close() {
    await runtime.dispose();
    // Mutation runs may deliberately break reaping; never leave their fixtures.
    for (const row of rows()) if (row.pid && alive(row.pid)) {
      try { process.kill(row.pid, "SIGKILL"); } catch { /* already exited */ }
    }
    managed.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

describe.sequential("R5 native production lifecycle", () => {
  it("#371 completes from stdout after an unauthenticated subscription and labels degradation", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(f.runtime.prompt("r5-stream-auth")).resolves.toMatchObject({ stopReason: "end_turn" });
      const emitted = JSON.stringify(f.events);
      expect(emitted).toContain("STDOUT ONLY OK🧭");
      expect(emitted).toContain("streamed thoughts, tool updates and permission prompts are unavailable");
      expect(emitted).toContain("unauthenticated: missing CSRF token");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("unauthenticated: missing CSRF token; using stdout fallback"));
      expect(f.rows().filter(row => row.prompt === "r5-stream-auth")).toHaveLength(1);
      expect(f.events.filter(event => event.kind === "agy-stdout-fallback"))
        .toEqual([{ kind: "agy-stdout-fallback", code: "unauthenticated" }]);
    } finally { log.mockRestore(); await f.close(); }
  }, 15_000);

  it("#371 keeps the fallback caveat separate from structured JSON", async () => {
    const f = await fixture();
    try {
      await expect(f.runtime.prompt("r5-stream-auth", undefined, { jsonSchema: { type: "object" } })).resolves.toMatchObject({ stopReason: "end_turn" });
      const text = f.events.flatMap(event => event.kind === "agent-text" ? [event.text] : []).join("");
      expect(JSON.parse(text)).toEqual({ answer: "OK" });
      expect(f.events.some(event => event.kind === "agent-thought" && event.text.includes("Using stdout only"))).toBe(true);
      expect(f.events.filter(event => event.kind === "agy-stdout-fallback"))
        .toEqual([{ kind: "agy-stdout-fallback", code: "unauthenticated" }]);
    } finally { await f.close(); }
  }, 15_000);

  it("#545 retains a version-incompatible subscription code, not a generic auth label", async () => {
    const f = await fixture();
    try {
      await expect(f.runtime.prompt("r5-stream-unimplemented")).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(f.events.filter(event => event.kind === "agy-stdout-fallback"))
        .toEqual([{ kind: "agy-stdout-fallback", code: "unimplemented" }]);
    } finally { await f.close(); }
  }, 15_000);

  it("#371 keeps a working stream authoritative without fallback", async () => {
    const f = await fixture();
    try {
      await expect(f.runtime.prompt("capability-turn-one")).resolves.toMatchObject({ stopReason: "end_turn" });
      const emitted = JSON.stringify(f.events);
      expect(f.events.some(event => event.kind === "agent-thought")).toBe(true);
      expect(emitted).not.toContain("DO NOT USE STDOUT");
      expect(emitted).not.toContain("Using stdout only");
      expect(f.events.some(event => event.kind === "agy-stdout-fallback")).toBe(false);
    } finally { await f.close(); }
  }, 15_000);

  it("labels a cumulative planner correction instead of appending from a stale snapshot (#262)", async () => {
    const f = await fixture();
    try {
      await expect(f.runtime.prompt("capability-correction")).resolves.toMatchObject({ stopReason: "end_turn" });
      const text = f.events.flatMap(event => event.kind === "agent-text" ? [event.text] : []).join("");
      const thought = f.events.flatMap(event => event.kind === "agent-thought" ? [event.text] : []).join("");
      expect(text).toBe("Choose red\n\n[AGY corrected the preceding message]\nChoose new!");
      expect(thought).toBe("Check red path\n\n[AGY corrected the preceding thought]\nCheck new path safely");
    } finally { await f.close(); }
  }, 15_000);

  it("keeps generated-image IO in the ACP application layer after translation (#262)", async () => {
    const f = await fixture();
    try {
      await expect(f.runtime.prompt("capability-generated-image")).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(f.events.filter((event) => event.kind === "agent-file")).toEqual([
        expect.objectContaining({
          kind: "agent-file",
          source: "message",
          filename: "generated.png",
          mimeType: "image/png",
          data: "iVBORw0KGgo=",
          base64: true,
        }),
      ]);
      expect(f.events.some((event) => event.kind === "tool-start" && event.title === "generate image")).toBe(false);
    } finally { await f.close(); }
  }, 15_000);

  it("#371 preserves a mid-stream rejection cause and never duplicates partial output from stdout", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Assert the adapter attempt, not #448's surrounding recovery budget.
      await expect(f.runtime.prompt("r5-stream-partial", undefined, { recoveryScope: "ephemeral" })).rejects.toThrow("unauthenticated: missing CSRF token");
      const emitted = JSON.stringify(f.events);
      expect(emitted).toContain("PARTIAL STREAM");
      expect(emitted).not.toContain("STDOUT ONLY");
      expect(f.events.some(event => event.kind === "agy-stdout-fallback")).toBe(false);
      expect(emitted).not.toContain("Using stdout only");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("unauthenticated: missing CSRF token"));
    } finally { log.mockRestore(); await f.close(); }
  }, 15_000);

  it.each([["r5-stream-exit", "exited_early"], ["r5-stream-overflow", "output_overflow"], ["r5-stream-hang", "timeout"]])(
    "#371 fallback retains lifecycle bounds for %s", async (prompt, code) => {
      const f = await fixture(3);
      try { await expect(f.runtime.prompt(prompt, undefined, { recoveryScope: "ephemeral" })).rejects.toThrow(code); }
      finally { await f.close(); }
    }, 15_000,
  );

  it("#491 classifies a nested child auth exit after partial output without leaking its diagnostic", async () => {
    const records: unknown[][] = [];
    const captureLogger = {
      child() { return this; },
      trace: (...args: unknown[]) => records.push(args),
      debug: (...args: unknown[]) => records.push(args),
      info: (...args: unknown[]) => records.push(args),
      warn: (...args: unknown[]) => records.push(args),
      error: (...args: unknown[]) => records.push(args),
      fatal: (...args: unknown[]) => records.push(args),
    } as unknown as Logger;
    const f = await fixture(10, captureLogger);
    const consoleErrors: unknown[][] = [];
    const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args) => { consoleErrors.push(args); });
    try {
      const caught = await f.runtime.prompt(
        "r5-turn-auth-exit",
        undefined,
        { recoveryScope: "ephemeral" },
      ).then(() => undefined, (error: unknown) => error);

      const text = f.events.flatMap((event) => event.kind === "agent-text" ? [event.text] : []).join("");
      expect(text).toContain("partial");
      expect(caught).toBeInstanceOf(Error);
      expect(readErrorClassification(caught)).toMatchObject({
        agentId: "agy",
        errorKind: "auth_required",
        exitCode: 41,
        signal: null,
      });
      expect(String(caught)).toContain("auth_required");
      expect(String(caught)).toContain("child exit code=41, signal=none");

      // This is the returned error, AgentRuntime log/event surface, and direct
      // console surface together. Deleting classify-before-discard either
      // loses auth_required or tempts raw stderr across one of these borders.
      const exposed = JSON.stringify({ caught, text: String(caught), events: f.events, records, consoleErrors });
      for (const secret of [
        "synthetic-secret-token-491",
        "Authorization: Bearer",
        f.root,
        f.managed.executable,
      ]) {
        expect(exposed).not.toContain(secret);
      }
    } finally {
      consoleSpy.mockRestore();
      await f.close();
    }
  }, 15_000);

  it("#491 reports an unknown nested child exit as unclassified, not adapter death", async () => {
    const f = await fixture();
    try {
      const caught = await f.runtime.prompt(
        "r5-turn-unknown-exit",
        undefined,
        { recoveryScope: "ephemeral" },
      ).then(() => undefined, (error: unknown) => error);
      expect(readErrorClassification(caught)).toMatchObject({
        agentId: "agy",
        errorKind: "unclassified",
        exitCode: 52,
        signal: null,
      });
      expect(String(caught)).toContain("unclassified");
      expect(String(caught)).toContain("child exit code=52, signal=none");
      expect(String(caught)).not.toContain("future AGY child failure");
    } finally { await f.close(); }
  }, 15_000);

  it("persists only the safe native failure through the real catalog service", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r5-durable-"));
    const managed = createManagedAgyFixture({
      source: path.join(fixtures, "fake-native-agy.mjs"), version: "agy fixture 1.1.28", cwd: root,
      approvedEnvironment: { SEAM_AGY_CAPABILITY_FIXTURE_DIR: fixtures, SEAM_AGY_R5_CATALOG_MODE: "fail" },
    });
    const profile = makeAgyProfile({ runtime: managed.runtime, defaultModel: "Fixture Native Model" });
    const store = new ModelCatalogStore(path.join(root, "catalog.db"));
    const binding = { agentId: "agy", location: "local" };
    const service = new ModelCatalogService({
      store, logger, bindings: () => [binding], fetch: () => profile.catalog.fetch(),
      scope: () => profile.catalog.scope(), refreshCron: "0 0 1 1 *",
    });
    try {
      const result = await service.refresh(binding);
      expect(result.ok).toBe(false);
      const persisted = store.getRefreshStatus("agy@local");
      expect(persisted?.error).toBe(result.error);
      expect(result.error).toContain("exited_early");
      for (const exposed of [result.error, persisted?.error]) {
        expect(exposed).not.toContain("synthetic-password");
        expect(exposed).not.toContain(root);
        expect(exposed).not.toContain(managed.executable);
      }
    } finally { service.stop(); store.close(); managed.cleanup(); fs.rmSync(root, { recursive: true, force: true }); }
  }, 15_000);

  it("#481 closes prompt-free stdin and preserves only auth_required through the real catalog consumer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-auth-probe-"));
    const invocationLog = path.join(root, "invocations");
    const managed = createManagedAgyFixture({
      source: path.join(fixtures, "fake-native-agy.mjs"), version: "agy fixture 1.1.28", cwd: root,
      approvedEnvironment: {
        SEAM_AGY_CAPABILITY_FIXTURE_DIR: fixtures,
        SEAM_AGY_CAPABILITY_INVOCATIONS: invocationLog,
        SEAM_AGY_R5_CATALOG_MODE: "auth-wait",
      },
    });
    const profile = makeAgyProfile({ runtime: managed.runtime, defaultModel: "Fixture Native Model" });
    const store = new ModelCatalogStore(path.join(root, "catalog.db"));
    const warnings: Array<{ fields: Record<string, unknown>; message: string }> = [];
    const captureLogger = {
      info: () => {},
      warn: (fields: Record<string, unknown>, message: string) => warnings.push({ fields, message }),
    } as unknown as Logger;
    const binding = { agentId: "agy", location: "local" };
    const service = new ModelCatalogService({
      store, logger: captureLogger, bindings: () => [binding], fetch: () => profile.catalog.fetch(),
      scope: () => profile.catalog.scope(), refreshCron: "0 0 1 1 *",
    });
    const consoleErrors: unknown[][] = [];
    const consoleSpy = vi.spyOn(console, "error").mockImplementation((...args) => { consoleErrors.push(args); });
    try {
      const started = Date.now();
      const result = await service.refresh(binding);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result).toMatchObject({ ok: false, result: "retained" });

      const warning = warnings.find((entry) => entry.message === "model catalog refresh failed; previous snapshot retained");
      expect(warning).toBeDefined();
      const caught = warning!.fields.err;
      expect(readErrorClassification(caught)).toMatchObject({
        agentId: "agy",
        errorKind: "auth_required",
      });

      const rows = fs.readFileSync(invocationLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Row);
      const launch = rows.find((row) => row.scenario === "catalog" && row.args?.includes("models"));
      expect(launch?.pid).toBeTypeOf("number");
      expect(rows.some((row) => row.scenario === "catalog-stdin-end" && row.pid === launch?.pid)).toBe(true);
      expect(alive(launch!.pid!)).toBe(false);

      const persisted = store.getRefreshStatus("agy@local");
      expect(persisted?.error).toBe(result.error);
      // `result.error` is what the Discord catalog card renders; the caught
      // error is what the real logger serializes. Both stay generic while the
      // closed enum survives in `data.errorKind` for the resolver.
      const caughtRecord = caught as Error & { code?: unknown; detail?: unknown; data?: unknown };
      const exposed = JSON.stringify({
        result: result.error,
        durable: persisted?.error,
        logged: {
          text: String(caughtRecord),
          code: caughtRecord.code,
          detail: caughtRecord.detail,
          data: caughtRecord.data,
        },
        consoleErrors,
      });
      expect(exposed).toContain("auth_required");
      for (const secret of [
        "synthetic-secret-token-481",
        "Authorization: Bearer",
        root,
        managed.executable,
      ]) {
        expect(exposed).not.toContain(secret);
      }
    } finally {
      consoleSpy.mockRestore();
      service.stop();
      store.close();
      managed.cleanup();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 5_000);
  it.each([
    ["r5-exit", "exited_early"],
    ["r5-stderr", "output_overflow"],
    ["r5-malformed", "protocol_error"],
    ["r5-oversized-frame", "output_overflow"],
    ["r5-no-ls", "timeout"],
  ])("bounds %s and keeps diagnostics out of the ACP consumer", async (prompt, code) => {
    const f = await fixture(prompt === "r5-no-ls" ? 2 : 10);
    try {
      const start = Date.now();
      // Per-attempt lifecycle bounds also protect isolated dispatches. A live
      // conversation may now recover; its total budget is tested in #448.
      const error = await f.runtime.prompt(prompt, undefined, { recoveryScope: "ephemeral" }).then(() => "unexpected success", error => String(error));
      expect(error).toContain(code);
      expect(f.events.some(event => event.kind === "agy-stdout-fallback")).toBe(false);
      expect(Date.now() - start).toBeLessThan(5000);
      const row = f.rows().find(row => row.prompt === prompt)!;
      expect(row.pid).toBeTypeOf("number");
      expect(alive(row.pid!)).toBe(false);
      expect(error + JSON.stringify(f.events)).not.toContain("synthetic-password");
      expect(error + JSON.stringify(f.events)).not.toContain(row.home);
      await expect(f.runtime.prompt("capability-turn-one")).resolves.toMatchObject({ stopReason: "end_turn" });
    } finally { await f.close(); }
  }, 15_000);

  it("cancel awaits a TERM-resistant child; disposal preserves the saved conversation", async () => {
    const f = await fixture();
    try {
      const pending = f.runtime.prompt("r5-term");
      void pending.catch(() => {});
      await vi.waitFor(() => expect(f.events.some(event => event.kind === "agent-thought")).toBe(true), { timeout: 5000 });
      const row = f.rows().find(row => row.prompt === "r5-term")!;
      const start = Date.now();
      await f.runtime.cancel();
      await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
      expect(Date.now() - start).toBeLessThan(3500);
      expect(f.rows().some(row => row.signal === "SIGTERM")).toBe(true);
      expect(alive(row.pid!)).toBe(false);
      const saved = fs.readFileSync(path.join(f.root, "agy-sessions.json"), "utf8");
      expect(saved).toContain('"cascadeId": "11111111-1111-4111-8111-111111111111"');
      await f.runtime.dispose();
      await f.runtime.dispose();
      expect(fs.readFileSync(path.join(f.root, "agy-sessions.json"), "utf8")).toBe(saved);
      expect(fs.existsSync(row.home!)).toBe(false);
    } finally { await f.close(); }
  }, 15_000);

  it("the production factory keeps default MCP servers in a private HOME", async () => {
    const f = await fixture();
    try {
      await f.runtime.prompt("capability-turn-one");
      const row = f.rows().find(row => row.prompt === "capability-turn-one")!;
      // Launch flags describe what we pass to AGY; they do not prove OS
      // confinement. Removing the dead sandbox path must not remove active MCP
      // isolation or the existing permission posture (#391).
      expect(row.args).not.toContain("--sandbox");
      expect(row.args).toContain("--dangerously-skip-permissions");
      const dirs = row.args!.flatMap((arg, i) => arg === "--add-dir" ? [row.args![i + 1]] : []);
      expect(dirs).toEqual([f.root]);
      expect(row.mcpConfig).toEqual({
        mcpServers: {
          "must-not-inherit": {
            disabled: false,
            serverUrl: "http://127.0.0.1:9",
          },
        },
      });
      expect(fs.statSync(row.home!).mode & 0o777).toBe(0o700);
    } finally { await f.close(); }
  }, 15_000);

  it("#493 retains the HOME across a successful turn and removes it when the ACP session runtime ends", async () => {
    const f = await fixture();
    let home: string | undefined;
    try {
      await expect(f.runtime.prompt("capability-turn-one")).resolves.toMatchObject({ stopReason: "end_turn" });
      home = f.rows().find(row => row.prompt === "capability-turn-one")?.home;
      expect(home).toBeTypeOf("string");
      // A successful prompt is not the end of the ACP session: deleting here
      // would break the next turn's isolated MCP config and credential links.
      expect(fs.existsSync(home!)).toBe(true);

      await f.runtime.dispose();
      expect(fs.existsSync(home!)).toBe(false);
    } finally {
      await f.close();
    }
  }, 15_000);

  it("reaps TERM-resistant descendants before a subsequent prompt starts", async () => {
    const f = await fixture();
    try {
      const pending = f.runtime.prompt("r5-tree");
      void pending.catch(() => {});
      await vi.waitFor(() => expect(f.events.some(event => event.kind === "agent-thought")).toBe(true), { timeout: 5000 });
      const descendant = f.rows().find(row => row.scenario === "descendant")!;
      expect(alive(descendant.pid!)).toBe(true);
      await f.runtime.cancel();
      await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
      expect(alive(descendant.pid!)).toBe(false);
      await expect(f.runtime.prompt("capability-turn-one")).resolves.toMatchObject({ stopReason: "end_turn" });
    } finally { await f.close(); }
  }, 15_000);

  it("cancels during LS startup without waiting for the turn deadline", async () => {
    const f = await fixture();
    const pending = f.runtime.prompt("r5-no-ls");
    void pending.catch(() => {});
    try {
      await vi.waitFor(() => expect(f.rows().some(row => row.prompt === "r5-no-ls")).toBe(true), { timeout: 5000 });
      const row = f.rows().find(row => row.prompt === "r5-no-ls")!;
      const start = Date.now();
      await f.runtime.cancel();
      await expect(pending).resolves.toMatchObject({ stopReason: "cancelled" });
      expect(Date.now() - start).toBeLessThan(3500);
      expect(alive(row.pid!)).toBe(false);
    } finally { await f.close(); }
  }, 15_000);

  it("reaps partial startup through the real ACP profile and removes turn files", async () => {
    const f = await fixture();
    const prepare = f.managed.runtime.prepare.bind(f.managed.runtime);
    let pid: number | undefined;
    let logFile: string | undefined;
    const spy = vi.spyOn(f.managed.runtime, "prepare").mockImplementation((args, cwd, options) => {
      const launch = prepare(args, cwd, options);
      logFile = args[args.indexOf("--log-file") + 1];
      return { close: launch.close, spawn: () => {
        const child = launch.spawn();
        pid = child.pid;
        Object.defineProperty(child, "stdout", { value: null });
        return child;
      } };
    });
    try {
      await expect(f.runtime.prompt("capability-turn-one")).rejects.toThrow("spawn_failed");
      expect(pid).toBeTypeOf("number");
      expect(alive(pid!)).toBe(false);
      expect(logFile).toBeTypeOf("string");
      expect(fs.existsSync(logFile!)).toBe(false);
    } finally { spy.mockRestore(); await f.close(); }
  }, 15_000);

  it("bounds structured stdout before retaining it as a result", async () => {
    const f = await fixture();
    try {
      await expect(f.runtime.prompt("r5-stdout", undefined, { jsonSchema: { type: "object" }, recoveryScope: "ephemeral" })).rejects.toThrow("output_overflow");
      const row = f.rows().find(row => row.prompt === "r5-stdout")!;
      expect(alive(row.pid!)).toBe(false);
      expect(f.events.some(event => event.kind === "agent-text")).toBe(false);
      const schema = row.args![row.args!.indexOf("--json-schema") + 1]!;
      expect(fs.existsSync(schema)).toBe(false);
    } finally { await f.close(); }
  }, 15_000);

  it("cancellation during close still awaits the child and permits repeated disposal", async () => {
    const f = await fixture();
    const pending = f.runtime.prompt("r5-closing");
    void pending.catch(() => {});
    try {
      await vi.waitFor(() => expect(f.rows().some(row => row.signal === "SIGTERM" && row.scenario === "turn-one")).toBe(true), { timeout: 5000 });
      await f.runtime.cancel();
      await pending;
      const row = f.rows().find(row => row.prompt === "r5-closing")!;
      expect(alive(row.pid!)).toBe(false);
      await f.runtime.dispose();
      await f.runtime.dispose();
    } finally { await f.close(); }
  }, 15_000);

  it("surfaces not_reaped and refuses replacement when group signalling fails", async () => {
    const f = await fixture();
    const pending = f.runtime.prompt("r5-term");
    void pending.catch(() => {});
    let killSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await vi.waitFor(() => expect(f.events.some(event => event.kind === "agent-thought")).toBe(true), { timeout: 5000 });
      const row = f.rows().find(row => row.prompt === "r5-term")!;
      const realKill = process.kill.bind(process);
      killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -row.pid! && signal !== 0) throw Object.assign(new Error("synthetic refusal"), { code: "EPERM" });
        return realKill(pid, signal);
      });
      await f.runtime.cancel();
      await expect(pending).rejects.toThrow("not_reaped");
      expect(alive(row.pid!)).toBe(true);
      await expect(f.runtime.prompt("capability-turn-one")).rejects.toThrow("not_reaped");
      expect(f.rows().some(row => row.prompt === "capability-turn-one")).toBe(false);
    } finally { killSpy?.mockRestore(); await f.close(); }
  }, 20_000);
});
