/**
 * Per-session token registry for the agent-facing seam-MCP surface.
 *
 * One shared in-process HTTP MCP server serves every session (see
 * `seam-mcp-server.ts`), so a tool call arriving at that server carries no
 * intrinsic notion of *which* session made it. We solve that the way #17's
 * spike proved out: each session's injected `mcpServers` entry carries an
 * `X-Seam-Session: <token>` header; the server reads that header off each
 * request and resolves it back to the calling session via this registry.
 *
 * The token is an opaque `crypto.randomUUID()`. It is minted when a runtime is
 * started for a session. Tokens identify the **Discord session**, not the ACP
 * subprocess — they must survive agent death and `npm run redeploy` or Grok
 * (and others) reconnect HTTP MCP with a header the new process no longer
 * knows. Optional `persistPath` writes the map to disk (0600).
 *
 * Re-minting for a session that already has a token rotates it (old token
 * stops resolving). Runtime start should `peek`/`reuseToken` instead.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class SeamTokenRegistry {
  /** token → session id (record.id). */
  private readonly byToken = new Map<string, string>();
  /** session id → its current token, so a re-mint / revoke can find the old one. */
  private readonly bySession = new Map<string, string>();
  private readonly persistPath: string | null;

  constructor(opts?: { persistPath?: string }) {
    this.persistPath = opts?.persistPath ?? null;
    this.load();
  }

  /**
   * Mint (or rotate) the token for a session. Any previous token for the same
   * session stops resolving. Returns the new token to inject into that session's
   * `mcpServers` header.
   */
  mint(sessionId: string): string {
    this.revokeSession(sessionId, { persist: false });
    const token = randomUUID();
    this.byToken.set(token, sessionId);
    this.bySession.set(sessionId, token);
    this.save();
    return token;
  }

  /** Resolve a token to its session id, or undefined if unknown/revoked. */
  resolve(token: string | undefined | null): string | undefined {
    if (!token) return undefined;
    return this.byToken.get(token);
  }

  /** Current token for a session, if any — does not mint or rotate. Isolated
   *  ingest reuses the authoring thread's token so a live turn keeps working. */
  peek(sessionId: string): string | undefined {
    return this.bySession.get(sessionId);
  }

  /** Revoke whatever token is currently mapped to this session (if any). */
  revokeSession(sessionId: string, opts?: { persist?: boolean }): void {
    const existing = this.bySession.get(sessionId);
    if (existing !== undefined) {
      this.byToken.delete(existing);
      this.bySession.delete(sessionId);
      if (opts?.persist !== false) this.save();
    }
  }

  /** Number of live tokens — for diagnostics/tests. */
  get size(): number {
    return this.byToken.size;
  }

  private load(): void {
    const p = this.persistPath;
    if (!p) return;
    try {
      const raw = fs.readFileSync(p, "utf8");
      const data = JSON.parse(raw) as unknown;
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      for (const [sessionId, token] of Object.entries(data as Record<string, unknown>)) {
        if (typeof token !== "string" || !sessionId || !token) continue;
        this.bySession.set(sessionId, token);
        this.byToken.set(token, sessionId);
      }
    } catch {
      /* missing or corrupt — start empty */
    }
  }

  private save(): void {
    const p = this.persistPath;
    if (!p) return;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const obj: Record<string, string> = {};
      for (const [sessionId, token] of this.bySession) obj[sessionId] = token;
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      fs.renameSync(tmp, p);
      try {
        fs.chmodSync(p, 0o600);
      } catch {
        /* best-effort */
      }
    } catch {
      /* disk full / perms — in-memory map still works this process */
    }
  }
}
