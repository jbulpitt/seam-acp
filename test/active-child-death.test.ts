import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { savedSessionHost, SAVED_SESSION } from "./helpers/saved-session-recovery.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function activeInbound() {
  const host = await savedSessionHost();
  cleanups.push(() => host.close());
  const router = host.makeRouter();
  const orch = host.makeOrchestrator(router);
  const internal = orch as any;
  Object.assign(internal.config, { TURN_TIMEOUT_SECONDS: 60, SEAM_TURN_RESUME_ENABLED: true });
  const panels: unknown[] = [];
  Object.assign(internal.adapter, {
    sendPanel: async (channel: unknown, panel: unknown) => {
      panels.push(panel); return { channel, id: "working-card" };
    },
    editPanel: async (_ref: unknown, panel: unknown) => { panels.push(panel); },
  });
  await orch.loadPlugins();
  const now = new Date().toISOString();
  const message = { messageId: "638-child-death", channel: { platform: "discord", id: host.record.channelRef },
    authorId: "fixture-user", authorName: "Fixture", authorIsBot: false,
    text: "ORIGINAL-BRIEF-DO-NOT-REPLAY" };
  host.store.admitInbound({ ...message, platform: "discord", channelRef: host.record.channelRef,
    parentRef: null, sessionRecordId: host.record.id, attachments: [], createdUtc: now });
  host.store.claimInbound(message.messageId, 0, now);
  const id = `inbound-${message.messageId}`;
  const run = internal.handleIncomingMessageInner(message) as Promise<void>;
  await vi.waitFor(() => expect(host.store.turnAttempts.get(id)).toMatchObject({
    state: "active", promptStarted: true, remoteRecovery: { acpSessionId: SAVED_SESSION },
  }), { timeout: 10_000 });
  await vi.waitFor(async () => expect((await host.requests())
    .filter(row => row.method === "session/prompt")).toHaveLength(1), { timeout: 10_000 });
  const pids = () => fs.readFile(path.join(host.root, "agent.pids"), "utf8")
    .then(text => text.trim().split("\n").map(Number));
  const [pid] = await pids();
  return { host, router, orch, internal, id, run, pid, pids, panels };
}

describe("active owned child death through sessiond and adapter-child", () => {
  it("recovers the active inbound turn in the same ACP session instead of finalizing failure", async () => {
    const h = await activeInbound();
    // Only the fake ACP agent launched by this test's private sessiond is killed.
    process.kill(h.pid!, "SIGKILL");
    await h.run;
    await vi.waitFor(() => expect(h.host.store.turnAttempts.get(h.id)).toMatchObject({
      state: "completed", acpSessionId: SAVED_SESSION, outcome: { status: "completed", stopReason: "end_turn" },
    }), { timeout: 15_000 });
    const requests = await h.host.requests();
    const prompts = requests.filter(row => row.method === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[0].params.prompt[0].text).toContain("ORIGINAL-BRIEF-DO-NOT-REPLAY");
    expect(prompts[1].params.prompt[0].text).toMatch(/^continue\b/);
    expect(prompts[1].params.prompt[0].text).not.toContain("ORIGINAL-BRIEF-DO-NOT-REPLAY");
    expect(prompts.map(row => row.params.sessionId)).toEqual([SAVED_SESSION, SAVED_SESSION]);
    expect(requests.filter(row => row.method === "session/load")
      .map(row => row.params.sessionId)).toEqual([SAVED_SESSION, SAVED_SESSION]);
    expect(requests.filter(row => row.method === "session/new")).toEqual([]);
    expect(await h.pids()).toHaveLength(2);
    expect(JSON.stringify(h.panels)).not.toContain('"Failed"');
    expect(h.host.notices.some(notice => notice.text.includes("turn failed"))).toBe(false);
    expect(h.host.notices.some(notice => notice.text.includes("resumed ok"))).toBe(true);
  }, 30_000);
});
