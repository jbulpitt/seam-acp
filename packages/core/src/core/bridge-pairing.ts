/**
 * Per-bridge pairing tokens (D8). Raw tokens are shown once at mint/rotate
 * and never written to disk — only a SHA-256 hex hash is persisted.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function mintBridgeToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashBridgeToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenMatchesHash(token: string, tokenHash: string): boolean {
  const a = Buffer.from(hashBridgeToken(token), "hex");
  const b = Buffer.from(tokenHash, "hex");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export function slugifyBridgeId(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return s || "bridge";
}

export function uniqueBridgeId(name: string, existing: Iterable<string>): string {
  const base = slugifyBridgeId(name);
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const id = `${base}-${i}`.slice(0, 64);
    if (!taken.has(id)) return id;
  }
  return `${base}-${Date.now().toString(36)}`.slice(0, 64);
}
