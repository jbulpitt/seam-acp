import fs from "node:fs";
import { DRAFT_IDLE_TTL_MS, type ThreadConfigDraft } from "../../platforms/discord/config-editor.js";

export class ConfigEditorStore {
  private readonly byId = new Map<string, ThreadConfigDraft>();
  private readonly byUserThread = new Map<string, string>();
  private file?: string;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts?: { ttlMs?: number; now?: () => number }) {
    this.ttlMs = opts?.ttlMs ?? DRAFT_IDLE_TTL_MS;
    this.now = opts?.now ?? Date.now;
  }

  /** Restore timestamps unchanged: a controller restart is not draft activity. */
  load(file: string): void {
    const drafts: ThreadConfigDraft[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    this.byId.clear();
    this.byUserThread.clear();
    for (const draft of drafts) {
      this.byId.set(draft.id, draft);
      this.byUserThread.set(this.userThreadKey(draft.userId, draft.threadId), draft.id);
    }
    this.file = file;
  }

  private persist(): void {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify([...this.byId.values()]));
  }

  private userThreadKey(userId: string, threadId: string): string {
    return `${userId}:${threadId}`;
  }

  private isExpired(draft: ThreadConfigDraft, now: number): boolean {
    return now - draft.updatedAt > this.ttlMs;
  }

  get(id: string): ThreadConfigDraft | undefined {
    const draft = this.byId.get(id);
    if (!draft) return undefined;
    if (this.isExpired(draft, this.now())) {
      this.delete(id);
      return undefined;
    }
    return draft;
  }

  getForUserThread(userId: string, threadId: string): ThreadConfigDraft | undefined {
    const id = this.byUserThread.get(this.userThreadKey(userId, threadId));
    return id ? this.get(id) : undefined;
  }

  /**
   * Insert `draft`. If this user already has a draft in the same thread,
   * the previous draft is removed and returned so the caller can expire
   * its card.
   */
  put(draft: ThreadConfigDraft): ThreadConfigDraft | undefined {
    const key = this.userThreadKey(draft.userId, draft.threadId);
    const prevId = this.byUserThread.get(key);
    let evicted: ThreadConfigDraft | undefined;
    if (prevId && prevId !== draft.id) {
      evicted = this.byId.get(prevId);
      this.byId.delete(prevId);
    }
    this.byId.set(draft.id, draft);
    this.byUserThread.set(key, draft.id);
    this.persist();
    return evicted;
  }

  touch(id: string, patch: Partial<ThreadConfigDraft>): ThreadConfigDraft | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    const next: ThreadConfigDraft = {
      ...cur,
      ...patch,
      overlay: patch.overlay ?? cur.overlay,
      warnings: patch.warnings ?? cur.warnings,
      updatedAt: this.now(),
    };
    this.byId.set(id, next);
    this.persist();
    return next;
  }

  delete(id: string): ThreadConfigDraft | undefined {
    const draft = this.byId.get(id);
    if (!draft) return undefined;
    this.byId.delete(id);
    const key = this.userThreadKey(draft.userId, draft.threadId);
    if (this.byUserThread.get(key) === id) this.byUserThread.delete(key);
    this.persist();
    return draft;
  }
}
