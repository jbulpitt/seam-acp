import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { describe, it, expect, vi } from "vitest";
import { makeAgyProfile } from "@seam/adapters";
import { AgentRuntime, type AgentEvent } from "../packages/core/src/agents/agent-runtime.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { createManagedAgyFixture } from "./helpers/agy-runtime-fixture.js";
import { ModelCatalogService } from "../packages/core/src/core/model-catalog/service.js";
import { ModelCatalogStore } from "../packages/core/src/core/model-catalog/store.js";

const fixtures = fileURLToPath(new URL("./fixtures/agy-native-capabilities/", import.meta.url));
const logger = pino({ level: "silent" }) as unknown as Logger;
type Row = { scenario?: string; pid?: number; prompt?: string; args?: string[]; home?: string; signal?: string; mcpConfig?: unknown };
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function fixture(sandbox = false, timeoutSeconds = 10) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-agy-r5-"));
  const log = path.join(root, "invocations");
  const managed = createManagedAgyFixture({
    source: path.join(fixtures, "fake-native-agy.mjs"), version: "agy fixture 1.1.28", cwd: root,
    approvedEnvironment: { SEAM_AGY_CAPABILITY_FIXTURE_DIR: fixtures, SEAM_AGY_CAPABILITY_INVOCATIONS: log },
  });
  const runtime = new AgentRuntime({ logger, profile: makeAgyProfile({
    runtime: managed.runtime, dataDir: root, defaultModel: "Fixture Native Model",
    printTimeoutSeconds: timeoutSeconds, persistModelSelection: false, exposeGlobalStaging: false, sandbox,
    mcpServers: [{ type: "http", name: "must-not-inherit", url: "http://127.0.0.1:9", headers: [] }],
  }) });
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
  it.each([
    ["r5-exit", "exited_early"],
    ["r5-stderr", "output_overflow"],
    ["r5-malformed", "protocol_error"],
    ["r5-oversized-frame", "output_overflow"],
    ["r5-no-ls", "timeout"],
  ])("bounds %s and keeps diagnostics out of the ACP consumer", async (prompt, code) => {
    const f = await fixture(false, prompt === "r5-no-ls" ? 2 : 10);
    try {
      const start = Date.now();
      const error = await f.runtime.prompt(prompt).then(() => "unexpected success", error => String(error));
      expect(error).toContain(code);
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

  it("sandbox launch supplies only its cwd, an empty private MCP config, and leaves permissions unchanged", async () => {
    const f = await fixture(true);
    try {
      await f.runtime.prompt("capability-turn-one");
      const row = f.rows().find(row => row.prompt === "capability-turn-one")!;
      expect(row.args).toContain("--sandbox");
      expect(row.args).toContain("--dangerously-skip-permissions");
      const dirs = row.args!.flatMap((arg, i) => arg === "--add-dir" ? [row.args![i + 1]] : []);
      expect(dirs).toEqual([f.root]);
      expect(row.mcpConfig).toEqual({ mcpServers: {} });
      expect(fs.statSync(row.home!).mode & 0o777).toBe(0o700);
    } finally { await f.close(); }
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
      await expect(f.runtime.prompt("r5-stdout", undefined, { jsonSchema: { type: "object" } })).rejects.toThrow("output_overflow");
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
