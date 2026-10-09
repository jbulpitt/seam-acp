import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";
import { readProcessIdentity } from "@seam/adapters";

export const BOOT_OBSERVATION_FILE = "controller-boot.json";
export interface ControllerIdentity { pid: number; started: string }
export interface BootObservation {
  identity: ControllerIdentity;
  instanceId: string;
  branch: string;
  commit: string;
  startedAt: string;
  readyAt: string | null;
  errorCount: number;
  errors: string[];
}

/** Observe boot logs without changing logging or recovery. */
export class BootObserver {
  private observation?: BootObservation;
  private file?: string;
  private errorCount = 0;
  private errors: string[] = [];

  begin(dataDir: string, revision: { branch: string; commit: string }, instanceId: string): void {
    this.file = path.join(dataDir, BOOT_OBSERVATION_FILE);
    const identity = readProcessIdentity(process.pid);
    this.observation = { identity: { pid: process.pid, started: identity?.started ?? "unknown" },
      instanceId, ...revision, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      readyAt: null, errorCount: this.errorCount, errors: this.errors };
    this.persist();
  }

  record(level: number, args: unknown[], component?: string): void {
    if (level < 50 || this.observation?.readyAt) return;
    const first = args[0];
    const fields = first && typeof first === "object" ? first as { err?: unknown; error?: unknown } : undefined;
    const error = first instanceof Error ? first : fields?.err ?? fields?.error;
    const detail = error instanceof Error ? error.message
      : error && typeof error === "object" && "message" in error ? String(error.message)
      : error === undefined ? undefined : String(error);
    const text = typeof first === "string" ? format(...args)
      : typeof args[1] === "string" ? format(...args.slice(1)) : detail ?? "error log without message";
    this.errorCount++;
    this.errors.push([
      `level ${level}`, component, text, detail && !text.includes(detail) ? detail : undefined,
    ].filter(Boolean).join(": "));
    if (this.observation) {
      this.observation.errorCount = this.errorCount;
      this.persist();
    }
  }

  ready(): void {
    if (!this.observation) return;
    this.observation.readyAt = new Date().toISOString();
    this.persist();
  }

  snapshot(): BootObservation | undefined {
    return this.observation && { ...this.observation, errors: [...this.observation.errors] };
  }

  private persist(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.observation) + "\n");
      fs.renameSync(temp, this.file);
    } catch (error) {
      // The health response still carries the evidence when disk writing fails.
      process.stderr.write(`boot observation write failed: ${String(error)}\n`);
    }
  }
}

export const bootObserver = new BootObserver();
