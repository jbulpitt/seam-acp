import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { UNSETTLED_COMPLETION_MAX_AGE_MS } from "../packages/core/src/core/dispatch/attempt-store.js";
import { bindDoneDeliveryResolver, DoneRetention } from "../packages/core/src/core/dispatch/done-retention.js";
import { dispatchDirs, type DispatchResult, type DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

let dir: string;
let store: SessionStore;
let db: Database.Database;
const now = Date.parse("2026-09-22T05:00:00.000Z");
const old = new Date(now - UNSETTLED_COMPLETION_MAX_AGE_MS).toISOString();
const spec = (id: string): DispatchSpec => ({ id, target: "worker", session: "live", kind: "wake", prompt: "synthetic", createdUtc: old });
const outcome = (id: string): DispatchResult => ({ id, target: "worker", kind: "wake", status: "completed", output: "retain this output", finishedUtc: old });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-509-"));
  const file = path.join(dir, "test.db");
  store = new SessionStore(file);
  db = new Database(file);
});
afterEach(() => { vi.useRealTimers(); db.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function completed(id: string, age = old) {
  store.recordDelegation({ id, kind: "wake", targetRef: "worker", status: "running" });
  store.turnAttempts.admit(spec(id));
  const attempt = store.turnAttempts.claim(spec(id), "identity", "boot");
  store.turnAttempts.complete(attempt, outcome(id));
  db.prepare("UPDATE turn_attempts SET updated_utc=? WHERE id=?").run(age, id);
}

describe("#509 dispatch completion disposition", () => {
  // Without this, the non-provider completion writer bypasses #419's truthful suppression disposition.
  it("settles suppressed completePending atomically without transport proof", () => {
    store.turnAttempts.admit(spec("suppressed"));
    store.turnAttempts.completePending("suppressed", { ...outcome("suppressed"), suppressedOnward: true });
    expect(store.turnAttempts.get("suppressed")?.deliveryAbandonedReason).toMatch(/completion superseded before transport started/);
    expect(store.turnAttempts.isDeliveryDispositionTerminal("suppressed")).toBe(true);
    expect(store.turnAttempts.isDeliveryProven("suppressed")).toBe(false);
  });

  // Without this, duplicate finalization overwrites known delivery or an explicit prior refusal with generic uncertainty.
  it("preserves existing receipts and dispositions on repeated terminal writes", () => {
    for (const id of ["delivered", "refused", "uncertain"]) completed(id);
    store.turnAttempts.markDeliveryDone("delivered");
    store.turnAttempts.abandonDelivery("refused", "explicit operator decision");
    store.turnAttempts.markDeliveryUncertain("uncertain", "transport timed out");
    for (const id of ["delivered", "refused", "uncertain"]) {
      const before = store.turnAttempts.get(id);
      store.updateDelegationStatus(id, "completed");
      store.updateDelegationStatus(id, "completed");
      expect(store.turnAttempts.get(id)).toEqual(before);
    }
  });

  // Without this, normal finalization keeps leaking, or settlement falsely authorizes output deletion.
  it.each(["completed", "failed", "timed_out", "abandoned"] as const)("settles terminal %s without transport proof", (status) => {
    completed("job");
    store.updateDelegationStatus("job", status);
    expect(store.turnAttempts.listUnsettledCompletions()).toEqual([]);
    expect(store.turnAttempts.get("job")?.deliveryUncertainReason).toMatch(/completion effects finalized.*without a nonce-backed transport receipt/);
    expect(store.turnAttempts.isDeliveryDispositionTerminal("job")).toBe(true);
    expect(store.turnAttempts.isDeliveryProven("job")).toBe(false);
    expect(store.turnAttempts.get("job")?.outcome).toEqual(outcome("job"));
  });

  // Without this, an onward-claim failure is mislabeled finalized, hiding recovery still owed by its ledger.
  it.each(["dispatched", "running", "parked", "interrupted"] as const)("does not settle nonterminal %s", (status) => {
    completed("job");
    store.updateDelegationStatus("job", status);
    expect(store.turnAttempts.isDeliveryDispositionTerminal("job")).toBe(false);
  });

  // Without this, compact/voice callbacks that never claim a provider leak when the watcher records their result later.
  it("carries a terminal callback disposition through completePending", () => {
    store.recordDelegation({ id: "callback", kind: "compact", status: "running" });
    store.turnAttempts.admit(spec("callback"));
    store.updateDelegationStatus("callback", "completed");
    expect(store.turnAttempts.get("callback")?.state).toBe("pending");
    store.turnAttempts.completePending("callback", outcome("callback"));
    expect(store.turnAttempts.isDeliveryDispositionTerminal("callback")).toBe(true);
    expect(store.turnAttempts.isDeliveryProven("callback")).toBe(false);
  });

  // Without this, a crash/failure between ledger and disposition restores the observed leak permanently.
  it("rolls back the terminal ledger if disposition settlement fails", () => {
    completed("job");
    db.exec("CREATE TRIGGER reject_settlement BEFORE UPDATE OF delivery_uncertain_reason ON turn_attempts BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
    expect(() => store.updateDelegationStatus("job", "completed")).toThrow("synthetic disk failure");
    expect(store.getDelegation("job")?.status).toBe("running");
    expect(store.turnAttempts.isDeliveryDispositionTerminal("job")).toBe(false);
  });

  // Without this, a best-effort ledger write could override live ownership or another source's receipt protocol.
  it("leaves unknown ledgers, active owners and inbound receipts alone", () => {
    completed("unknown");
    db.prepare("DELETE FROM delegation_log WHERE id=?").run("unknown");
    completed("active");
    db.prepare("UPDATE turn_attempts SET state='active' WHERE id=?").run("active");
    completed("inbound");
    db.prepare("UPDATE turn_attempts SET source='inbound' WHERE id=?").run("inbound");
    for (const id of ["unknown", "active", "inbound"]) {
      store.updateDelegationStatus(id, "completed");
      expect(store.turnAttempts.get(id)?.deliveryUncertainReason).toBeNull();
    }
  });
});

describe("#509 aged receipts are uncertainty, never delivery", () => {
  // Without these boundaries, fresh delivery gets cut off, defects auto-settle, or a receipt becomes deletion proof.
  it("reaps only old completed/unsettled rows, idempotently, preserving every other field", () => {
    for (const id of ["old", "fresh", "proof", "abandoned", "uncertain", "defect", "pending", "active", "cancelled"]) completed(id);
    db.prepare("UPDATE turn_attempts SET updated_utc=? WHERE id='fresh'").run(new Date(now - UNSETTLED_COMPLETION_MAX_AGE_MS + 1).toISOString());
    store.turnAttempts.markDeliveryDone("proof");
    store.turnAttempts.abandonDelivery("abandoned", "operator decision", old);
    store.turnAttempts.markDeliveryUncertain("uncertain", "prior uncertainty", old);
    for (const state of ["pending", "active", "cancelled"]) db.prepare("UPDATE turn_attempts SET state=? WHERE id=?").run(state, state);
    db.prepare("UPDATE turn_attempts SET state='suspended', stalled_utc=?, stalled_reason='defect: cannot resume' WHERE id='defect'").run(old);
    const before = db.prepare("SELECT * FROM turn_attempts ORDER BY id").all() as Record<string, unknown>[];
    expect(store.turnAttempts.reapUnsettledCompletions(now)).toBe(1);
    expect(store.turnAttempts.reapUnsettledCompletions(now)).toBe(0);
    const after = db.prepare("SELECT * FROM turn_attempts ORDER BY id").all() as Record<string, unknown>[];
    expect(after).toEqual(before.map(row => row.id === "old" ? { ...row,
      delivery_uncertain_reason: "completion disposition timed out after one hour without delivery proof; output retained",
      updated_utc: new Date(now).toISOString(),
    } : row));
    expect(store.turnAttempts.isDeliveryDispositionTerminal("old")).toBe(true);
    expect(store.turnAttempts.isDeliveryProven("old")).toBe(false);
    expect(store.getDelegation("old")?.status).toBe("running");
    expect(store.turnAttempts.listStalled().map(a => a.id)).toEqual(["defect"]);
    // A late real acknowledgement is still allowed; age never cancels transport.
    store.turnAttempts.markDeliveryDone("old");
    expect(store.turnAttempts.isDeliveryProven("old")).toBe(true);
  });

  // Without production maintenance wiring the reaper exists only in tests; without proof separation it deletes retained output.
  it("runs at startup and periodically, retains unproven output, and stops cleanly", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    completed("old");
    // Simulate the historical terminal ledger without invoking the now-fixed writer.
    db.prepare("UPDATE delegation_log SET status='completed' WHERE id='old'").run();
    fs.mkdirSync(dispatchDirs(dir).done, { recursive: true });
    const artifact = path.join(dispatchDirs(dir).done, "old.json");
    fs.writeFileSync(artifact, JSON.stringify(outcome("old")));
    const reap = vi.fn(() => store.turnAttempts.reapUnsettledCompletions(now));
    const retention = new DoneRetention(bindDoneDeliveryResolver({
      dataDir: dir, logger: pino({ level: "silent" }) as unknown as Logger,
      getDelegation: id => store.getDelegation(id),
      getReportBackByCorrelation: id => store.getReportBackByCorrelation(id),
      isAttemptDeliveryProven: id => store.turnAttempts.isDeliveryProven(id),
      reapUnsettledCompletions: reap,
    }), 1000);
    try {
      retention.start();
      await retention.drain();
      expect(reap).toHaveBeenCalledTimes(1);
      expect(store.turnAttempts.isDeliveryDispositionTerminal("old")).toBe(true);
      expect(fs.readFileSync(artifact, "utf8")).toBe(JSON.stringify(outcome("old")));
      vi.advanceTimersByTime(1000);
      await retention.drain();
      expect(reap).toHaveBeenCalledTimes(2);
      retention.stop();
      vi.advanceTimersByTime(2000);
      expect(reap).toHaveBeenCalledTimes(2);
    } finally { retention.stop(); await retention.drain(); }
  });
});
