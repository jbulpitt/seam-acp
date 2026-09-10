import { readFileSync } from "node:fs";
import { hostname } from "node:os";

export interface ProcessOwner { host: string; boot: string; pid: number; start: string }
export function isProcessOwner(value: unknown): value is ProcessOwner {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<ProcessOwner>;
  return typeof p.host === "string" && p.host.length > 0
    && typeof p.boot === "string" && p.boot.length > 0
    && Number.isSafeInteger(p.pid) && p.pid! > 0
    && typeof p.start === "string" && /^\d+$/.test(p.start);
}
export function processOwner(pid = process.pid): ProcessOwner | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return { host: hostname(), boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      pid, start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]! };
  } catch { return null; }
}
/** Unknown host/access denial is NOT proof of death. PID reuse is distinguished
 * by kernel boot + process start ticks, without signals or probing providers. */
export function provenDead(owner: ProcessOwner): boolean {
  if (!isProcessOwner(owner)) return false;
  if (owner.host !== hostname()) return false;
  try {
    if (readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== owner.boot) return true;
  } catch { return false; }
  try {
    const stat = readFileSync(`/proc/${owner.pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] !== owner.start;
  } catch (err) { return (err as NodeJS.ErrnoException).code === "ENOENT"; }
}
