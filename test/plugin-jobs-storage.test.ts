import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { PluginStorage } from "../packages/core/src/plugins/storage.js";
import type { Plugin } from "../packages/core/src/plugins/types.js";
import type { JobContribution } from "../packages/core/src/plugins/job-registry.js";
import { drainStoreWritingManagers } from "../packages/core/src/lib/shutdown-managers.js";

const logger = pino({ level: "silent" });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function directory() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-storage-")); dirs.push(dir); return dir; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function job(overrides: Partial<JobContribution> = {}): JobContribution {
  return { name: "cache", phase: "after-admission", intervalMs: 500, start: vi.fn(), stop: vi.fn(), drain: async () => {}, ...overrides };
}
function plugin(id: string, jobs: JobContribution[]): Plugin {
  return { id, builtin: true, apiVersion: 1, contributions: {
    jobs, fences: [{ tag: id, instruction: id, handle: async () => {} }],
    mcp: [{ descriptor: { name: id, description: id, inputSchema: {} }, access: "read-only", authorization: "user", instruction: id, available: () => true, handle: async () => ({ content: [] }) }],
    components: [{ namespace: `${id}:`, types: ["button"], lifetime: "persistent", access: "read-only", authorization: "user", handle: async () => {} }],
  } };
}
describe("maintenance job lifecycle", () => {
  it("waits for admission and cancels/drains under the manager barrier", async () => {
    const host = new PluginHost(logger);
    const admission = deferred(); const flight = deferred();
    let signal!: AbortSignal;
    const maintenance = job({ start: vi.fn(context => { signal = context.signal; expect(context.intervalMs).toBe(500); }), drain: () => flight.promise });
    await host.loadBuiltins([{ id: "cache", load: async () => plugin("cache", [maintenance]) }]);
    const starting = host.jobs.startAfterAdmission(admission.promise);
    await Promise.resolve(); expect(maintenance.start).not.toHaveBeenCalled();
    admission.resolve(); await starting;
    expect(signal.aborted).toBe(false);
    host.jobs.stop(); expect(signal.aborted).toBe(true); expect(maintenance.stop).toHaveBeenCalledOnce();
    const idle = { drain: async () => {} };
    let drained = false;
    const drain = drainStoreWritingManagers({ scheduled: idle, wake: idle, watch: idle, parked: idle, plugins: host.jobs }, async (_label, work) => { await work(); return true; }).then(result => { drained = true; return result; });
    await Promise.resolve(); expect(drained).toBe(false);
    flight.resolve(); expect((await drain)[0]!.drained).toBe(true);
    await host.dispose();
  });

  it("does not start a job if shutdown wins the admission race", async () => {
    const host = new PluginHost(logger); const maintenance = job(); const admission = deferred();
    await host.loadBuiltins([{ id: "cache", load: async () => plugin("cache", [maintenance]) }]);
    const start = host.jobs.startAfterAdmission(admission.promise);
    host.jobs.stop(); admission.resolve(); await start;
    expect(maintenance.start).not.toHaveBeenCalled(); await host.dispose();
  });

  it("isolates a throwing job and unpublishes only its plugin", async () => {
    const host = new PluginHost(logger); const healthy = job();
    const broken = plugin("broken", [job({ start: () => { throw new Error("poller unavailable"); } })]);
    broken.dispose = vi.fn();
    await host.loadBuiltins([{ id: "broken", load: async () => broken }, { id: "healthy", load: async () => plugin("healthy", [healthy]) }]);
    await host.jobs.startAfterAdmission(Promise.resolve());
    expect(healthy.start).toHaveBeenCalledOnce(); expect(broken.dispose).toHaveBeenCalledOnce();
    expect(host.fences.instructions).toEqual(["healthy"]);
    expect(host.mcp.list({ threadId: "thread" }).map(tool => tool.descriptor.name)).toEqual(["healthy"]);
    expect(host.components.get("broken:action", "button")).toBeUndefined();
    expect(host.components.get("healthy:action", "button")).toBeDefined();
    await host.dispose();
  });
});

describe("namespace-bound storage", () => {
  it("assigns separate paths and rejects another namespace or traversal", () => {
    const root = directory(); const a = new PluginStorage(root, "alpha"); const b = new PluginStorage(root, "beta");
    expect(a.path("cache.sqlite")).toBe(path.join(root, "plugins/alpha/cache.sqlite"));
    expect(b.path("cache.sqlite")).not.toBe(a.path("cache.sqlite"));
    for (const name of ["../beta/cache.sqlite", "/tmp/cache.sqlite", "beta/cache.sqlite", "..", "a\\b"]) expect(() => a.path(name)).toThrow("invalid plugin storage name");
    expect(() => new PluginStorage(root, "../beta")).toThrow("invalid storage namespace");
  });

  it("retains explicitly assigned legacy files without changing their bytes", () => {
    const root = directory(); const file = path.join(root, "service-status.sqlite"); fs.writeFileSync(file, "existing history");
    const storage = new PluginStorage(root, "service-status", { "service-status.sqlite": file });
    expect(storage.path("service-status.sqlite")).toBe(file); expect(fs.readFileSync(file, "utf8")).toBe("existing history");
    expect(storage.path("other.sqlite")).toBe(path.join(root, "plugins/service-status/other.sqlite"));
  });
});
