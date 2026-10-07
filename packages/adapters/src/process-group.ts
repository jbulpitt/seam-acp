import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

export interface ProcessIdentity {
  pid: number;
  pgid: number;
  started: string;
}

/** Kernel/ps identity, shared with the durable slot supervisor. */
export function readProcessIdentity(pid: number, includeExited = false): ProcessIdentity | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close === -1) return undefined;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      if (!includeExited && (fields[0] === "Z" || fields[0] === "X")) return undefined;
      const pgid = Number(fields[2]);
      const started = fields[19];
      if (!Number.isSafeInteger(pgid) || !started) return undefined;
      return { pid, pgid, started: `linux:${started}` };
    } catch { return undefined; }
  }
  try {
    const raw = execFileSync("/bin/ps", ["-p", String(pid), "-o", "pid=", "-o", "stat=", "-o", "pgid=", "-o", "lstart="], {
      encoding: "utf8", timeout: 1_000, maxBuffer: 8 * 1024, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const match = /^(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/.exec(raw);
    if (!match || Number(match[1]) !== pid || (!includeExited && match[2]!.startsWith("Z"))) return undefined;
    return { pid, pgid: Number(match[3]), started: match[4]!.trim().replace(/\s+/g, " ") };
  } catch { return undefined; }
}

/** A dead leader can still own tools; zombies cannot execute more work. */
export function ownedProcessGroupAlive(identity: ProcessIdentity): boolean {
  const leader = readProcessIdentity(identity.pid, true);
  if (leader && (leader.started !== identity.started || leader.pgid !== identity.pgid)) return false;
  try { process.kill(-identity.pgid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  if (process.platform === "linux") {
    return readdirSync("/proc").some(name => /^\d+$/.test(name) && readProcessIdentity(Number(name))?.pgid === identity.pgid);
  }
  const members = execFileSync("/bin/ps", ["-ax", "-o", "pgid=", "-o", "stat="], {
    encoding: "utf8", timeout: 1_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
  });
  return members.trim().split("\n").some(line => {
    const [pgid, state] = line.trim().split(/\s+/);
    return Number(pgid) === identity.pgid && !!state && !state.startsWith("Z");
  });
}

export type ProcessGroupOwnership = { type: "own_group" | "release_group"; identity: ProcessIdentity };
let owner: ((message: ProcessGroupOwnership) => void) | undefined;
const registered = new WeakMap<ChildProcess, ProcessIdentity>();

/** Only adapter-child installs this observer; ordinary adapter users stay unchanged. */
export function observeOwnedProcessGroups(observer: (message: ProcessGroupOwnership) => void): void {
  owner = observer;
}

export function registerOwnedProcessGroup(child: ChildProcess): void {
  if (!owner || child.pid === undefined || registered.has(child)) return;
  const identity = readProcessIdentity(child.pid, true);
  if (!identity || identity.pgid !== child.pid) return;
  registered.set(child, identity);
  owner({ type: "own_group", identity });
}

export function registeredProcessGroup(child: ChildProcess): ProcessIdentity | undefined {
  return registered.get(child);
}

/** Release only after the group's existing reap has succeeded, not on leader exit. */
export function releaseOwnedProcessGroup(child: ChildProcess): void {
  const identity = registered.get(child);
  if (!identity) return;
  owner?.({ type: "release_group", identity });
  registered.delete(child);
}
