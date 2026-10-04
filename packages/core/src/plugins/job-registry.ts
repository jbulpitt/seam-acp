import type { Logger } from "../lib/logger.js";

/** Maintenance only. The contribution owns cadence, the host owns its lifecycle. */
export interface JobContribution {
  name: string;
  phase: "after-admission";
  intervalMs: number;
  start(context: { signal: AbortSignal; intervalMs: number }): void | Promise<void>;
  stop(): void;
  drain(): Promise<void>;
}

type Entry = { plugin: string; job: JobContribution; controller: AbortController; started: boolean };

export class JobRegistry {
  private readonly entries: Entry[] = [];
  private stopped = false;
  constructor(private readonly logger: Logger, private readonly disable: (plugin: string) => Promise<void>) {}

  validate(jobs: readonly JobContribution[]): void {
    const names = new Set<string>();
    for (const job of jobs) {
      if (!job.name || names.has(job.name) || job.phase !== "after-admission" || !Number.isFinite(job.intervalMs) || job.intervalMs <= 0) {
        throw new Error(`invalid maintenance job ${job.name}`);
      }
      names.add(job.name);
    }
  }

  register(plugin: string, jobs: readonly JobContribution[]): void {
    this.validate(jobs);
    for (const job of jobs) this.entries.push({ plugin, job, controller: new AbortController(), started: false });
  }

  async startAfterAdmission(admission: Promise<void>): Promise<void> {
    await admission;
    if (this.stopped) return;
    for (const entry of [...this.entries]) {
      if (entry.started || entry.controller.signal.aborted) continue;
      entry.started = true;
      try {
        await entry.job.start({ signal: entry.controller.signal, intervalMs: entry.job.intervalMs });
        this.logger.info({ plugin: entry.plugin, job: entry.job.name }, "plugin job started");
      }
      catch (err) {
        this.logger.error({ err, plugin: entry.plugin, job: entry.job.name }, "plugin job failed");
        await this.disable(entry.plugin);
      }
    }
  }

  stop(plugin?: string): void {
    if (!plugin) this.stopped = true;
    for (const entry of this.entries.filter(entry => !plugin || entry.plugin === plugin)) {
      if (entry.controller.signal.aborted) continue;
      entry.controller.abort();
      try {
        entry.job.stop();
        this.logger.info({ plugin: entry.plugin, job: entry.job.name }, "plugin job stopped");
      }
      catch (err) { this.logger.error({ err, plugin: entry.plugin, job: entry.job.name }, "plugin job stop failed"); }
    }
  }

  async drain(plugin?: string): Promise<void> {
    await Promise.all(this.entries.filter(entry => !plugin || entry.plugin === plugin).map(async entry => {
      await entry.job.drain();
      this.logger.info({ plugin: entry.plugin, job: entry.job.name }, "plugin job drained");
    }));
  }
}
