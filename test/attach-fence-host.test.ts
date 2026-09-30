import { describe, it, expect, vi } from "vitest";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";

const silent = { info() {}, warn() {}, debug() {}, error() {}, child() { return silent; } };

function host(allowAny: boolean, hub: Record<string, unknown>) {
  const sent: Array<{ filename?: string; text?: string }> = [];
  const self = {
    logger: silent,
    config: { ATTACH_ALLOW_ANY_PATH: allowAny, REPOS_ROOT: "/nonexistent-root", ATTACH_ROOTS: [] },
    adapter: {
      sendFile: vi.fn(async (_c: unknown, f: { filename: string }) => { sent.push({ filename: f.filename }); }),
      sendMessage: vi.fn(async (_c: unknown, text: string) => { sent.push({ text }); }),
    },
    store: { getByChannel: () => ({ id: "discord:t1", channelRef: "t1" }) },
    router: { describeConfig: () => ({ location: { value: "rhc-server" } }) },
    effectiveCwd: () => "/home/ubuntu/Projects/pronoa",
    bridgeHub: hub,
  };
  const emit = (Orchestrator.prototype as unknown as {
    emitAttachFence(this: unknown, c: unknown, f: unknown, o: unknown): Promise<void>;
  }).emitAttachFence;
  return { sent, run: (p: string) => emit.call(self, { platform: "discord", id: "t1" }, { content: p }, {}) };
}

describe("seam-attach fence on the thread's host", () => {
  it("honors ATTACH_ALLOW_ANY_PATH for a path outside the host workspace", async () => {
    const readHostFile = vi.fn(async () => ({ bytesBase64: Buffer.from("pdf").toString("base64"), filename: "a.pdf", size: 3 }));
    const readAttachmentForSession = vi.fn();
    const h = host(true, { sessionBridgeId: () => undefined, muxFor: () => ({}), readHostFile, readAttachmentForSession });
    await h.run("/tmp/allie_ortho/a.pdf");
    expect(readHostFile).toHaveBeenCalledWith("rhc-server", "/tmp/allie_ortho/a.pdf");
    expect(readAttachmentForSession).not.toHaveBeenCalled();
    expect(h.sent).toEqual([{ filename: "a.pdf" }]);
  });

  it("keeps workspace confinement when the flag is off and reports the real cause", async () => {
    const readAttachmentForSession = vi.fn(async () => { throw new Error("path escapes workspace root: /tmp/x.pdf"); });
    const h = host(false, { sessionBridgeId: () => "rhc-server", muxFor: () => ({}), readHostFile: vi.fn(), readAttachmentForSession });
    await h.run("/tmp/x.pdf");
    expect(h.sent[0]!.text).toContain("path escapes workspace root");
  });
});
