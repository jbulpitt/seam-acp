import type Database from "better-sqlite3";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { ChannelRef } from "../../platforms/chat-adapter.js";
import type { ConfigMutationInput, ConfigProposal } from "../config-mutation.js";

interface CardRecord {
  id: string;
  sessionId: string;
  channel: ChannelRef;
  messageId: string | null;
  expiresUtc: string;
  detail: string | null;
}

export interface PermissionCardRecord extends CardRecord {
  kind: "permission";
  identity: string;
  requestId: string | number | null;
  acpSessionId: string;
  attemptId: string;
  location: string;
  slot: number;
  ownerPid: number;
  request: Pick<RequestPermissionRequest, "sessionId" | "options"> & {
    toolCall: Pick<RequestPermissionRequest["toolCall"], "toolCallId" | "title" | "kind">;
  };
  status: "open" | "answered" | "expired" | "cancelled" | "gone";
  response: RequestPermissionResponse | null;
  delivered: boolean;
}

export interface ProposalCardRecord extends CardRecord {
  kind: "proposal";
  input: ConfigMutationInput;
  proposal: Omit<ConfigProposal, "apply">;
  status: "open" | "applied" | "rejected" | "expired" | "failed";
  auditId: string | null;
}

type RecordValue = PermissionCardRecord | ProposalCardRecord;

/** Private typed records for the two durable action cards. */
export class ActionCardStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS action_cards (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT NOT NULL,
      identity TEXT UNIQUE, expires_utc TEXT NOT NULL, status TEXT NOT NULL, data_json TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_action_cards_session ON action_cards(session_id, kind, status);`);
  }

  getPermission(id: string): PermissionCardRecord | null {
    const row = this.get(id); return row?.kind === "permission" ? row : null;
  }
  getProposal(id: string): ProposalCardRecord | null {
    const row = this.get(id); return row?.kind === "proposal" ? row : null;
  }
  findPermission(identity: string): PermissionCardRecord | null {
    const row = this.db.prepare("SELECT id FROM action_cards WHERE identity=?").get(identity) as { id: string } | undefined;
    return row ? this.getPermission(row.id) : null;
  }

  save(row: RecordValue): void {
    this.db.prepare(`INSERT INTO action_cards VALUES (@id,@kind,@sessionId,@identity,@expiresUtc,@status,@data)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, data_json=excluded.data_json`)
      .run({ ...row, identity: row.kind === "permission" ? row.identity : null, data: JSON.stringify(row) });
  }

  permissions(sessionId?: string): PermissionCardRecord[] {
    const rows = this.rows("permission");
    return rows.filter(row => row.kind === "permission" && (!sessionId || row.sessionId === sessionId)) as PermissionCardRecord[];
  }
  proposals(): ProposalCardRecord[] { return this.rows("proposal") as ProposalCardRecord[]; }

  decidePermission(id: string, status: PermissionCardRecord["status"], response: RequestPermissionResponse,
    detail: string, now: number): PermissionCardRecord | null {
    return this.db.transaction(() => {
      const row = this.getPermission(id);
      if (!row || row.status !== "open") return null;
      const expired = Date.parse(row.expiresUtc) <= now;
      row.status = expired ? "expired" : status;
      row.response = expired ? { outcome: { outcome: "cancelled" } } : response;
      row.detail = expired ? "⏱️ Expired — auto-denied." : detail;
      this.save(row);
      return row;
    })();
  }

  decideProposal(id: string, status: ProposalCardRecord["status"], detail: string,
    now: number, apply?: (row: ProposalCardRecord) => { auditId: string; message: string }): ProposalCardRecord | null {
    return this.db.transaction(() => {
      const row = this.getProposal(id);
      if (!row || row.status !== "open") return null;
      if (Date.parse(row.expiresUtc) <= now) {
        row.status = "expired"; row.detail = "⏱️ Expired — not applied.";
      } else {
        row.status = status; row.detail = detail;
        if (apply) {
          try {
            const result = apply(row); row.auditId = result.auditId; row.detail = result.message;
          } catch (error) {
            row.status = "failed"; row.detail = error instanceof Error ? error.message : String(error);
          }
        }
      }
      this.save(row);
      return row;
    })();
  }

  private get(id: string): RecordValue | null {
    const row = this.db.prepare("SELECT data_json FROM action_cards WHERE id=?").get(id) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as RecordValue : null;
  }
  private rows(kind: RecordValue["kind"]): RecordValue[] {
    return (this.db.prepare("SELECT data_json FROM action_cards WHERE kind=? ORDER BY expires_utc").all(kind) as { data_json: string }[])
      .map(row => JSON.parse(row.data_json) as RecordValue);
  }
}
