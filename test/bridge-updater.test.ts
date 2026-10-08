import { describe, expect, it, vi } from "vitest";
import { createBridgeUpdater, type BridgeReleaseFacts } from "../packages/core/src/core/bridge-updater.js";

function fixture(rollout = vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined)) {
  const bridges = new Map<string, BridgeReleaseFacts>([
    ["old", { releaseSha: "old", sessiond: { releaseSha: "old" } }],
    ["current", { releaseSha: "new", sessiond: { releaseSha: "new" } }],
    ["stale-daemon", { releaseSha: "new", sessiond: { releaseSha: "old" } }],
    ["newer", { releaseSha: "future", sessiond: { releaseSha: "future" } }],
  ]);
  const report = vi.fn();
  const updater = createBridgeUpdater({
    currentSha: "new", get: id => bridges.get(id),
    managed: id => id === "unmapped" ? "no managed target" : undefined,
    older: async sha => sha === "old", rollout, report,
  });
  return { ...updater, bridges, report, rollout };
}

describe("bridge connect rollout", () => {
  it("updates an old bridge and a current bridge with a stale daemon, but leaves current/newer alone", async () => {
    const f = fixture();
    for (const id of ["old", "current", "stale-daemon", "newer", "unmapped"]) f.onReady(id);
    await f.idle();
    expect(f.rollout.mock.calls).toEqual([["old"], ["stale-daemon"]]);
    expect(f.report).toHaveBeenCalledWith("unmapped", "skipped: no managed target");
    expect(f.report).toHaveBeenCalledWith("newer", "skipped: bridge release is not older than the controller");
  });

  it("serializes hosts and does not start another rollout when the updating bridge reconnects", async () => {
    let finish!: () => void;
    const rollout = vi.fn<(id: string) => Promise<void>>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(undefined);
    const f = fixture(rollout);
    f.onReady("old"); f.onReady("old"); f.onReady("stale-daemon");
    await vi.waitFor(() => expect(rollout).toHaveBeenCalledTimes(1));
    f.onReady("old");
    finish(); await f.idle();
    expect(rollout.mock.calls).toEqual([["old"], ["stale-daemon"]]);
  });

  it("reports the real failure and tries again at the next connection", async () => {
    const error = new Error("ssh: connection reset by peer");
    const f = fixture(vi.fn<(id: string) => Promise<void>>().mockRejectedValueOnce(error).mockResolvedValue(undefined));
    f.onReady("old"); await f.idle();
    expect(f.report).toHaveBeenCalledWith("old", "failed; retry on next connection", error);
    f.onReady("old"); await f.idle();
    expect(f.rollout).toHaveBeenCalledTimes(2);
  });
});
