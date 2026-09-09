import fs from "node:fs";
import path from "node:path";
import type { SessionRecord } from "./types.js";
import type { SessionStore } from "./session-store.js";

export interface AgyIdentityChange {
  before: SessionRecord;
  after: SessionRecord;
  rebuild: boolean;
  reason: "native" | "unbound" | "package" | "unrecognized";
}

/** Structural identity only. Never reads conversation payloads or emits map contents. */
function readMap(file: string): Record<string, unknown> {
  try {
    if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error("AGY session map exceeds migration bound");
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid AGY session map");
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // JSON parser errors may contain excerpts of private map content.
    throw new Error("Cannot safely classify AGY session map");
  }
}

export function readAgyHandleOwnership(dataDir: string, home: string, packageStateDir: string): {
  native: Set<string>; packaged: Set<string>;
} {
  const native = new Set<string>();
  for (const file of [path.join(dataDir, "agy-sessions.json"), path.join(home, ".gemini/antigravity-cli/seam_sessions.json")]) {
    for (const [id, entry] of Object.entries(readMap(file))) {
      const cascade = typeof entry === "string" ? entry : (entry as { cascadeId?: unknown } | null)?.cascadeId;
      if (typeof cascade !== "string" || !cascade.trim()) throw new Error("Invalid native AGY mapping entry");
      native.add(id);
    }
  }
  const pkg = readMap(path.join(packageStateDir, "sessions.json"));
  const sessions = pkg.sessions ?? {};
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) throw new Error("Invalid package AGY map");
  return { native, packaged: new Set(Object.keys(sessions)) };
}

/** Run once at startup, before catalogs, admitted work or provider runtimes. */
export function planAgyIdentityMigration(
  records: readonly SessionRecord[],
  ownership: { native: ReadonlySet<string>; packaged: ReadonlySet<string> },
  binding: (record: SessionRecord) => { agent: string; location: string; explicitAgent?: string },
): AgyIdentityChange[] {
  const changes: AgyIdentityChange[] = [];
  for (const before of records) {
    const effective = binding(before);
    if (effective.location.trim() !== "local" || !["agy", "agy-old"].includes(effective.agent)) continue;
    if (effective.explicitAgent === "agy-old") throw new Error("Native restoration requires migrating the local agy-old preset first");
    // Refuse an overlay/row mismatch rather than touching an unrelated backend's handle.
    if (!["agy", "agy-old"].includes(before.agentId)) throw new Error("AGY restoration found conflicting stored and effective agents");
    const handle = before.acpSessionId;
    if (handle && ownership.native.has(handle) && ownership.packaged.has(handle)) throw new Error("Ambiguous AGY session ownership");
    const reason = !handle ? "unbound" : ownership.native.has(handle) ? "native" : ownership.packaged.has(handle) ? "package" : "unrecognized";
    const rebuild = reason === "package" || reason === "unrecognized";
    changes.push({ before, after: { ...before, agentId: "agy", acpSessionId: rebuild ? "" : handle }, rebuild, reason });
  }
  return changes;
}

/** Called inside the normal admitted turn; no boot-time provider prompt fanout. */
export async function rebuildMigratedAgySession(
  store: SessionStore,
  record: SessionRecord,
  binding: { agent: string; location: string },
  rebuild: () => Promise<{ attached: boolean; newSessionId: string }>,
): Promise<void> {
  if (!store.needsAgyIdentityRebuild(record.id)) return;
  if (binding.agent !== "agy" || binding.location !== "local") throw new Error("AGY restoration binding changed; rebuild requires review");
  const result = await rebuild();
  if (!result.attached || !result.newSessionId || !store.completeAgyIdentityRebuild(record.id, result.newSessionId)) {
    throw new Error("AGY restoration rebuild did not attach; pending recovery retained");
  }
}
