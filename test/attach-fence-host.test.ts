import { testSessionRouter, testSessionStore } from "./helpers/session-fixture.js";
import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); });

function host(allowAny: boolean, hub: Record<string, unknown>, platform = "discord") {
  const dir = mkdtempSync(path.join(tmpdir(), "seam-attach-host-")); dirs.push(dir);
  const channel = { platform, id: "t1" };
  const store = testSessionStore({});
  const now = new Date().toISOString();
  const record = { id: `${platform}:t1`, platform, channelRef: channel.id, parentRef: null, agentId: "codex",
    acpSessionId: "saved-acp", repoPath: null, configJson: "{}", createdUtc: now, updatedUtc: now };
  store.upsert(record);
  const sent: Array<{ filename?: string; text?: string }> = [];
  const adapter = {
    sendFile: vi.fn(async (_c: unknown, f: { filename: string }) => { sent.push({ filename: f.filename }); }),
    sendMessage: vi.fn(async (_c: unknown, text: string) => { sent.push({ text }); }),
  };
  const self = new Orchestrator({
    logger: pino({ level: "silent" }) as any,
    config: { DATA_DIR: dir, ATTACH_ALLOW_ANY_PATH: allowAny, REPOS_ROOT: "/nonexistent-root", ATTACH_ROOTS: [],
      channelPresets: new Map(), threadPresets: new Map() } as any,
    adapter: adapter as any, store,
    router: testSessionRouter({ describeConfig: () => ({ location: { value: "rhc-server" } }) }),
    renderer: {} as any, modelCatalog: fixtureModelCatalog([]),
  });
  Object.assign(self, { effectiveCwd: () => "/home/ubuntu/Projects/pronoa", bridgeHub: hub });
  return { sent, adapter, self, store, record, channel,
    run: (p: string) => (self as any).emitAttachFence(channel, { content: p }, {}) };
}

describe("seam-attach fence on the thread's host", () => {
  it.each(["discord", "google-chat"])("honors ATTACH_ALLOW_ANY_PATH through the real %s delivery host", async platform => {
    const readHostFile = vi.fn(async () => ({ bytesBase64: Buffer.from("pdf").toString("base64"), filename: "a.pdf", size: 3 }));
    const readAttachmentForSession = vi.fn();
    const h = host(true, { sessionBridgeId: () => undefined, muxFor: () => ({}), readHostFile, readAttachmentForSession }, platform);
    await h.run("/tmp/allie_ortho/a.pdf");
    expect(readHostFile).toHaveBeenCalledWith("rhc-server", "/tmp/allie_ortho/a.pdf");
    expect(readAttachmentForSession).not.toHaveBeenCalled();
    expect(h.sent).toEqual([{ filename: "a.pdf" }]);
    expect(h.adapter.sendFile.mock.calls[0]![0]).toEqual(h.channel);
  });

  it.each(["discord", "google-chat"])("keeps %s workspace confinement and reports the real cause", async platform => {
    const readAttachmentForSession = vi.fn(async () => { throw new Error("path escapes workspace root: /tmp/x.pdf"); });
    const h = host(false, { sessionBridgeId: () => "rhc-server", muxFor: () => ({}), readHostFile: vi.fn(), readAttachmentForSession }, platform);
    await h.run("/tmp/x.pdf");
    expect(h.sent[0]!.text).toContain("path escapes workspace root");
  });

  it("uses the real resolver to deliver a Chat file to the executing prompt's native thread", async () => {
    const h = host(true, { sessionBridgeId: () => "rhc-server", muxFor: () => ({}),
      readHostFile: vi.fn(async () => ({ bytesBase64: Buffer.from("pdf").toString("base64"), filename: "a.pdf", size: 3 })) }, "google-chat");
    const deliveryChannel = { platform: "google-chat", id: "t1.topic", parentId: "t1" };
    h.store.admitInbound({ messageId: "file-prompt", platform: "google-chat", channelRef: h.channel.id,
      sessionRecordId: h.record.id, authorId: "42", text: "Attach the report", createdUtc: new Date().toISOString(),
      preemptive: false, deliveryChannel });
    (h.self as any).liveTurnByChannel.set(h.channel.id, "inbound-file-prompt");
    await h.run("/tmp/allie_ortho/a.pdf");
    expect(h.adapter.sendFile.mock.calls[0]![0]).toEqual(deliveryChannel);
    expect(h.sent).toEqual([{ filename: "a.pdf" }]);
    expect(h.store.get(h.record.id)).toMatchObject({ channelRef: h.channel.id, acpSessionId: "saved-acp" });
  });
});
