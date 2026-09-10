/** Live metadata only. Never put prompt, output, ACP, credentials or host paths
 * here: this projection feeds channel-scoped readers and privileged diagnostics. */
export interface ScheduledActivity {
  occurrenceId: string;
  scheduleId: string;
  name: string;
  platform: string;
  channelRef: string;
  parentRef: string | null;
  mode: "live" | "isolated";
  startedUtc: string;
  elapsedMs: number;
  phase: "startup" | "queued" | "provider" | "output" | "cleanup";
}
export interface ScheduledActivitySnapshot { total: number; entries: ScheduledActivity[] }

/** Separate from live queue occupancy and from drain accounting tokens.
 * Duplicate admissions may briefly own two tokens for one logical occurrence;
 * releasing either token must never remove the other owner's attribution. */
export class ScheduledActivityRegistry {
  private readonly entries = new Map<symbol, Omit<ScheduledActivity, "elapsedMs">>();
  begin(input: Pick<ScheduledActivity, "occurrenceId" | "scheduleId" | "name" | "platform" | "channelRef" | "parentRef" | "mode">): () => void {
    const token = Symbol(input.occurrenceId);
    const { occurrenceId, scheduleId, name, platform, channelRef, parentRef, mode } = input;
    this.entries.set(token, { occurrenceId, scheduleId, name, platform, channelRef, parentRef, mode,
      startedUtc: new Date().toISOString(), phase: "startup" });
    return () => { this.entries.delete(token); };
  }
  phase(id: string, phase: ScheduledActivity["phase"]): void {
    const first = [...this.entries.values()].find(e => e.occurrenceId === id);
    if (first) first.phase = phase;
  }
  snapshot(now = Date.now()): ScheduledActivity[] {
    const unique = new Map<string, ScheduledActivity>();
    for (const e of this.entries.values()) {
      if (!unique.has(e.occurrenceId)) unique.set(e.occurrenceId, {
        ...e, elapsedMs: Math.max(0, now - Date.parse(e.startedUtc)),
      });
    }
    return [...unique.values()];
  }
}

export function scheduledActivityLine(work: ScheduledActivity): string {
  const name = work.name.replace(/[`\r\n@]/g, " ").slice(0, 100);
  return `• ${name} — schedule ${work.scheduleId}; occurrence ${work.occurrenceId}; ` +
    `thread ${work.channelRef}; ${work.mode}; ${work.phase}; ${Math.floor(work.elapsedMs / 1000)}s; started ${work.startedUtc}`;
}
