/**
 * Private hand-off for a card result whose card died before it could show it
 * (#179, #190).
 *
 * Results stay durable until Discord accepts the private follow-up. Retrieval
 * first atomically renames an available file to an opaque lease filename;
 * success acknowledges that exact claim, while failure releases it. No owner
 * or thread identifier is ever encoded in a filename.
 */
import {
  constants,
  link,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../lib/logger.js";

/** What is parked, and who may collect it. */
export interface StoredCardResult {
  id: string;
  /** Session record the result belongs to. */
  recordId: string;
  /** The ONLY user allowed to collect it. */
  userId: string;
  /** What produced it, for the collection notice. */
  label: string;
  /** Attachment name. Deliberately carries no session id. */
  filename: string;
  body: string;
  createdUtc: string;
}

/** Opaque ownership proof for one in-flight delivery attempt. */
export interface ClaimedCardResult {
  entry: StoredCardResult;
  token: string;
  leaseExpiresAt: number;
}

/** Results older than this are dropped rather than kept indefinitely. */
export const CARD_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Discord's intended attachment path accepts at most 25 MiB. */
export const CARD_RESULT_BODY_MAX_BYTES = 25 * 1024 * 1024;
/** Keep attachment names inside both Discord and common filesystem limits. */
export const CARD_RESULT_FILENAME_MAX_BYTES = 255;
/** A crashed collector eventually gives another authenticated open a retry. */
export const CARD_RESULT_LEASE_MS = 5 * 60 * 1000;
/** Interrupted atomic writes should not accumulate forever. */
export const CARD_RESULT_TEMP_TTL_MS = 60 * 60 * 1000;

const CARD_RESULT_RECORD_OVERHEAD_BYTES = 16 * 1024;
const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_RE = new RegExp(`^${UUID_SOURCE}$`, "i");
const AVAILABLE_RE = new RegExp(`^(${UUID_SOURCE})\\.json$`, "i");
const CLAIM_RE = new RegExp(`^(${UUID_SOURCE})\\.claim\\.(\\d{1,16})\\.(${UUID_SOURCE})\\.json$`, "i");
const ACKED_RE = new RegExp(`^(${UUID_SOURCE})\\.acked\\.(${UUID_SOURCE})\\.json$`, "i");
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

interface CardResultVaultHooks {
  /** Deterministic race seam; production never supplies it. */
  beforeClaimRename?: (entry: StoredCardResult) => Promise<void>;
}

export interface CardResultVaultOptions {
  ttlMs?: number;
  leaseMs?: number;
  tempTtlMs?: number;
  now?: () => number;
  hooks?: CardResultVaultHooks;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedKey(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    byteLength(value) <= maxBytes &&
    !CONTROL_RE.test(value)
  );
}

function validFilename(value: unknown): value is string {
  return (
    boundedKey(value, CARD_RESULT_FILENAME_MAX_BYTES) &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    path.basename(value) === value
  );
}

function validStoredResult(value: unknown, expectedId?: string): value is StoredCardResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<StoredCardResult>;
  if (typeof entry.id !== "string" || !UUID_RE.test(entry.id)) return false;
  if (expectedId && entry.id !== expectedId) return false;
  if (!boundedKey(entry.recordId, 512)) return false;
  if (!boundedKey(entry.userId, 128)) return false;
  if (!boundedKey(entry.label, 128)) return false;
  if (!validFilename(entry.filename)) return false;
  if (typeof entry.body !== "string" || byteLength(entry.body) > CARD_RESULT_BODY_MAX_BYTES) {
    return false;
  }
  if (typeof entry.createdUtc !== "string") return false;
  const created = Date.parse(entry.createdUtc);
  return Number.isFinite(created) && new Date(created).toISOString() === entry.createdUtc;
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

export class CardResultVault {
  private readonly dir: string;
  private readonly ttlMs: number;
  private readonly leaseMs: number;
  private readonly tempTtlMs: number;
  private readonly now: () => number;
  private readonly hooks: CardResultVaultHooks;

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    options: CardResultVaultOptions = {}
  ) {
    this.dir = path.join(dataDir, "card-results");
    this.ttlMs = options.ttlMs ?? CARD_RESULT_TTL_MS;
    this.leaseMs = options.leaseMs ?? CARD_RESULT_LEASE_MS;
    this.tempTtlMs = options.tempTtlMs ?? CARD_RESULT_TEMP_TTL_MS;
    this.now = options.now ?? Date.now;
    this.hooks = options.hooks ?? {};
  }

  /** Park one result. Best-effort: never throws into a shutdown-time caller. */
  async put(entry: Omit<StoredCardResult, "id" | "createdUtc">): Promise<string | null> {
    const stored: StoredCardResult = {
      ...entry,
      id: randomUUID(),
      createdUtc: new Date(this.now()).toISOString(),
    };
    if (!validStoredResult(stored)) {
      this.logger.warn(
        { recordId: boundedKey(entry.recordId, 512) ? entry.recordId : "invalid" },
        "card result rejected before parking"
      );
      return null;
    }
    const serialized = JSON.stringify(stored);
    if (byteLength(serialized) > CARD_RESULT_BODY_MAX_BYTES + CARD_RESULT_RECORD_OVERHEAD_BYTES) {
      this.logger.warn({ recordId: entry.recordId }, "card result record exceeded storage bound");
      return null;
    }

    const token = randomUUID();
    const final = this.availablePath(stored.id);
    const tmp = path.join(this.dir, `${stored.id}.${token}.tmp`);
    try {
      await mkdir(this.dir, { recursive: true });
      await this.sweep();
      await writeFile(tmp, serialized, { encoding: "utf8", flag: "wx" });
      await rename(tmp, final);
      return stored.id;
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      this.logger.warn({ err, recordId: entry.recordId }, "card result could not be parked");
      return null;
    }
  }

  /**
   * Atomically claim every currently available result for this exact owner.
   * The durable bytes remain in the vault until `acknowledge` commits success.
   */
  async claim(recordId: string, userId: string): Promise<ClaimedCardResult[]> {
    if (!boundedKey(recordId, 512) || !boundedKey(userId, 128)) return [];
    await this.sweep();

    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }

    const out: ClaimedCardResult[] = [];
    for (const name of names) {
      const available = AVAILABLE_RE.exec(name);
      if (!available) continue;
      const id = available[1]!;
      const source = path.join(this.dir, name);
      const candidate = await this.readStored(source, id);
      if (!candidate) {
        await rm(source, { force: true }).catch(() => {});
        continue;
      }
      if (this.isExpired(candidate) || candidate.recordId !== recordId || candidate.userId !== userId) {
        continue;
      }

      const token = randomUUID();
      const leaseExpiresAt = this.now() + this.leaseMs;
      const claimed = this.claimPath(id, leaseExpiresAt, token);
      await this.hooks.beforeClaimRename?.(candidate);
      try {
        // Rename is the ownership commit point. Two readers may inspect the
        // same candidate, but only one can move its source name.
        await rename(source, claimed);
      } catch (err) {
        if (errorCode(err) === "ENOENT") continue;
        throw err;
      }

      // Trust only the bytes under our claimed name. If anything changed in
      // the read→rename window, never deliver it under the earlier identity.
      const entry = await this.readStored(claimed, id);
      if (!entry) {
        await rm(claimed, { force: true }).catch(() => {});
        continue;
      }
      if (this.isExpired(entry)) {
        await rm(claimed, { force: true }).catch(() => {});
        continue;
      }
      if (entry.recordId !== recordId || entry.userId !== userId) {
        await this.restoreClaim(claimed, id);
        continue;
      }
      out.push({ entry, token, leaseExpiresAt });
    }
    return out.sort((a, b) => a.entry.createdUtc.localeCompare(b.entry.createdUtc));
  }

  /** Mark this exact claim delivered, then remove its acknowledged tombstone. */
  async acknowledge(claim: ClaimedCardResult): Promise<boolean> {
    const source = this.pathForClaim(claim);
    if (!source) return false;
    const acknowledged = path.join(this.dir, `${claim.entry.id}.acked.${claim.token}.json`);
    try {
      // The rename is the durable ACK. A crash before the following unlink
      // leaves an acked file that sweep deletes but never redelivers.
      await rename(source, acknowledged);
    } catch (err) {
      if (errorCode(err) === "ENOENT") return false;
      throw err;
    }
    await rm(acknowledged, { force: true }).catch((err) =>
      this.logger.warn({ err, entry: claim.entry.id }, "acked card result cleanup failed")
    );
    return true;
  }

  /** Release a failed delivery so the next authenticated open can retry it. */
  async release(claim: ClaimedCardResult): Promise<boolean> {
    const source = this.pathForClaim(claim);
    if (!source) return false;
    try {
      await link(source, this.availablePath(claim.entry.id));
      await rm(source, { force: true });
      return true;
    } catch (err) {
      if (errorCode(err) === "ENOENT") return false;
      // EEXIST is fail-closed: never overwrite another durable copy. The old
      // claim remains harmless and sweep removes it after its lease.
      this.logger.warn({ err, entry: claim.entry.id }, "card result claim could not be released");
      return false;
    }
  }

  private availablePath(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private claimPath(id: string, leaseExpiresAt: number, token: string): string {
    return path.join(this.dir, `${id}.claim.${leaseExpiresAt}.${token}.json`);
  }

  private pathForClaim(claim: ClaimedCardResult): string | null {
    if (
      !UUID_RE.test(claim.entry.id) ||
      !UUID_RE.test(claim.token) ||
      !Number.isSafeInteger(claim.leaseExpiresAt) ||
      claim.leaseExpiresAt < 0
    ) {
      return null;
    }
    return this.claimPath(claim.entry.id, claim.leaseExpiresAt, claim.token);
  }

  private isExpired(entry: StoredCardResult): boolean {
    return Date.parse(entry.createdUtc) < this.now() - this.ttlMs;
  }

  /** Read a bounded, regular file without ever following a symlink. */
  private async readStored(file: string, expectedId: string): Promise<StoredCardResult | null> {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > CARD_RESULT_BODY_MAX_BYTES + CARD_RESULT_RECORD_OVERHEAD_BYTES) {
        return null;
      }
      const bytes = await handle.readFile();
      if (bytes.byteLength > CARD_RESULT_BODY_MAX_BYTES + CARD_RESULT_RECORD_OVERHEAD_BYTES) {
        return null;
      }
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      return validStoredResult(parsed, expectedId) ? parsed : null;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  /** Restore an expired/failed claim without ever overwriting an available file. */
  private async restoreClaim(claimed: string, id: string): Promise<void> {
    try {
      await link(claimed, this.availablePath(id));
      await rm(claimed, { force: true });
    } catch (err) {
      if (errorCode(err) === "ENOENT") return;
      if (errorCode(err) === "EEXIST") {
        await rm(claimed, { force: true }).catch(() => {});
        return;
      }
      this.logger.warn({ err, entry: id }, "expired card result claim could not be restored");
    }
  }

  /**
   * Opportunistic bounded cleanup. It never returns content: invalid records,
   * stale temps and ACK tombstones are simply removed; expired leases are
   * privately restored under their original opaque result id.
   */
  private async sweep(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const now = this.now();

    for (const name of names) {
      const file = path.join(this.dir, name);
      const available = AVAILABLE_RE.exec(name);
      if (available) {
        const entry = await this.readStored(file, available[1]!);
        if (!entry || this.isExpired(entry)) await rm(file, { force: true }).catch(() => {});
        continue;
      }

      const claim = CLAIM_RE.exec(name);
      if (claim) {
        const leaseExpiresAt = Number(claim[2]);
        if (!Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt > now) continue;
        const entry = await this.readStored(file, claim[1]!);
        if (!entry || this.isExpired(entry)) await rm(file, { force: true }).catch(() => {});
        else await this.restoreClaim(file, claim[1]!);
        continue;
      }

      if (ACKED_RE.test(name)) {
        await rm(file, { force: true }).catch(() => {});
        continue;
      }

      if (name.endsWith(".tmp")) {
        const info = await stat(file).catch(() => null);
        if (!info || !info.isFile() || info.mtimeMs <= now - this.tempTtlMs) {
          await rm(file, { force: true }).catch(() => {});
        }
        continue;
      }

      // The directory is vault-owned. A JSON file that matches no supported
      // state can never become deliverable, so retain no potentially private
      // bytes under an unrecognised name.
      if (name.endsWith(".json")) await rm(file, { force: true }).catch(() => {});
    }
  }
}
