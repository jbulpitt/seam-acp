import fsp from "node:fs/promises";

/**
 * Evidence for "is this agent hung?", collected where the child process is (#443).
 *
 * seam-acp can see that a turn has gone quiet. It cannot see whether the
 * process's event loop is still scheduling, and it cannot see that process's
 * TCP sockets. Both of those are on this host. A command timeout on the
 * websocket is the link failing, which is a different fact — callers must not
 * read it as "the child did not answer".
 *
 * The probe is one unknown JSON-RPC method (`seam/hangProbe`). ACP has no
 * ping, and every real session method can change the session. Checked
 * against the shipped agents, not against the spec: `claude-agent-acp`,
 * `codex-acp`, and `grok agent stdio` each wrote a -32601 response for this
 * method. agy does not speak ACP; the child this probe writes to is the
 * seam adapter, and its AgentSideConnection answers an unhandled request
 * with methodNotFound. A runtime that never produces such a response is
 * not restarted for it — seam-acp treats that as an unsupported probe.
 */

export const HANG_PROBE_METHOD = "seam/hangProbe";
export const HANG_PROBE_TIMEOUT_MS = 3_000;
const SOCKET_SAMPLE_GAP_MS = 200;

export interface HangProbeReport {
  /** What the child itself did with the probe. `closed` means the process
   *  exited while we were waiting — death already has an owner. */
  probe: "answered" | "unanswered" | "closed";
  /** Kernel view of this pid's TCP sockets. `unavailable` is "could not
   *  tell", never "fine" and never "stuck". */
  providerSocket: "progressing" | "not_progressing" | "unavailable";
}

export function probeRequestLine(id: string): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method: HANG_PROBE_METHOD, params: {} })}\n`;
}

/**
 * A response to OUR id, and not a request that happens to carry the same id.
 * Anything else is the agent's own traffic and must be forwarded untouched.
 */
export function isProbeResponse(line: string, id: string): boolean {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return false;
  }
  if (!message || typeof message !== "object") return false;
  const record = message as { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
  if (record.id !== id) return false;
  if (typeof record.method === "string") return false;
  return "result" in record || "error" in record;
}

interface ArmedProbe {
  id: string;
  settle: (value: "answered" | "closed") => void;
}

/**
 * One in-flight probe per slot. The response is removed from the forwarded
 * stdout so the ACP client does not treat method-not-found as a turn error.
 * A late response, after the waiter has given up, is still absorbed: the id
 * is unique, so this cannot swallow a real message.
 */
export function createProbeGate() {
  const pending = new Map<number, ArmedProbe>();
  return {
    arm(slot: number, id: string): Promise<"answered" | "closed"> {
      pending.get(slot)?.settle("closed");
      let settle!: (value: "answered" | "closed") => void;
      const done = new Promise<"answered" | "closed">((resolve) => {
        settle = resolve;
      });
      let settled = false;
      const once = (value: "answered" | "closed") => {
        if (settled) return;
        settled = true;
        if (pending.get(slot)?.id === id) pending.delete(slot);
        settle(value);
      };
      pending.set(slot, { id, settle: once });
      return done;
    },
    /** True when this line was the probe response and must not be forwarded. */
    absorb(slot: number, line: string): boolean {
      const probe = pending.get(slot);
      if (!probe || !isProbeResponse(line, probe.id)) return false;
      probe.settle("answered");
      return true;
    },
    close(slot: number): void {
      pending.get(slot)?.settle("closed");
    },
  };
}

export async function collectHangEvidence(opts: {
  id: string;
  writeLine: (line: string) => void;
  response: Promise<"answered" | "closed">;
  timeoutMs?: number;
  sockets: () => Promise<HangProbeReport["providerSocket"]>;
}): Promise<HangProbeReport> {
  opts.writeLine(probeRequestLine(opts.id));
  const timeoutMs = opts.timeoutMs ?? HANG_PROBE_TIMEOUT_MS;
  const outcome = await new Promise<"answered" | "unanswered" | "closed">((resolve) => {
    const timer = setTimeout(() => resolve("unanswered"), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    opts.response.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, () => {
      clearTimeout(timer);
      resolve("closed");
    });
  });
  if (outcome !== "answered") {
    return {
      probe: outcome === "closed" ? "closed" : "unanswered",
      providerSocket: "unavailable",
    };
  }
  return { probe: "answered", providerSocket: await opts.sockets() };
}

interface TcpSocket {
  state: number;
  tx: number;
  retr: number;
}

/**
 * Two samples of THIS pid's TCP sockets. A send queue that does not shrink
 * while the retransmission count climbs is the kernel saying the peer is not
 * accepting data. A queue of zero is a process waiting, which is what a
 * healthy long tool call looks like — not a hang. No sockets, or any host
 * that is not Linux, is `unavailable`.
 */
export function readLiveProviderSocket(pid: number | undefined): Promise<HangProbeReport["providerSocket"]> {
  if (pid === undefined || !Number.isInteger(pid) || pid < 2) return Promise.resolve("unavailable");
  return providerSocketProgress({
    pid,
    platform: process.platform,
    readFile: (file) => fsp.readFile(file, "utf8"),
    readdir: (file) => fsp.readdir(file),
    readlink: (file) => fsp.readlink(file),
    sleep: (ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      if (typeof timer.unref === "function") timer.unref();
    }),
  });
}

export async function providerSocketProgress(opts: {
  pid: number;
  platform: NodeJS.Platform;
  readFile: (path: string) => Promise<string>;
  readdir: (path: string) => Promise<string[]>;
  readlink: (path: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  gapMs?: number;
}): Promise<HangProbeReport["providerSocket"]> {
  if (opts.platform !== "linux" || !Number.isInteger(opts.pid) || opts.pid < 2) return "unavailable";
  const first = await sampleSockets(opts);
  if (!first) return "unavailable";
  await opts.sleep(opts.gapMs ?? SOCKET_SAMPLE_GAP_MS);
  const second = await sampleSockets(opts);
  if (!second) return "unavailable";
  let sawEstablished = false;
  for (const [inode, next] of second) {
    if (next.state !== 1) continue;
    sawEstablished = true;
    const prev = first.get(inode);
    if (!prev || prev.state !== 1) continue;
    if (next.tx > 0 && next.retr > prev.retr && next.tx >= prev.tx) return "not_progressing";
  }
  return sawEstablished ? "progressing" : "unavailable";
}

async function sampleSockets(opts: {
  pid: number;
  readFile: (path: string) => Promise<string>;
  readdir: (path: string) => Promise<string[]>;
  readlink: (path: string) => Promise<string>;
}): Promise<Map<string, TcpSocket> | null> {
  let fds: string[];
  try {
    fds = await opts.readdir(`/proc/${opts.pid}/fd`);
  } catch {
    return null;
  }
  const inodes = new Set<string>();
  for (const fd of fds) {
    if (!/^\d+$/.test(fd)) continue;
    try {
      const target = await opts.readlink(`/proc/${opts.pid}/fd/${fd}`);
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match) inodes.add(match[1]!);
    } catch {
      // A fd can vanish between readdir and readlink. It is not evidence.
    }
  }
  if (inodes.size === 0) return new Map();
  const tables = await Promise.all(
    ["/proc/net/tcp", "/proc/net/tcp6"].map((file) => opts.readFile(file).catch(() => "")),
  );
  const sockets = new Map<string, TcpSocket>();
  for (const table of tables) {
    for (const [inode, socket] of parseTcpTable(table)) {
      if (inodes.has(inode)) sockets.set(inode, socket);
    }
  }
  return sockets;
}

export function parseTcpTable(text: string): Map<string, TcpSocket> {
  const sockets = new Map<string, TcpSocket>();
  for (const raw of text.split("\n")) {
    const parts = raw.trim().split(/\s+/);
    if (!/^\d+:$/.test(parts[0] ?? "")) continue;
    const queues = (parts[4] ?? "").split(":");
    const timer = (parts[5] ?? "").split(":");
    const inode = parts[9];
    if (!inode || !/^\d+$/.test(inode) || queues.length < 2 || timer.length < 2) continue;
    sockets.set(inode, {
      state: Number.parseInt(parts[3] ?? "", 16),
      tx: Number.parseInt(queues[0] ?? "", 16),
      retr: Number.parseInt(parts[6] ?? "", 16),
    });
  }
  return sockets;
}
