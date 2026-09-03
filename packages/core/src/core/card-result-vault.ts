/**
 * Private hand-off for a card result whose card died before it could show it
 * (#179).
 *
 * The problem this exists to solve is a privacy one, not a plumbing one. An
 * interactive card is **ephemeral** — only the operator who ran the command
 * sees it. Some of what it shows is genuinely private: an AI summary is a
 * distillation of a whole conversation, and a compaction report names sessions
 * and paths. Discord expires an interaction token after fifteen minutes, and a
 * premium pipeline can outrun that, at which point the card is unreachable.
 *
 * The obvious recovery — post the result into the thread — is wrong, because
 * the thread is not ephemeral. It silently promotes content from "one operator"
 * to "everyone in the channel, forever, indexed and quotable", as a side effect
 * of a TIMEOUT. Nobody consented to that; they consented to an ephemeral card.
 *
 * So the result is parked here instead, on the server, addressed to one
 * operator, and the public notice says only that something finished. The
 * operator collects it by re-opening the browser — an authenticated action, in
 * a reply only they can see.
 *
 * Durable on purpose: a restart between the failed render and the collection is
 * exactly the situation where losing it would be most annoying, and the whole
 * point is that this content cannot be regenerated for free.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../lib/logger.js";

/** What is parked, and who may collect it. */
export interface StoredCardResult {
  id: string;
  /** Session record the result belongs to. */
  recordId: string;
  /**
   * The ONLY user allowed to collect it. Not "anyone in the thread": the card
   * this replaces was visible to one person, and the replacement must not be
   * more visible than the thing it replaces.
   */
  userId: string;
  /** What produced it, for the collection notice. */
  label: string;
  /** Attachment name. Deliberately carries no session id. */
  filename: string;
  body: string;
  createdUtc: string;
}

/** Results older than this are dropped rather than kept indefinitely. */
export const CARD_RESULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class CardResultVault {
  private readonly dir: string;

  constructor(
    dataDir: string,
    private readonly logger: Logger,
    private readonly ttlMs: number = CARD_RESULT_TTL_MS
  ) {
    this.dir = path.join(dataDir, "card-results");
  }

  /** Park one result. Best-effort: never throws into a shutdown-time caller. */
  async put(entry: Omit<StoredCardResult, "id" | "createdUtc">): Promise<string | null> {
    const stored: StoredCardResult = {
      ...entry,
      id: randomUUID(),
      createdUtc: new Date().toISOString(),
    };
    try {
      await mkdir(this.dir, { recursive: true });
      const final = path.join(this.dir, `${stored.id}.json`);
      const tmp = `${final}.tmp`;
      await writeFile(tmp, JSON.stringify(stored), "utf8");
      await rename(tmp, final);
      return stored.id;
    } catch (err) {
      this.logger.warn({ err, recordId: entry.recordId }, "card result could not be parked");
      return null;
    }
  }

  /**
   * Collect and REMOVE everything parked for this operator on this thread.
   *
   * Both keys are required. Matching on the record alone would hand one
   * operator's summary to whoever next opened the browser in that thread, which
   * is the same leak as posting it publicly, only quieter.
   */
  async take(recordId: string, userId: string): Promise<StoredCardResult[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return []; // nothing has ever been parked
    }
    const out: StoredCardResult[] = [];
    const cutoff = Date.now() - this.ttlMs;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.dir, name);
      let entry: StoredCardResult;
      try {
        entry = JSON.parse(await readFile(file, "utf8")) as StoredCardResult;
      } catch {
        continue; // partially written or corrupt — leave it for the sweep below
      }
      const expired = Date.parse(entry.createdUtc) < cutoff;
      const mine = entry.recordId === recordId && entry.userId === userId;
      if (!mine && !expired) continue;
      await rm(file, { force: true }).catch(() => {});
      if (mine && !expired) out.push(entry);
    }
    return out.sort((a, b) => a.createdUtc.localeCompare(b.createdUtc));
  }
}
