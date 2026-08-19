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
 * started for a session and revoked when that runtime is invalidated/disposed,
 * so a stale token can never resolve to a dead session. Because the mapping is
 * keyed on the stable session id (not the ephemeral runtime), re-minting for a
 * session that already has a token simply rotates it — the old token stops
 * resolving immediately.
 */
import { randomUUID } from "node:crypto";

export class SeamTokenRegistry {
  /** token → session id (record.id). */
  private readonly byToken = new Map<string, string>();
  /** session id → its current token, so a re-mint / revoke can find the old one. */
  private readonly bySession = new Map<string, string>();

  /**
   * Mint (or rotate) the token for a session. Any previous token for the same
   * session stops resolving. Returns the new token to inject into that session's
   * `mcpServers` header.
   */
  mint(sessionId: string): string {
    this.revokeSession(sessionId);
    const token = randomUUID();
    this.byToken.set(token, sessionId);
    this.bySession.set(sessionId, token);
    return token;
  }

  /** Resolve a token to its session id, or undefined if unknown/revoked. */
  resolve(token: string | undefined | null): string | undefined {
    if (!token) return undefined;
    return this.byToken.get(token);
  }

  /** Revoke whatever token is currently mapped to this session (if any). */
  revokeSession(sessionId: string): void {
    const existing = this.bySession.get(sessionId);
    if (existing !== undefined) {
      this.byToken.delete(existing);
      this.bySession.delete(sessionId);
    }
  }

  /** Number of live tokens — for diagnostics/tests. */
  get size(): number {
    return this.byToken.size;
  }
}
