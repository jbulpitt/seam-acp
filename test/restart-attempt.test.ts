import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { processOwner, provenDead } from "../packages/core/src/core/dispatch/process-owner.js";
import { executionIdentity } from "../packages/core/src/core/dispatch/execution-identity.js";
import { simulateRetiredOwnerProcess } from "./restart-process-fixture.js";

const dirs: string[] = [];
const stores: SessionStore[] = [];
function database() {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-250-"));
  dirs.push(dir);
  const file = path.join(dir, "test.db");
  const open = () => { const s = new SessionStore(file); stores.push(s); return s; };
  return { open, file };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const spec = { id: "job", target: "worker", session: "live" as const,
  kind: "handoff" as const, prompt: "original task", returnTo: "origin",
  correlationId: "logical", createdUtc: "2026-09-09T00:00:00Z" };
const identity = executionIdentity({ agent: "synthetic-provider", location: "local", session: "live",
  model: "synthetic-model", effort: "", cwd: "/synthetic", config: {} });

describe("#250 durable attempt winner", () => {
  it.each(["missing", "null", "{}", "invalid-json", "invalid-pid", "missing-start"])(
    "retains suspended ownership when the prior owner proof is %s", proof => {
      const db = database();
      const attempts = db.open().turnAttempts;
      attempts.registerOwner("boot-A");
      attempts.registerOwner("boot-B");
      const original = attempts.claim(spec, identity, "boot-A");
      attempts.suspendBoot("boot-A");
      const raw = new Database(db.file);
      try {
        if (proof === "missing") raw.prepare("DELETE FROM turn_attempt_owners WHERE id=?").run("boot-A");
        else {
          const p = processOwner()!;
          const value = proof === "invalid-pid" ? JSON.stringify({ ...p, pid: -1 })
            : proof === "missing-start" ? JSON.stringify({ host: p.host, boot: p.boot, pid: p.pid }) : proof;
          raw.prepare("UPDATE turn_attempt_owners SET process_json=? WHERE id=?").run(value, "boot-A");
        }
      } finally { raw.close(); }
      for (const boot of ["boot-B", "boot-A"]) {
        expect(() => attempts.claim(spec, identity, boot)).toThrow("dispatch attempt no longer owns execution");
        expect(attempts.get(spec.id)).toMatchObject({ state: "suspended", generation: original.generation, ownerBoot: "boot-A" });
      }
    },
  );
  it("suspends before teardown, rejects late completion, continues the same binding after reopen", () => {
    simulateRetiredOwnerProcess();
    const db = database();
    const first = db.open().turnAttempts;
    first.registerOwner("boot-A");
    const a = first.claim(spec, identity, "boot-A");
    first.bind(a, "recorded-acp");
    first.startPrompt(a);
    expect(first.suspendBoot("boot-A")).toBe(1);
    expect(first.complete(a, { id: "job", target: "worker", status: "failed", error: "ACP closed", finishedUtc: spec.createdUtc })).toBe(false);
    const second = db.open().turnAttempts;
    const b = second.claim(spec, identity, "boot-B");
    expect(b.generation).toBe(a.generation + 1);
    expect(b.acpSessionId).toBe("recorded-acp");
    expect(b.promptStarted).toBe(true);
    expect(second.get("job")?.spec).toEqual(spec);
    expect(first.isCurrent(a)).toBe(false);
    expect(second.complete(b, { id: "job", target: "worker", status: "completed", output: "final", finishedUtc: spec.createdUtc })).toBe(true);
    expect(second.suspendBoot("boot-B")).toBe(0);
  });
  it("completion wins durably before delivery and cannot be rerun", () => {
    const db = database();
    const first = db.open().turnAttempts;
    const a = first.claim(spec, identity, "boot-A");
    first.bind(a, "acp"); first.startPrompt(a);
    const output = { id: "job", target: "worker", status: "completed" as const, output: "durable answer", returnTo: "origin", finishedUtc: spec.createdUtc };
    expect(first.complete(a, output)).toBe(true);
    expect(first.suspendBoot("boot-A")).toBe(0);
    const second = db.open().turnAttempts;
    expect(second.get("job")?.outcome).toEqual(output);
    expect(() => second.claim(spec, identity, "boot-B")).toThrow();
  });
  it("does not steal a living owner or silently change execution identity", () => {
    const attempts = database().open().turnAttempts;
    const a = attempts.claim(spec, identity, "boot-A");
    expect(() => attempts.claim(spec, identity, "boot-B")).toThrow();
    attempts.suspendBoot("boot-A");
    expect(() => attempts.claim(spec, "different-account", "boot-B")).toThrow();
    expect(attempts.get(a.id)?.state).toBe("suspended");
  });
  it("intentional cancellation beats restart and cannot resurrect or deliver", () => {
    const attempts = database().open().turnAttempts;
    const a = attempts.claim(spec, identity, "boot-A");
    expect(attempts.cancel(spec.id)).toBe(true);
    expect(attempts.suspendBoot("boot-A")).toBe(0);
    expect(attempts.complete(a, { id: "job", target: "worker", status: "completed", finishedUtc: spec.createdUtc })).toBe(false);
    expect(() => attempts.claim(spec, identity, "boot-B")).toThrow();
  });
  it("retains unstarted original work and fails closed on missing ACP", () => {
    simulateRetiredOwnerProcess();
    const attempts = database().open().turnAttempts;
    attempts.registerOwner("boot-A");
    const a = attempts.claim(spec, identity, "boot-A");
    expect(() => attempts.startPrompt(a)).toThrow();
    attempts.suspendBoot("boot-A");
    const b = attempts.claim(spec, identity, "boot-B");
    expect(b.promptStarted).toBe(false);
    expect(b.acpSessionId).toBeNull();
  });

  it("does not treat a reopened database as proof that its process owner died", () => {
    const db = database();
    const first = db.open().turnAttempts;
    first.registerOwner("boot-A");
    first.claim(spec, identity, "boot-A");
    first.suspendBoot("boot-A");
    expect(() => db.open().turnAttempts.claim(spec, identity, "boot-B")).toThrow();
  });

  it("allows registered same-boot recovery but still refuses a living runtime", () => {
    const attempts = database().open().turnAttempts;
    attempts.registerOwner("boot-A");
    attempts.claim(spec, identity, "boot-A");
    attempts.suspendBoot("boot-A");
    const recovered = attempts.claim(spec, identity, "boot-A");
    expect(recovered.generation).toBe(2);
    attempts.bindRuntime(recovered, process.pid, "synthetic-provider");
    attempts.suspendBoot("boot-A");
    expect(() => attempts.claim(spec, identity, "boot-A")).toThrow("dispatch attempt no longer owns execution");
    expect(attempts.get(spec.id)?.generation).toBe(2);
  });

  it("skips malformed owner proof at startup without retiring its active work", () => {
    const db = database();
    const attempts = db.open().turnAttempts;
    attempts.registerOwner("boot-A");
    attempts.claim(spec, identity, "boot-A");
    const raw = new Database(db.file);
    try { raw.prepare("UPDATE turn_attempt_owners SET process_json=? WHERE id=?").run("invalid-json", "boot-A"); }
    finally { raw.close(); }
    expect(attempts.retireDeadOwners()).toBe(0);
    expect(attempts.get(spec.id)?.state).toBe("active");
  });

  it("proves PID reuse/death without signals, but never steals a live or unknown-host owner", () => {
    const owner = processOwner();
    expect(owner).not.toBeNull();
    expect(provenDead(owner!)).toBe(false);
    expect(provenDead({ ...owner!, start: "0" })).toBe(true);
    expect(provenDead({ ...owner!, host: "different-synthetic-host" })).toBe(false);
  });

  it("rejects provider build identity drift before a resumed prompt", () => {
    simulateRetiredOwnerProcess();
    const attempts = database().open().turnAttempts;
    attempts.registerOwner("boot-A");
    const a = attempts.claim(spec, identity, "boot-A");
    attempts.bindRuntime(a, undefined, "provider-v1");
    attempts.bind(a, "acp"); attempts.startPrompt(a); attempts.suspendBoot("boot-A");
    const b = attempts.claim(spec, identity, "boot-B");
    expect(() => attempts.bindRuntime(b, undefined, "provider-v2")).toThrow();
    expect(attempts.get(spec.id)?.providerIdentity).toBe("provider-v1");
  });
});
