/**
 * #443 — the child process is the evidence. Silence is not.
 *
 * Deleting the distinctions below is the bug: a wedged event loop looks like
 * a thinking model, a dead provider socket looks like a healthy wait, and
 * "could not read /proc" looks like a reason to restart the turn.
 */
import { describe, expect, it } from "vitest";
import {
  collectHangEvidence,
  createProbeGate,
  isProbeResponse,
  parseTcpTable,
  probeRequestLine,
  providerSocketProgress,
  HANG_PROBE_METHOD,
} from "../packages/bridge/src/hang-probe.js";
import { decideHang, readHangProbeReport, watchRemoteHang } from "../packages/core/src/agents/hang-watch.js";

const ID = "probe-id-1";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe("#443 probe line is side-effect-free and recognizable", () => {
  it("asks for an unknown method and nothing else", () => {
    const line = probeRequestLine(ID);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: ID, method: HANG_PROBE_METHOD, params: {} });
    expect(line).not.toContain("session/");
  });

  it("recognizes only a response to this id", () => {
    const found = JSON.stringify({ jsonrpc: "2.0", id: ID, error: { code: -32601, message: "Method not found" } });
    const result = JSON.stringify({ jsonrpc: "2.0", id: ID, result: null });
    expect(isProbeResponse(found, ID)).toBe(true);
    expect(isProbeResponse(result, ID)).toBe(true);
    // A request that echoes the id is the agent's own traffic.
    expect(isProbeResponse(JSON.stringify({ jsonrpc: "2.0", id: ID, method: "session/update", params: {} }), ID)).toBe(false);
    expect(isProbeResponse(JSON.stringify({ jsonrpc: "2.0", id: "other", error: { code: -32601 } }), ID)).toBe(false);
    expect(isProbeResponse("not json", ID)).toBe(false);
    expect(isProbeResponse(JSON.stringify({ id: ID }), ID)).toBe(false);
  });

  it("forwards real stdout and absorbs only the probe response", async () => {
    const gate = createProbeGate();
    const waited = gate.arm(1, ID);
    const real = `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { text: "still working" } })}\n`;
    expect(gate.absorb(1, real)).toBe(false);
    expect(gate.absorb(1, JSON.stringify({ jsonrpc: "2.0", id: ID, error: { code: -32601, message: "Method not found" } }))).toBe(true);
    await expect(waited).resolves.toBe("answered");
    // Once absorbed, a later copy of the same id is ordinary output again
    // only if a new probe is not armed. The line must not stay swallowed.
    expect(gate.absorb(1, JSON.stringify({ jsonrpc: "2.0", id: ID, error: { code: -32601 } }))).toBe(false);
  });
});

describe("#443 what the bridge measured", () => {
  it("reports unanswered when the child writes nothing", async () => {
    const { promise } = deferred<"answered" | "closed">();
    const written: string[] = [];
    const report = await collectHangEvidence({
      id: ID,
      writeLine: (line) => written.push(line),
      response: promise,
      timeoutMs: 15,
      sockets: async () => "progressing",
    });
    expect(written).toEqual([probeRequestLine(ID)]);
    expect(report).toEqual({ probe: "unanswered", providerSocket: "unavailable" });
  });

  it("does not consult sockets when the process exits first", async () => {
    const { promise, resolve } = deferred<"answered" | "closed">();
    let sockets = 0;
    const pending = collectHangEvidence({
      id: ID,
      writeLine: () => {},
      response: promise,
      timeoutMs: 5_000,
      sockets: async () => { sockets += 1; return "not_progressing"; },
    });
    resolve("closed");
    await expect(pending).resolves.toEqual({ probe: "closed", providerSocket: "unavailable" });
    expect(sockets).toBe(0);
  });

  it("reads sockets only after the event loop answers", async () => {
    const { promise, resolve } = deferred<"answered" | "closed">();
    const pending = collectHangEvidence({
      id: ID,
      writeLine: () => {},
      response: promise,
      timeoutMs: 5_000,
      sockets: async () => "not_progressing",
    });
    resolve("answered");
    await expect(pending).resolves.toEqual({ probe: "answered", providerSocket: "not_progressing" });
  });
});

const TCP_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

function tcpRow(inode: number, tx: number, retr: number, state = "01"): string {
  const txHex = tx.toString(16).padStart(8, "0").toUpperCase();
  const retrHex = retr.toString(16).padStart(8, "0");
  return `   0: 0100007F:0CEA 08080808:01BB ${state} ${txHex}:00000000 01:00000014 ${retrHex}  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
}

describe("#443 provider socket progress is the kernel's fact", () => {
  it("parses a real /proc/net/tcp row", () => {
    const sockets = parseTcpTable(`${TCP_HEADER}${tcpRow(99999, 0x100, 2)}\n`);
    expect(sockets.get("99999")).toEqual({ state: 1, tx: 0x100, retr: 2 });
  });

  it("is not_progressing only when retransmits climb and the send queue does not drain", async () => {
    const samples = [
      `${TCP_HEADER}${tcpRow(99999, 0x100, 2)}\n${tcpRow(12345, 0, 0)}\n`,
      `${TCP_HEADER}${tcpRow(99999, 0x100, 3)}\n${tcpRow(12345, 0, 0)}\n`,
    ];
    let n = 0;
    const progress = await providerSocketProgress({
      pid: 42,
      platform: "linux",
      readFile: async () => samples[Math.min(n, samples.length - 1)]!,
      readdir: async () => ["3", "4"],
      readlink: async (file) => file.endsWith("/3") ? "socket:[99999]" : "socket:[12345]",
      sleep: async () => { n += 1; },
    });
    expect(progress).toBe("not_progressing");
  });

  it("treats a drained queue as a healthy wait, including when another socket is stuck for a different pid", async () => {
    const table = `${TCP_HEADER}${tcpRow(12345, 0, 0)}\n${tcpRow(99999, 0x100, 5)}\n`;
    const progress = await providerSocketProgress({
      pid: 42,
      platform: "linux",
      readFile: async () => table,
      readdir: async () => ["3"],
      readlink: async () => "socket:[12345]",
      sleep: async () => {},
    });
    expect(progress).toBe("progressing");
  });

  it("is unavailable off Linux, without a pid we can read, or with no TCP sockets", async () => {
    expect(await providerSocketProgress({
      pid: 42, platform: "darwin",
      readFile: async () => { throw new Error("should not read"); },
      readdir: async () => { throw new Error("should not read"); },
      readlink: async () => { throw new Error("should not read"); },
      sleep: async () => {},
    })).toBe("unavailable");
    expect(await providerSocketProgress({
      pid: 42, platform: "linux",
      readFile: async () => TCP_HEADER,
      readdir: async () => { throw new Error("ENOENT"); },
      readlink: async () => "",
      sleep: async () => {},
    })).toBe("unavailable");
    expect(await providerSocketProgress({
      pid: 42, platform: "linux",
      readFile: async () => TCP_HEADER,
      readdir: async () => ["1"],
      readlink: async () => "/dev/null",
      sleep: async () => {},
    })).toBe("unavailable");
  });
});

describe("#443 seam-acp decides from the report and from nothing else", () => {
  it("restarts only an unanswered event loop", () => {
    expect(decideHang({ probe: "unanswered", providerSocket: "unavailable" })).toBe("restart");
    expect(decideHang({ probe: "unanswered", providerSocket: "progressing" })).toBe("restart");
  });

  it("retries only when the kernel says the peer stopped taking data", () => {
    expect(decideHang({ probe: "answered", providerSocket: "not_progressing" })).toBe("retry");
  });

  it("leaves a working turn, a closed process, and anything it could not measure", () => {
    expect(decideHang({ probe: "answered", providerSocket: "progressing" })).toBe("leave");
    expect(decideHang({ probe: "answered", providerSocket: "unavailable" })).toBe("leave");
    expect(decideHang({ probe: "closed", providerSocket: "not_progressing" })).toBe("leave");
    expect(decideHang(null)).toBe("leave");
    expect(readHangProbeReport({ probe: "answered" })).toBeNull();
    expect(readHangProbeReport({ probe: "wedged", providerSocket: "unavailable" })).toBeNull();
    expect(readHangProbeReport(null)).toBeNull();
  });

  it("does not probe until the turn has been quiet, and stops when the turn ends", async () => {
    let activity = 0;
    let probes = 0;
    const ac = new AbortController();
    const watch = watchRemoteHang({
      silenceMs: 50,
      signal: ac.signal,
      now: () => activity,
      lastActivityAt: () => 0,
      inFlight: () => true,
      sleep: async (ms, signal) => {
        activity += ms;
        if (signal.aborted) return;
      },
      probe: async () => {
        probes += 1;
        ac.abort();
        return { probe: "answered", providerSocket: "progressing" };
      },
    });
    await watch;
    expect(probes).toBe(1);
    expect(activity).toBeGreaterThanOrEqual(50);
  });

  it("restarts when the bridge says the event loop did not answer, and keeps watching a retry", async () => {
    const ac = new AbortController();
    const actions: string[] = [];
    await watchRemoteHang({
      silenceMs: 10,
      signal: ac.signal,
      now: () => 10,
      lastActivityAt: () => 0,
      inFlight: () => !ac.signal.aborted,
      sleep: async () => {},
      probe: async () => actions.length === 0
        ? { probe: "answered", providerSocket: "not_progressing" }
        : { probe: "unanswered", providerSocket: "unavailable" },
      onAction: (action) => {
        actions.push(action);
        if (action === "restart") ac.abort();
      },
    });
    expect(actions).toEqual(["retry", "restart"]);
  });
});
