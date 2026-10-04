import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { SessiondServer } from "../packages/bridge/src/sessiond-server.js";
import { SessiondClient } from "../packages/bridge/src/sessiond-client.js";
import { SupervisedSlots, type SupervisedBridgeFrame } from "../packages/bridge/src/supervised-slots.js";
import { ActionCardManager } from "../packages/core/src/core/action-cards/manager.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { namingFixture } from "./plugin-naming-fixture.js";
import type { ComponentEvent, ElicitationCardPost } from "../packages/core/src/platforms/chat-adapter.js";

const logger = pino({ level: "silent" });
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const until = async (predicate: () => boolean) => { await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 10_000, interval: 20 }); };
const event = (customId: string, messageId: string, channel = "thread", userId = "admin") => ({
  customId, messageId, channel: { platform: "discord", id: channel, parentId: "100000000000000001" }, userId, userName: userId,
  interactionId: `${customId}-${Math.random()}`, kind: "button", deferUpdate: vi.fn(async () => {}),
  replyEphemeral: vi.fn(async () => {}), followUpEphemeral: vi.fn(async () => {}),
} as unknown as ComponentEvent);

describe("durable action cards", () => {
  it.each(["selected", "expired"])("%s: answers the same request through real sessiond and adapter-child after replacing the controller", async mode => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-permission-"));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const executable = path.join(root, "permission-agent");
    fs.copyFileSync(fileURLToPath(new URL("./fixtures/pending-permission-agent.mjs", import.meta.url)), executable);
    fs.chmodSync(executable, 0o755);
    const socketPath = path.join(root, "sessiond.sock");
    const server = new SessiondServer({ socketPath, statePath: path.join(root, "slots.json") });
    await server.start(); cleanups.push(() => server.close({ terminateChildren: true }));
    const client = await SessiondClient.connect(socketPath); cleanups.push(() => client.close());
    const frames: SupervisedBridgeFrame[] = [];
    let stderr = "";
    const slots = new SupervisedSlots({ client, copilotCmd: executable, localCwd: root,
      adapterChildPath: fileURLToPath(new URL("./helpers/adapter-child-source.mjs", import.meta.url)),
      environment: { PATH: process.env.PATH }, onStderr: (_slot, bytes) => { stderr += bytes.toString(); }, onFrame: frame => frames.push(frame) });
    slots.configure(1, { agentId: "copilot", cwd: root });
    const input = async (frame: unknown) => slots.writeInput(1, `${JSON.stringify({ jsonrpc: "2.0", ...frame as object })}\n`);
    await input({ id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await until(() => {
      const exit = frames.find(frame => frame.type === "exit");
      if (exit) throw new Error(`${exit.spawnError ?? "fixture agent exited"}: ${stderr}`);
      return frames.some(frame => frame.data?.includes('"id":1'));
    });
    await input({ id: 2, method: "session/new", params: { cwd: root, mcpServers: [] } });
    await until(() => frames.some(frame => frame.data?.includes("retained-session")));
    await input({ id: 3, method: "session/prompt", params: { sessionId: "retained-session", prompt: [] } });
    await until(() => frames.some(frame => frame.data?.includes("session/request_permission")));
    const request = JSON.parse(frames.find(frame => frame.data?.includes("session/request_permission"))!.data!).params;
    const database = path.join(root, "seam.db");
    const session = { id: "discord:thread", platform: "discord", channelRef: "thread" } as never;
    const cards: ElicitationCardPost[] = [];
    const edit = vi.fn(async () => {});
    let store = new SessionStore(database);
    const create = () => new ActionCardManager({ store: store.actionCards, logger,
      adapter: { sendElicitationCard: async (_channel, card) => { cards.push(card); return { channel: { platform: "discord", id: "thread" }, id: "permission-card" }; }, editElicitationCard: edit } as never,
      binding: () => ({ attemptId: "attempt", location: "local", slot: 1 }), isAttemptOpen: () => true,
      owner: (row, response) => slots.permissionControl(row.slot, response ? "answer_permission" : "permission_status",
        { requestId: row.requestId, sessionId: row.acpSessionId, toolCallId: row.request.toolCall.toolCallId, ...(row.ownerPid ? { ownerPid: row.ownerPid } : {}) }, response),
      apply: () => { throw new Error("not a proposal"); }, afterApply: async () => {},
    });
    const old = create(); void old.requestPermission(session, request, "original-request");
    await until(() => cards.length === 1);
    const record = store.actionCards.permissions()[0]!;
    old.detach(); store.close();
    store = new SessionStore(database); cleanups.push(() => store.close());
    const restarted = create(); cleanups.push(() => restarted.detach());
    const clock = mode === "expired" ? vi.spyOn(Date, "now").mockReturnValue(Date.parse(record.expiresUtc) + 1) : undefined;
    await restarted.recover();
    clock?.mockRestore();
    expect(cards).toHaveLength(1);
    await restarted.handlePermission(event(cards[0]!.buttons![0]!.customId!, "permission-card"));
    await until(() => frames.some(frame => frame.data?.includes('"stopReason":"end_turn"')));
    expect(store.actionCards.getPermission(record.id)).toMatchObject({ status: mode === "selected" ? "answered" : "expired", delivered: true, ownerPid: record.ownerPid,
      response: mode === "selected" ? { outcome: { outcome: "selected", optionId: "allow" } } : { outcome: { outcome: "cancelled" } } });
    await restarted.handlePermission(event(cards[0]!.buttons![0]!.customId!, "permission-card"));
    await input({ id: "original-request", result: { outcome: { outcome: "selected", optionId: "allow" } } });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(frames.filter(frame => frame.data?.includes('"sessionUpdate":"agent_message_chunk"'))).toHaveLength(1);
    expect(edit.mock.calls.at(-1)?.[1].buttons).toEqual([]);
    await expect(slots.permissionControl(999, "permission_status", { requestId: 1, sessionId: "none", toolCallId: "none" })).resolves.toMatchObject({ state: "gone" });
  }, 20_000);

  it("rebuilds an audited proposal from persisted data and applies it once after restart", async () => {
    const first = await namingFixture();
    const session = await first.create();
    const sent: ElicitationCardPost[] = [];
    const configure = (fixture: Awaited<ReturnType<typeof namingFixture>>) => {
      Object.assign((fixture.orchestrator as any).adapter, {
        sendElicitationCard: async (_: unknown, card: ElicitationCardPost) => { sent.push(card); return { channel: { platform: "discord", id: "thread" }, id: "proposal-card" }; },
        editElicitationCard: vi.fn(async () => {}), sendMessage: vi.fn(async () => ({})),
      });
    };
    configure(first);
    expect(await first.orchestrator.proposeConfig(session, { session: { role: "proof" } })).toMatchObject({ ok: true });
    const stored = first.store.actionCards.proposals()[0]!;
    expect(JSON.stringify(stored)).not.toContain('"apply"');
    (first.orchestrator as any).actionCards.detach();
    await first.host.dispose(); first.store.close();
    const store = new SessionStore(path.join(first.directory, "seam.db"));
    const restarted = await namingFixture({ directory: first.directory, store });
    configure(restarted);
    cleanups.push(async () => { (restarted.orchestrator as any).actionCards.detach(); await restarted.close(); store.close(); fs.rmSync(first.directory, { recursive: true, force: true }); });
    await restarted.orchestrator.recoverElicitations();
    const click = event(sent[0]!.buttons![0]!.customId!, "proposal-card");
    await restarted.component(click);
    await restarted.component(click);
    expect(store.readConfig(store.get(session.id)!).role).toBe("proof");
    expect(store.actionCards.getProposal(stored.id)).toMatchObject({ status: "applied", auditId: expect.any(String) });
    expect(store.listConfigMutations()).toHaveLength(1);
  });

  it.each([
    { admins: new Set(["admin"]), participant: undefined, user: "other", applied: false },
    { admins: undefined, participant: undefined, user: "other", applied: true },
    { admins: undefined, participant: "other", user: "other", applied: false },
    { admins: new Set(["admin"]), participant: "admin", user: "admin", applied: true },
  ])("preserves the config Apply gate: %j", async options => {
    const fixture = await namingFixture(options);
    cleanups.push(async () => { (fixture.orchestrator as any).actionCards.detach(); await fixture.close(); });
    const session = await fixture.create();
    let card: ElicitationCardPost;
    Object.assign((fixture.orchestrator as any).adapter, {
      sendElicitationCard: async (_: unknown, value: ElicitationCardPost) => { card = value; return { id: "proposal-card", channel: { platform: "discord", id: "thread" } }; },
      editElicitationCard: vi.fn(async () => {}), sendMessage: vi.fn(async () => ({})),
    });
    expect(await fixture.orchestrator.proposeConfig(session, { session: { role: "proof" } })).toMatchObject({ ok: true });
    const click = event(card!.buttons![0]!.customId!, "proposal-card", "thread", options.user);
    await fixture.component(click);
    expect(fixture.store.actionCards.proposals()[0]!.status).toBe(options.applied ? "applied" : "open");
    expect(fixture.store.listConfigMutations()).toHaveLength(options.applied ? 1 : 0);
    if (!options.applied) expect(click.replyEphemeral).toHaveBeenCalled();
  });

  it("acknowledges a legacy or deleted card and removes its controls", async () => {
    const fixture = await namingFixture();
    cleanups.push(async () => { (fixture.orchestrator as any).actionCards.detach(); await fixture.close(); });
    const edit = vi.fn(async () => {});
    Object.assign((fixture.orchestrator as any).adapter, { editElicitationCard: edit });
    for (const customId of ["seam-perm:0:allow", "seam-cfg:apply", "seam-cfg:reject:deleted"]) {
      const click = event(customId, "old-card"); await fixture.component(click);
      expect(click.replyEphemeral).toHaveBeenCalledWith(expect.stringContaining("no longer available"));
      expect(edit.mock.calls.at(-1)?.[1].buttons).toEqual([]);
    }
  });
});
