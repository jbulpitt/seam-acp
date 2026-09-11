import type Database from "better-sqlite3";
import type { DispatchResult, DispatchSpec } from "./types.js";
import { compareExecutionIdentity } from "./execution-identity.js";
import { deliveryNonce, type DurableDeliveryPayload } from "./delivery-proof.js";
import { isProcessOwner, processOwner, provenDead, type ProcessOwner } from "./process-owner.js";

function recordedOwner(raw: string | undefined): ProcessOwner | null {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    return isProcessOwner(value) ? value : null;
  } catch { return null; }
}

export const inboundAttemptId = (messageId: string): string => `inbound-${messageId}`;

/** A logical dispatch has many process attempts, but only one terminal winner.
 * This is ownership metadata for the existing queue, not a second queue/outbox.
 * Specs/outcomes are private: never log this row or expose it in diagnostics.
 */
export interface TurnAttempt {
  id: string;
  generation: number;
  ownerBoot: string;
  state: "active" | "suspended" | "completed" | "cancelled";
  identity: string;
  spec: DispatchSpec;
  acpSessionId: string | null;
  promptStarted: boolean;
  outcome: DispatchResult | null;
  runtimeOwner: ProcessOwner | null;
  providerIdentity: string | null;
  source: "dispatch" | "inbound" | "schedule";
  deliveryDone: boolean;
  deliveryProtocol: boolean;
  deliveryNonce: string | null;
  deliveryChannel: string | null;
  deliveryPayload: DurableDeliveryPayload | null;
  deliveryStartedUtc: string | null;
  deliveryAbandonedReason: string | null;
  deliveryUncertainReason: string | null;
  updatedUtc: string;
  /** Durable quarantine metadata for a recovery attempt that was retained
   * after startup readiness. The execution remains suspended and can only be
   * resumed/abandoned through the guarded operator workflow. */
  stalledUtc: string | null;
  stalledReason: string | null;
  stallNoticeUtc: string | null;
}

/** Not a worker failure. Callers must retain the logical job and emit nothing
 * onward. Also fences obsolete callbacks after a replacement/cancel winner. */
export class DispatchSuspendedError extends Error {
  /** `reason` names WHY in operator terms — e.g. "thread switched from codex to
   * claude". Without it a refusal is two opaque digests and hours of debugging
   * (#302); the message stays stable for existing callers that match on it. */
  constructor(readonly dispatchId: string, readonly reason?: string) {
    super("dispatch attempt no longer owns execution");
    this.name = "DispatchSuspendedError";
  }
}

export class TurnAttemptStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS turn_attempts (
      id TEXT PRIMARY KEY, generation INTEGER NOT NULL, owner_boot TEXT NOT NULL,
      state TEXT NOT NULL, identity TEXT NOT NULL, spec_json TEXT NOT NULL,
      acp_session_id TEXT, prompt_started INTEGER NOT NULL DEFAULT 0,
      outcome_json TEXT, runtime_json TEXT, provider_identity TEXT, updated_utc TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_turn_attempt_owner ON turn_attempts(owner_boot, state);
    -- #302: attempts are many-to-one with sessions (two of the five stalls on
    -- 2026-09-10 shared 624a55a4), so "which work belongs to this session" was
    -- a table scan.
    CREATE INDEX IF NOT EXISTS idx_turn_attempt_acp_session ON turn_attempts(acp_session_id);
    CREATE TABLE IF NOT EXISTS turn_attempt_owners (id TEXT PRIMARY KEY, process_json TEXT NOT NULL);`);
    for (const ddl of [
      "ALTER TABLE turn_attempts ADD COLUMN source TEXT NOT NULL DEFAULT 'dispatch'",
      "ALTER TABLE turn_attempts ADD COLUMN delivery_done INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE turn_attempts ADD COLUMN delivery_protocol INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE turn_attempts ADD COLUMN delivery_nonce TEXT",
      "ALTER TABLE turn_attempts ADD COLUMN delivery_channel TEXT",
      "ALTER TABLE turn_attempts ADD COLUMN delivery_payload_json TEXT",
      "ALTER TABLE turn_attempts ADD COLUMN delivery_started_utc TEXT",
      "ALTER TABLE turn_attempts ADD COLUMN delivery_abandoned_reason TEXT",
      "ALTER TABLE turn_attempts ADD COLUMN delivery_uncertain_reason TEXT",
      "ALTER TABLE turn_attempts ADD COLUMN stalled_utc TEXT",
      "ALTER TABLE turn_attempts ADD COLUMN stalled_reason TEXT",
      "ALTER TABLE turn_attempts ADD COLUMN stall_notice_utc TEXT",
    ]) {
      try { db.exec(ddl); } catch (err) {
        if (!(err instanceof Error) || !err.message.includes("duplicate column name")) throw err;
      }
    }
  }

  registerOwner(id: string): void {
    this.db.prepare("INSERT OR IGNORE INTO turn_attempt_owners VALUES (?,?)")
      .run(id, JSON.stringify(processOwner()));
  }

  retireDeadOwners(): number {
    const owners = this.db.prepare("SELECT id,process_json FROM turn_attempt_owners").all() as { id: string; process_json: string }[];
    let n = 0;
    for (const owner of owners) {
      const p = recordedOwner(owner.process_json);
      if (p && provenDead(p)) n += this.suspendBoot(owner.id);
    }
    return n;
  }

  get(id: string): TurnAttempt | null {
    const row = this.db.prepare("SELECT * FROM turn_attempts WHERE id = ?").get(id) as
      { id: string; generation: number; owner_boot: string; state: TurnAttempt["state"];
        identity: string; spec_json: string; acp_session_id: string | null;
        prompt_started: number; outcome_json: string | null; runtime_json: string | null; provider_identity: string | null;
        source: TurnAttempt["source"]; delivery_done: number; delivery_protocol: number; updated_utc: string;
        delivery_nonce: string | null; delivery_channel: string | null;
        delivery_payload_json: string | null; delivery_started_utc: string | null;
        delivery_abandoned_reason: string | null;
        delivery_uncertain_reason: string | null;
        stalled_utc: string | null; stalled_reason: string | null; stall_notice_utc: string | null } | undefined;
    return row ? {
      id: row.id, generation: row.generation, ownerBoot: row.owner_boot,
      state: row.state, identity: row.identity, spec: JSON.parse(row.spec_json),
      acpSessionId: row.acp_session_id, promptStarted: row.prompt_started === 1,
      outcome: row.outcome_json ? JSON.parse(row.outcome_json) : null,
      runtimeOwner: row.runtime_json ? JSON.parse(row.runtime_json) : null,
      providerIdentity: row.provider_identity,
      source: row.source, deliveryDone: row.delivery_done === 1,
      deliveryProtocol: row.delivery_protocol === 1,
      deliveryNonce: row.delivery_nonce,
      deliveryChannel: row.delivery_channel,
      deliveryPayload: row.delivery_payload_json ? JSON.parse(row.delivery_payload_json) : null,
      deliveryStartedUtc: row.delivery_started_utc,
      deliveryAbandonedReason: row.delivery_abandoned_reason,
      deliveryUncertainReason: row.delivery_uncertain_reason,
      updatedUtc: row.updated_utc,
      stalledUtc: row.stalled_utc,
      stalledReason: row.stalled_reason,
      stallNoticeUtc: row.stall_notice_utc,
    } : null;
  }

  claim(spec: DispatchSpec, identity: string, ownerBoot: string, source: TurnAttempt["source"] = "dispatch"): TurnAttempt {
    return this.db.transaction(() => {
      const old = this.get(spec.id);
      if (old) {
        if (old.state !== "suspended" || old.source !== source) throw new DispatchSuspendedError(spec.id);
        // Compare the recorded selection field by field so a refusal can name
        // the field. The previous opaque digest also folded in rotating
        // credentials and provider env values, so an unrelated token refresh
        // stranded the attempt permanently (#302).
        const drift = compareExecutionIdentity(old.identity, identity, {
          promptStarted: old.promptStarted,
          acpSessionId: old.acpSessionId,
        });
        if (!drift.match) throw new DispatchSuspendedError(spec.id, drift.reason);
        // `startPrompt` only sets prompt_started when a session id is already
        // recorded, so this pairing cannot occur. If it ever does we recorded
        // that we prompted without recording where the work went, and replaying
        // could duplicate work the model already did — refuse loudly instead.
        if (old.promptStarted && !old.acpSessionId) {
          throw new DispatchSuspendedError(spec.id, "attempt recorded a started prompt with no session id");
        }
        const owner = this.db.prepare("SELECT process_json FROM turn_attempt_owners WHERE id=?")
          .get(old.ownerBoot) as { process_json: string } | undefined;
        // Suspension alone is not proof of death. Missing/corrupt registration
        // must retain ownership, including same-boot operator recovery.
        const p = recordedOwner(owner?.process_json);
        if (!p || (old.ownerBoot !== ownerBoot && !provenDead(p))) throw new DispatchSuspendedError(spec.id);
        if (old.runtimeOwner && !provenDead(old.runtimeOwner)) throw new DispatchSuspendedError(spec.id);
        this.db.prepare(`UPDATE turn_attempts SET generation=generation+1,
          owner_boot=?, state='active', stalled_utc=NULL, stalled_reason=NULL,
          stall_notice_utc=NULL, updated_utc=? WHERE id=? AND state='suspended'`)
          .run(ownerBoot, new Date().toISOString(), spec.id);
      } else {
        this.db.prepare(`INSERT INTO turn_attempts
          (id,generation,owner_boot,state,identity,spec_json,updated_utc,source,delivery_protocol)
          VALUES (?,1,?,'active',?,?,?,?,1)`)
          .run(spec.id, ownerBoot, identity, JSON.stringify(spec), new Date().toISOString(), source);
      }
      return this.get(spec.id)!;
    }).immediate();
  }

  isCurrent(a: TurnAttempt): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM turn_attempts
      WHERE id=? AND generation=? AND owner_boot=? AND state='active'`)
      .get(a.id, a.generation, a.ownerBoot));
  }

  bindRuntime(a: TurnAttempt, pid: number | undefined, providerIdentity?: string): void {
    this.assertCurrent(a);
    if (a.providerIdentity && a.providerIdentity !== providerIdentity) throw new DispatchSuspendedError(a.id);
    const owner = pid ? processOwner(pid) : null;
    this.db.prepare("UPDATE turn_attempts SET runtime_json=?, provider_identity=? WHERE id=? AND generation=? AND owner_boot=? AND state='active'")
      .run(owner ? JSON.stringify(owner) : null, providerIdentity ?? null, a.id, a.generation, a.ownerBoot);
  }

  assertCurrent(a: TurnAttempt): void {
    if (!this.isCurrent(a)) throw new DispatchSuspendedError(a.id);
  }

  bind(a: TurnAttempt, sessionId: string): void {
    if (!sessionId) throw new Error("cannot bind an empty ACP session");
    const n = this.db.prepare(`UPDATE turn_attempts SET acp_session_id=?, updated_utc=?
      WHERE id=? AND generation=? AND owner_boot=? AND state='active'
      AND (acp_session_id IS NULL OR acp_session_id=?)`)
      .run(sessionId, new Date().toISOString(), a.id, a.generation, a.ownerBoot, sessionId).changes;
    if (n !== 1) throw new DispatchSuspendedError(a.id);
    a.acpSessionId = sessionId;
  }

  /** Written immediately BEFORE prompt submission. A crash in that tiny gap is
   * ambiguous; continuation is safe, replay of the original task is not. */
  startPrompt(a: TurnAttempt): void {
    const n = this.db.prepare(`UPDATE turn_attempts SET prompt_started=1, updated_utc=?
      WHERE id=? AND generation=? AND owner_boot=? AND state='active' AND acp_session_id IS NOT NULL`)
      .run(new Date().toISOString(), a.id, a.generation, a.ownerBoot).changes;
    if (n !== 1) throw new DispatchSuspendedError(a.id);
    a.promptStarted = true;
  }

  complete(a: TurnAttempt, outcome: DispatchResult): boolean {
    return this.db.prepare(`UPDATE turn_attempts SET state='completed', outcome_json=?, updated_utc=?
      WHERE id=? AND generation=? AND owner_boot=? AND state='active'`)
      .run(JSON.stringify(outcome), new Date().toISOString(), a.id, a.generation, a.ownerBoot).changes === 1;
  }

  /** Record the exact terminal create-message before it can reach Discord. */
  prepareDelivery(
    id: string,
    channel: string,
    payload: DurableDeliveryPayload,
    now = new Date().toISOString()
  ): { nonce: string; startedUtc: string } {
    const current = this.get(id);
    // Protects against attaching delivery proof to unfinished/replaced work;
    // deleting this check lets an obsolete attempt acknowledge a winner.
    if (!current || current.state !== "completed") {
      throw new DispatchSuspendedError(id);
    }
    const nonce = current.deliveryNonce ?? deliveryNonce(id);
    const serialized = JSON.stringify(payload);
    // Protects against replaying a different body under an already-used nonce;
    // deleting this check lets Discord dedup hide payload substitution.
    if (
      current.deliveryNonce &&
      (current.deliveryChannel !== channel || JSON.stringify(current.deliveryPayload) !== serialized)
    ) {
      throw new Error(`delivery receipt mismatch for ${id}`);
    }
    const startedUtc = current.deliveryStartedUtc ?? now;
    this.db.prepare(`UPDATE turn_attempts SET delivery_nonce=?, delivery_channel=?,
      delivery_payload_json=?, delivery_started_utc=?, delivery_abandoned_reason=NULL,
      delivery_uncertain_reason=NULL,
      updated_utc=? WHERE id=? AND state='completed' AND delivery_done=0`)
      .run(nonce, channel, serialized, startedUtc, now, id);
    return { nonce, startedUtc };
  }

  /** Acknowledges captured output after Discord evidence or enforced replay. */
  markDeliveryDone(id: string): void {
    this.db.prepare(`UPDATE turn_attempts SET delivery_done=1,
      delivery_abandoned_reason=NULL, delivery_uncertain_reason=NULL,
      updated_utc=? WHERE id=? AND state='completed'`)
      .run(new Date().toISOString(), id);
  }

  /** Terminal refusal for a completed payload whose delivery cannot be proven safely. */
  abandonDelivery(id: string, reason: string, now = new Date().toISOString()): boolean {
    return this.db.prepare(`UPDATE turn_attempts SET delivery_abandoned_reason=?,
      delivery_uncertain_reason=NULL, updated_utc=?
      WHERE id=? AND state='completed' AND delivery_done=0 AND delivery_abandoned_reason IS NULL`)
      .run(reason, now, id).changes === 1;
  }

  /** Retain bounded/ambiguous output without calling uncertainty delivery. */
  markDeliveryUncertain(id: string, reason: string, now = new Date().toISOString()): boolean {
    return this.db.prepare(`UPDATE turn_attempts SET delivery_uncertain_reason=?, updated_utc=?
      WHERE id=? AND state='completed' AND delivery_done=0
        AND delivery_abandoned_reason IS NULL AND delivery_uncertain_reason IS NULL`)
      .run(reason, now, id).changes === 1;
  }

  /** Positive transport evidence only; terminal refusal is deliberately false. */
  isDeliveryProven(id: string): boolean {
    const row = this.db.prepare(`SELECT state,delivery_done
      FROM turn_attempts WHERE id=?`).get(id) as
      { state: TurnAttempt["state"]; delivery_done: number } | undefined;
    return Boolean(row?.state === "completed" && row.delivery_done === 1);
  }

  /** Lifecycle disposition only. Never use this as done-artifact deletion proof. */
  isDeliveryDispositionTerminal(id: string): boolean {
    const row = this.get(id);
    return Boolean(
      row &&
      (row.state === "cancelled" ||
        (row.state === "completed" &&
          (row.deliveryDone || row.deliveryAbandonedReason || row.deliveryUncertainReason)))
    );
  }

  /** Quarantine a retained recovery without terminalizing or replaying it.
   * Returns true only for the first durable transition, so the requester gets
   * one notice even if the observer is invoked more than once. */
  markStalled(id: string, reason: string, now = new Date().toISOString()): boolean {
    return this.db.prepare(`UPDATE turn_attempts
      SET state='suspended', stalled_utc=?, stalled_reason=?, updated_utc=?
      WHERE id=? AND state IN ('active','suspended') AND stalled_utc IS NULL`)
      .run(now, reason, now, id).changes === 1;
  }

  markStallNoticeDelivered(id: string, now = new Date().toISOString()): boolean {
    return this.db.prepare(`UPDATE turn_attempts SET stall_notice_utc=?, updated_utc=?
      WHERE id=? AND state='suspended' AND stalled_utc IS NOT NULL AND stall_notice_utc IS NULL`)
      .run(now, now, id).changes === 1;
  }

  listStalled(target?: string): TurnAttempt[] {
    const rows = target
      ? this.db.prepare(`SELECT id FROM turn_attempts
          WHERE state='suspended' AND stalled_utc IS NOT NULL
          AND json_extract(spec_json, '$.target')=? ORDER BY stalled_utc,id`).all(target)
      : this.db.prepare(`SELECT id FROM turn_attempts
          WHERE state='suspended' AND stalled_utc IS NOT NULL ORDER BY stalled_utc,id`).all();
    return (rows as { id: string }[]).map(({ id }) => this.get(id)!);
  }

  /** Synchronous cutoff, before any transport/runtime teardown can reject. */
  suspendBoot(ownerBoot: string): number {
    return this.db.prepare(`UPDATE turn_attempts SET state='suspended', updated_utc=?
      WHERE owner_boot=? AND state='active'`).run(new Date().toISOString(), ownerBoot).changes;
  }

  /** Operator queue recovery fences one local attempt before retiring its runtime. */
  suspend(id: string, ownerBoot: string): boolean {
    return this.db.prepare("UPDATE turn_attempts SET state='suspended', updated_utc=? WHERE id=? AND owner_boot=? AND state='active'")
      .run(new Date().toISOString(), id, ownerBoot).changes === 1;
  }

  /** Explicit cancellation may win against suspension, never against captured completion. */
  cancel(id: string): boolean {
    return this.db.transaction(() => {
      const a = this.get(id);
      if (!a || (a.state !== "active" && a.state !== "suspended")) return false;
      const outcome: DispatchResult = {
        id, target: a.spec.target, status: "failed", workerStatus: "failed",
        error: "cancelled by operator", suppressedOnward: true,
        kind: a.spec.kind, finishedUtc: new Date().toISOString(),
      };
      return this.db.prepare(`UPDATE turn_attempts SET state='cancelled', outcome_json=?, updated_utc=?
        WHERE id=? AND state IN ('active','suspended')`)
        .run(JSON.stringify(outcome), outcome.finishedUtc, id).changes === 1;
    }).immediate();
  }

  list(state: TurnAttempt["state"]): TurnAttempt[] {
    return (this.db.prepare("SELECT id FROM turn_attempts WHERE state=? ORDER BY id").all(state) as { id: string }[])
      .map(({ id }) => this.get(id)!);
  }
}
