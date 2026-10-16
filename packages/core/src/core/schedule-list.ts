import type { ChannelRef } from "../platforms/chat-adapter.js";
import type { SessionStore } from "./session-store.js";
import type { ScheduledPromptManager } from "./scheduled-prompts/manager.js";
import type { ScheduledPrompt } from "./scheduled-prompts/types.js";
import { describeCron } from "./scheduled-prompts/cron.js";
import { legacyAttachmentQuarantine } from "./scheduled-prompts/quarantine.js";

export const SCHEDULE_LIST_PAGE_SIZE = 4;

export interface ScheduleListScope extends ChannelRef {
  includeChildren?: boolean;
}

export interface ScheduleListPorts {
  repository: {
    list(channelId: string, platform: string, includeChildren?: boolean): ScheduledPrompt[];
    get(id: string): ScheduledPrompt | undefined;
    save(row: ScheduledPrompt): void;
    remove(id: string): void;
  };
  admin: {
    arm(row: ScheduledPrompt): void;
    disarm(id: string): void;
    reschedule(id: string): void;
    runNow(id: string): Promise<void>;
  };
}

export interface ScheduleListRow extends ScheduledPrompt {
  cadence: string;
  quarantined: boolean;
}

export function scheduleInScope(row: ScheduledPrompt, scope: ScheduleListScope): boolean {
  return row.platform === scope.platform && (row.channelRef === scope.id || Boolean(scope.includeChildren && row.parentRef === scope.id));
}

export function createScheduleListPorts(deps: {
  store: Pick<SessionStore, "listScheduledByChannel" | "listAllScheduled" | "getScheduled" | "upsertScheduled" | "deleteScheduled">;
  manager(): Pick<ScheduledPromptManager, "armFromRow" | "disarm" | "reschedule" | "runNow"> | undefined;
  runNow(id: string): Promise<void>;
}): ScheduleListPorts {
  return {
    repository: {
      list: (id, platform, includeChildren = false) => includeChildren
        ? deps.store.listAllScheduled().filter(row => scheduleInScope(row, { platform, id, includeChildren }))
        : deps.store.listScheduledByChannel(platform, id),
      get: id => deps.store.getScheduled(id) ?? undefined,
      save: row => deps.store.upsertScheduled(row), remove: id => deps.store.deleteScheduled(id),
    },
    admin: {
      arm: row => deps.manager()?.armFromRow(row), disarm: id => deps.manager()?.disarm(id),
      reschedule: id => deps.manager()?.reschedule(id),
      runNow: async id => { const manager = deps.manager(); if (manager) await manager.runNow(id); else await deps.runNow(id); },
    },
  };
}

/** Shared schedule scope, list data and kernel operations; transports own access and rendering. */
export class ScheduleList {
  constructor(private readonly ports: ScheduleListPorts) {}

  page(scope: ScheduleListScope, page = 0): SchedulePage<ScheduleListRow> {
    const rows = this.ports.repository.list(scope.id, scope.platform, scope.includeChildren)
      .filter(row => scheduleInScope(row, scope));
    const slice = paginateSchedules(rows, page);
    return { ...slice, items: slice.items.map(row => ({ ...row, cadence: describeCron(row.cron),
      quarantined: Boolean(legacyAttachmentQuarantine(row)) })) };
  }

  get(scope: ScheduleListScope, id: string): ScheduledPrompt | undefined {
    const row = this.ports.repository.get(id);
    return row && scheduleInScope(row, scope) ? row : undefined;
  }

  private require(scope: ScheduleListScope, id: string): ScheduledPrompt {
    const row = this.get(scope, id);
    if (!row) throw new Error("That schedule no longer exists.");
    return row;
  }

  async run(scope: ScheduleListScope, id: string): Promise<string> {
    const row = this.require(scope, id);
    await this.ports.admin.runNow(id);
    const fresh = this.get(scope, id);
    return scheduleRunOutcome({ name: row.name, status: fresh?.lastStatus,
      quarantined: Boolean(legacyAttachmentQuarantine(fresh ?? row)) });
  }

  setEnabled(scope: ScheduleListScope, id: string, enabled: boolean): void {
    const row = this.require(scope, id);
    const updated = { ...row, enabled, updatedUtc: new Date().toISOString() };
    this.ports.repository.save(updated);
    if (updated.enabled) this.ports.admin.arm(updated);
    else this.ports.admin.disarm(id);
  }

  toggle(scope: ScheduleListScope, id: string): void {
    this.setEnabled(scope, id, !this.require(scope, id).enabled);
  }

  remove(scope: ScheduleListScope, id: string): void {
    this.require(scope, id);
    this.ports.admin.disarm(id);
    this.ports.repository.remove(id);
  }
}

export interface SchedulePage<T> {
    page: number;
    pageCount: number;
  total: number;
    start: number;
  items: T[];
}

export function paginateSchedules<T>(
  rows: ReadonlyArray<T>,
  page: number,
  pageSize: number = SCHEDULE_LIST_PAGE_SIZE
): SchedulePage<T> {
  const size = Math.max(1, Math.floor(pageSize) || SCHEDULE_LIST_PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(rows.length / size) || 1);
  // NaN has no direction, so it means "page 0". ±Infinity does have one, and
  // clamping it to the near edge (rather than to 0) keeps the clamp monotonic.
  const requested = Number.isNaN(page) ? 0 : Math.floor(page);
  const resolved = Math.min(Math.max(0, requested), pageCount - 1);
  const start = resolved * size;
  return {
    page: resolved,
    pageCount,
    total: rows.length,
    start,
    items: rows.slice(start, start + size) as T[],
  };
}

export interface ScheduleListAction {
  action: string;
  arg: string;
}

export function parseScheduleListCustomId(customId: string): ScheduleListAction | null {
  const parts = customId.split(":");
  if (parts.length < 3 || parts[0] !== "sl") return null;
  const action = parts[1] ?? "";
  const arg = parts.slice(2).join(":");
  if (!action || !arg) return null;
  return { action, arg };
}

export function schedulePageCustomId(page: number): string {
  return `sl:page:${page}`;
}

export function requestedSchedulePage(customId: string): number | null {
  const parsed = parseScheduleListCustomId(customId);
  if (!parsed || parsed.action !== "page") return null;
  const n = Number(parsed.arg);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

export interface ScheduleNavState {
  show: boolean;
  prevPage: number;
  nextPage: number;
  prevDisabled: boolean;
  nextDisabled: boolean;
  label: string;
}

export function scheduleNavState(page: number, pageCount: number): ScheduleNavState {
  return {
    // A single page needs no navigation, and rendering a fully-disabled nav row
    // would only add a dead control to a card that has nowhere to go.
    show: pageCount > 1,
    prevPage: page - 1,
    nextPage: page + 1,
    prevDisabled: page <= 0,
    nextDisabled: page >= pageCount - 1,
    label: `Page ${page + 1}/${pageCount}`,
  };
}

export function schedulePageCaption(slice: SchedulePage<unknown>): string | null {
  if (slice.pageCount <= 1) return null;
  const first = slice.total === 0 ? 0 : slice.start + 1;
  const last = slice.start + slice.items.length;
  return `Page ${slice.page + 1} of ${slice.pageCount} · showing ${first}-${last} of ${slice.total}`;
}

export function scheduleRunOutcome(opts: {
  name: string;
  /** `last_status` after the run attempt. */
  status: string | null | undefined;
  /** True when the row is quarantined and was refused before firing. */
  quarantined?: boolean;
}): string {
  const name = `**${opts.name}**`;
  const status = opts.status ?? "unknown";
  if (opts.quarantined) {
    return (
      `🚫 ${name} did not run — it is quarantined (legacy reference files, #158). ` +
      `Edit the schedule so its prompt stands alone or points at a repository runbook, then it will run again.`
    );
  }
  if (status === "skipped: still running") {
    return `⏸️ ${name} is already running — this click was skipped.`;
  }
  if (status.startsWith("skipped:")) {
    return `⏭️ ${name} did not run — \`${status}\`.`;
  }
  if (status.startsWith("error:")) {
    return `❌ ${name} failed — \`${status}\`.`;
  }
  if (status.startsWith("aborted:")) {
    return `🛑 ${name} was interrupted — \`${status}\`.`;
  }
  return `▶️ ${name} finished — last: \`${status}\`.`;
}
