import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { testSessionRouter } from "./helpers/session-fixture.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });
const channel = { platform: "google-chat", id: "session-home" };
const target = (thread: string) => ({ platform: "google-chat", id: `session-home.${thread}`, parentId: "session-home" });
const now = "2026-10-12T18:00:00.000Z";

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "gchat-root-fifo-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "seam.db"), store = new SessionStore(file);
  cleanups.push(() => store.close());
  const record = { id: "google-chat:stable-record", platform: "google-chat", channelRef: channel.id,
    parentRef: null, agentId: "codex", acpSessionId: "keep-acp", repoPath: "/projects", configJson: "{}", createdUtc: now, updatedUtc: now };
  store.upsert(record);
  const router = testSessionRouter({ ensureSessionRecord: () => record, listProfiles: () => [],
    isBusy: () => true, abortTurn: vi.fn(async () => "cancelled"),
    describeConfig: () => ({ agent: { value: "codex" }, model: { value: "default" },
      location: { value: "local" }, effort: { value: null }, cwd: { value: "/projects" } }) });
  const host = new Orchestrator({ store, router: router as any, modelCatalog: fixtureModelCatalog([]),
    logger: pino({ level: "silent" }) as any, adapter: {} as any, renderer: {} as any,
    config: { DATA_DIR: dir, REPOS_ROOT: "/projects", channelPresets: new Map(), threadPresets: new Map() } as any });
  Object.assign(host, { tryConsumeConfigEditorRiderUpload: async () => false, wouldParkForOfflineBridge: () => false,
    tryParkForOfflineBridge: async () => false, clearParkedForChannel: vi.fn(async () => null),
    clearTurnMarkersForChannel: vi.fn(async () => undefined), tryFireParked: async () => undefined,
    handleIncomingMessageInner: vi.fn(async () => undefined) });
  const input = (id: string, thread: string) => ({ messageId: id, channel, deliveryChannel: target(thread),
    preemptive: false, authorId: "42", authorName: "Tester", authorIsBot: false, text: `Prompt ${id}` });
  return { store, file, record, host, router, input };
}

describe("Space-root FIFO keeps per-prompt delivery across restart", () => {
  it("persists each queued prompt's own thread without replacing its predecessor", () => {
    const h = fixture();
    for (const [id, thread] of [["first", "A"], ["second", "B"]]) h.store.admitInbound({ ...h.input(id!, thread!),
      platform: "google-chat", channelRef: channel.id, sessionRecordId: h.record.id, createdUtc: now } as any);
    expect(h.store.listInboundNonterminal(channel.id)).toMatchObject([
      { messageId: "first", preemptive: false, deliveryChannel: target("A") },
      { messageId: "second", preemptive: false, deliveryChannel: target("B") },
    ]);
    const reopened = new SessionStore(h.file); cleanups.push(() => reopened.close());
    expect(reopened.getInbound("first")).toMatchObject({ deliveryChannel: target("A") });
    expect(reopened.getInbound("second")).toMatchObject({ deliveryChannel: target("B") });
    expect(reopened.get(h.record.id)?.acpSessionId).toBe("keep-acp");
  });

  it("does not cancel a live Space turn when another native thread queues a prompt", async () => {
    const h = fixture();
    (h.host as any).channelQueues.set(channel.id, Promise.resolve());
    await (h.host as any).handleIncomingMessage(h.input("queued", "B"));
    expect(h.router.abortTurn).not.toHaveBeenCalled();
    expect((h.host as any).clearTurnMarkersForChannel).not.toHaveBeenCalled();
    expect(h.store.getInbound("queued")).toMatchObject({ channelRef: channel.id, preemptive: false, deliveryChannel: target("B") });
  });

  it("restores a saved delivery target into the recovery message instead of replacing it with the root", () => {
    const h = fixture();
    h.store.admitInbound({ ...h.input("resume", "A"), platform: "google-chat", channelRef: channel.id,
      sessionRecordId: h.record.id, createdUtc: now } as any);
    const row = h.store.getInbound("resume")!;
    expect((h.host as any).inboundMessage(row)).toMatchObject({ channel, deliveryChannel: target("A"), preemptive: false });
  });

  it("recovers the FIFO head at boot without settling its queued successors as replacements", () => {
    const h = fixture();
    for (const [id, thread] of [["first", "A"], ["second", "B"]]) h.store.admitInbound({ ...h.input(id!, thread!),
      platform: "google-chat", channelRef: channel.id, sessionRecordId: h.record.id, createdUtc: now } as any);
    h.store.claimInbound("first", 0, now);
    expect(h.store.recoverInboundChannel(channel.id, now)).toMatchObject({ messageId: "first", deliveryChannel: target("A") });
    expect(h.store.getInbound("second")).toMatchObject({ state: "pending", deliveryChannel: target("B") });
    expect(h.store.listInboundNonterminal(channel.id).map(row => row.messageId)).toEqual(["first", "second"]);
  });

  it("keeps old admissions' delivery target equal to their original channel", () => {
    const h = fixture();
    h.store.admitInbound({ messageId: "legacy", platform: "discord", channelRef: "123", parentRef: "12",
      sessionRecordId: "discord:123", authorId: "42", text: "Old prompt", createdUtc: now });
    expect((h.host as any).inboundMessage(h.store.getInbound("legacy"))).toMatchObject({
      channel: { platform: "discord", id: "123", parentId: "12" } });
  });

  it("executes queued prompts from different threads serially with each prompt's own target", async () => {
    const h = fixture(); (h.router as any).isBusy = () => false;
    let release!: () => void, began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const seen: any[] = [];
    (h.host as any).handleIncomingMessageInner.mockImplementation(async (msg: any) => {
      (h.host as any).liveTurnByChannel.set(channel.id, `inbound-${msg.messageId}`);
      seen.push(h.host.deliveryForChannel(channel).channel);
      if (msg.messageId === "first") { began(); await held; }
      (h.host as any).liveTurnByChannel.delete(channel.id);
    });
    const first = (h.host as any).handleIncomingMessage(h.input("first", "A"));
    await started;
    const second = (h.host as any).handleIncomingMessage(h.input("second", "B"));
    await vi.waitFor(() => expect(h.store.getInbound("second")?.state).toBe("pending"));
    expect(seen).toEqual([target("A")]);
    release(); await Promise.all([first, second]);
    expect(seen).toEqual([target("A"), target("B")]);
    expect(h.router.abortTurn).not.toHaveBeenCalled();
    expect(h.store.get(h.record.id)?.acpSessionId).toBe("keep-acp");
  });

  it("reattached bridge output uses its own receipt and continuation does not change a queued prompt", () => {
    const h = fixture();
    for (const [id, thread] of [["first", "A"], ["second", "B"]]) h.store.admitInbound({ ...h.input(id!, thread!),
      platform: "google-chat", channelRef: channel.id, sessionRecordId: h.record.id, createdUtc: now } as any);
    h.store.turnAttempts.registerOwner("old-boot");
    const attempt = h.store.turnAttempts.claim({ id: "inbound-first", target: channel.id, prompt: "First", session: "live", kind: "handoff", createdUtc: now }, "codex@local", "old-boot", "inbound");
    h.store.turnAttempts.prepareStreamDelivery(attempt, target("A").id, "Saved fragment", 0);
    (h.host as any).adoptingRemoteResults.add(attempt.id);
    const route = h.host.deliveryForChannel(channel);
    expect(route.channel).toEqual(target("A"));
    route.continued!(channel);
    expect(h.store.getInbound("first")?.deliveryChannel).toEqual(channel);
    expect(h.store.turnAttempts.get(attempt.id)?.deliveryChannel).toBe(channel.id);
    expect(h.store.getInbound("second")?.deliveryChannel).toEqual(target("B"));
    expect(h.store.get(h.record.id)?.acpSessionId).toBe("keep-acp");
  });

  it("boot opens admission after queuing durable FIFO heads, without waiting for a model turn to finish", async () => {
    const h = fixture();
    for (const [id, thread] of [["first", "A"], ["second", "B"]]) h.store.admitInbound({ ...h.input(id!, thread!),
      platform: "google-chat", channelRef: channel.id, sessionRecordId: h.record.id, createdUtc: now } as any);
    Object.assign(h.host, { liveTurnInventory: async () => [], recoverInboundOutput: async () => {} });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), seen: string[] = [];
    (h.host as any).handleIncomingMessageInner.mockImplementation(async (msg: any) => {
      seen.push(msg.messageId); if (msg.messageId === "first") await held;
    });
    let ready = false;
    const boot = h.host.recoverInterruptedTurns().then(() => { ready = true; });
    try {
      await vi.waitFor(() => expect(seen).toEqual(["first"]));
      expect(ready).toBe(true);
      expect(h.store.getInbound("second")?.state).toBe("pending");
    } finally { release(); await boot; }
    await (h.host as any).queueOnChannel(channel.id, async () => {});
    expect(seen).toEqual(["first", "second"]);
  });

  it("leaves a queued prompt pending while a previously prompted human turn is suspended", async () => {
    const h = fixture();
    h.store.turnAttempts.registerOwner("old-boot");
    const attempt = h.store.turnAttempts.claim({ id: "inbound-first", target: channel.id, prompt: "First", session: "live", kind: "handoff", createdUtc: now }, "codex@local", "old-boot", "inbound");
    h.store.turnAttempts.bind(attempt, "keep-acp"); h.store.turnAttempts.startPrompt(attempt);
    h.store.turnAttempts.suspendBoot("old-boot");
    await (h.host as any).handleIncomingMessage(h.input("second", "B"));
    expect(h.store.getInbound("second")).toMatchObject({ state: "pending", deliveryChannel: target("B") });
    expect((h.host as any).handleIncomingMessageInner).not.toHaveBeenCalled();
    expect(h.router.abortTurn).not.toHaveBeenCalled();
  });
});
