import { afterEach, describe, expect, it, vi } from "vitest";
import { savedSessionHost, SAVED_SESSION } from "./helpers/saved-session-recovery.js";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { pino } from "pino";
import type { AgentProfile } from "@seam/adapters";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(options: Parameters<typeof savedSessionHost>[0] = {}) {
  const host = await savedSessionHost(options);
  cleanups.push(() => host.close());
  const router = host.makeRouter();
  const orch = host.makeOrchestrator(router);
  const internal = orch as any;
  vi.spyOn(orch, "loadPlugins").mockResolvedValue(undefined);
  vi.spyOn(internal, "recordFromInteraction").mockReturnValue(host.record);
  host.store.turnAttempts.registerOwner(internal.attemptBoot);
  const attempt = host.store.turnAttempts.claim({ id: "acquiring-turn", target: host.record.channelRef,
    prompt: "original request", session: "live", kind: "parked", createdUtc: new Date().toISOString() },
  "fixture-identity", internal.attemptBoot, "inbound");
  host.store.turnAttempts.bindStatusCard(attempt, { channelId: host.record.channelRef, messageId: "working-card" });
  internal.liveTurnByChannel.set(host.record.channelRef, attempt.id);
  const edits = vi.spyOn(internal.adapter, "editPanel");
  const loads = async () => (await host.requests()).filter(frame => frame.method === "session/load");
  return { host, router, orch, internal, attempt, edits, loads };
}

function cancelInteraction(channelId: string, force = false, ack = Promise.resolve()) {
  const interaction = {
    commandName: "seam", channelId, user: { id: "fixture-user" },
    options: { getString: () => null, getBoolean: (name: string) => name === "force" ? force : null,
      getSubcommand: () => "cancel", getSubcommandGroup: () => null },
    deferred: false, replied: false, ephemeral: false,
    deferReply: vi.fn(async () => { await ack; interaction.deferred = true; }),
    editReply: vi.fn(async () => {}), followUp: vi.fn(async () => {}), deleteReply: vi.fn(async () => {}), reply: vi.fn(),
  };
  return interaction;
}

describe("cancel the acquisition owner", () => {
  it("reports an unconfirmed cancel with its timeout cause instead of saying Cancel sent", async () => {
    const h = await setup();
    h.host.store.turnAttempts.bind(h.attempt, SAVED_SESSION);
    h.host.store.turnAttempts.startPrompt(h.attempt);
    vi.spyOn(h.router, "abortTurn").mockResolvedValue("unacknowledged");
    const interaction = cancelInteraction(h.host.record.channelRef);
    await h.orch.handleSlashInteraction(interaction as never);
    const reply = String((interaction.editReply.mock.calls as any[]).at(-1)?.[0]?.content);
    expect(reply).toMatch(/not confirmed/i);
    expect(reply).toMatch(/(?:2000ms|2s|2 seconds)/);
    expect(reply).not.toContain("Cancel sent.");
    expect(reply).toContain("/seam cancel force:true");
  });

  it("propagates the actual cancel send failure and reports its cause", async () => {
    const h = await setup();
    h.host.store.turnAttempts.bind(h.attempt, SAVED_SESSION);
    h.host.store.turnAttempts.startPrompt(h.attempt);
    const failure = Object.assign(new Error("synthetic cancel pipe closed"), { code: "EPIPE" });
    const runtime = new AgentRuntime({ profile: { id: "codex" } as AgentProfile,
      logger: pino({ level: "silent" }) as any,
      spawnFn: () => { throw new Error("provider spawning forbidden"); } });
    Object.assign(runtime, { sessionId: SAVED_SESSION, promptInFlight: true,
      connection: { cancel: vi.fn(async () => { throw failure; }) } });
    (h.router as any).runtimes.set(h.host.record.id, runtime);
    try {
      await expect(runtime.cancel()).rejects.toBe(failure);
      const interaction = cancelInteraction(h.host.record.channelRef);
      await h.orch.handleSlashInteraction(interaction as never);
      const reply = String((interaction.editReply.mock.calls as any[]).at(-1)?.[0]?.content);
      expect(reply).toContain(failure.message);
      expect(reply).toMatch(/not confirmed/i);
      expect(reply).not.toContain("Cancel sent.");
      expect(reply).toContain("/seam cancel force:true");
    } finally {
      (h.router as any).runtimes.delete(h.host.record.id);
    }
  });

  it.each([false, true])("cancels backoff with no later loads (force=%s), before the ACK round trip", async force => {
    const backoff = deferred();
    const entered = deferred();
    const sleep = vi.fn(async () => { entered.resolve(); await backoff.promise; });
    const h = await setup({ failLoad: true, recoverySleep: sleep });
    const acquisition = h.internal.acquireRecordedRuntime(h.host.record, h.attempt.id, SAVED_SESSION)
      .catch((error: unknown) => error);
    await entered.promise;
    expect(await h.loads()).toHaveLength(1);
    expect(h.router.hasRuntime(h.host.record.id)).toBe(false);
    const ack = deferred();
    const interaction = cancelInteraction(h.host.record.channelRef, force, ack.promise);
    const cancel = h.orch.handleSlashInteraction(interaction as never);
    await vi.waitFor(() => expect(h.host.store.turnAttempts.get(h.attempt.id)?.state).toBe("cancelled"));
    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(await acquisition).toMatchObject({ suspension: "superseded", reason: "cancelled by operator" });
    await vi.waitFor(() => expect(JSON.stringify(h.edits.mock.calls)).toMatch(/Failed.*Cancelled/s));
    ack.resolve();
    await cancel;
    expect(force ? interaction.followUp : interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: "🛑 Cancelled the turn while it was still starting.",
    }));
    expect(interaction.reply).not.toHaveBeenCalled();
    backoff.resolve();
    await Promise.resolve();
    expect(await h.loads()).toHaveLength(1);
    expect((await h.host.requests()).filter(frame => frame.method === "session/prompt")).toEqual([]);
    expect(h.host.store.get(h.host.record.id)?.acpSessionId).toBe(SAVED_SESSION);
  }, 20_000);

  it("disposes a load that completes after cancel instead of caching or prompting it", async () => {
    const h = await setup({ loadGate: true });
    const acquisition = h.internal.acquireRecordedRuntime(h.host.record, h.attempt.id, SAVED_SESSION)
      .catch((error: unknown) => error);
    await vi.waitFor(async () => expect(await h.loads()).toHaveLength(1), { timeout: 10_000 });
    const interaction = cancelInteraction(h.host.record.channelRef);
    await h.orch.handleSlashInteraction(interaction as never);
    expect(h.host.store.turnAttempts.get(h.attempt.id)?.state).toBe("cancelled");
    await h.host.releaseLoad();
    expect(await acquisition).toMatchObject({ suspension: "superseded", reason: "cancelled by operator" });
    expect(h.router.hasRuntime(h.host.record.id)).toBe(false);
    await vi.waitFor(async () => expect((await h.host.client.listSlots()).health.filter(slot => slot.alive)).toEqual([]));
    expect(await h.loads()).toHaveLength(1);
    expect((await h.host.requests()).filter(frame => frame.method === "session/prompt")).toEqual([]);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: "🛑 Cancelled the turn while it was still starting.",
    }));
  }, 20_000);

  it("does not start a load for an already-cancelled attempt", async () => {
    const h = await setup();
    h.host.store.turnAttempts.cancel(h.attempt.id);
    await expect(h.internal.acquireRecordedRuntime(h.host.record, h.attempt.id, SAVED_SESSION))
      .rejects.toMatchObject({ suspension: "superseded", reason: "cancelled by operator" });
    expect(h.host.commands.filter(frame => frame.type === "rpc" && frame.method === "spawn")).toEqual([]);
  });

  it("does not cache a fresh live-dispatch runtime that starts after cancellation", async () => {
    const h = await setup({ newGate: true });
    h.host.record.acpSessionId = "";
    h.host.store.upsert(h.host.record);
    vi.spyOn(h.internal, "ensureOwnSession").mockResolvedValue(undefined);
    const acquisition = h.orch.injectTurn(h.host.record, "continue fresh dispatch", {
      session: "live", logContext: { dispatch: h.attempt.id },
    }).catch((error: unknown) => error);
    await vi.waitFor(async () => expect((await h.host.requests())
      .filter(frame => frame.method === "session/new")).toHaveLength(1), { timeout: 10_000 });
    const interaction = cancelInteraction(h.host.record.channelRef);
    await h.orch.handleSlashInteraction(interaction as never);
    expect(h.host.store.turnAttempts.get(h.attempt.id)?.state).toBe("cancelled");
    await h.host.releaseNew();
    expect(await acquisition).toMatchObject({ suspension: "superseded", reason: "cancelled by operator" });
    expect(h.router.hasRuntime(h.host.record.id)).toBe(false);
    await vi.waitFor(async () => expect((await h.host.client.listSlots()).health.filter(slot => slot.alive)).toEqual([]));
    expect((await h.host.requests()).filter(frame => frame.method === "session/new")).toHaveLength(1);
    expect((await h.host.requests()).filter(frame => frame.method === "session/prompt")).toEqual([]);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: "🛑 Cancelled the turn while it was still starting.",
    }));
  }, 20_000);

  it("keeps the existing cancel signal and reply for a prompted live turn", async () => {
    const h = await setup();
    h.host.store.turnAttempts.bind(h.attempt, SAVED_SESSION);
    h.host.store.turnAttempts.startPrompt(h.attempt);
    const abort = vi.spyOn(h.router, "abortTurn").mockResolvedValue("cancelled");
    const interaction = cancelInteraction(h.host.record.channelRef);
    await h.orch.handleSlashInteraction(interaction as never);
    expect(abort).toHaveBeenCalledWith(h.host.record.id, { force: false });
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining("🟡 Cancel sent."),
    }));
    expect(JSON.stringify(interaction.editReply.mock.calls)).not.toContain("still starting");
    expect(h.host.store.turnAttempts.get(h.attempt.id)?.state).toBe("cancelled");
  });

  it("only reports no active turn when cancellation settled nothing", async () => {
    const h = await setup();
    h.host.store.turnAttempts.cancel(h.attempt.id);
    h.internal.liveTurnByChannel.clear();
    await vi.waitFor(() => expect(h.host.store.turnAttempts.get(h.attempt.id)?.statusCardState?.status.input.action).toBe("Cancelled"));
    const before = h.host.store.turnAttempts.get(h.attempt.id);
    const interaction = cancelInteraction(h.host.record.channelRef);
    await h.orch.handleSlashInteraction(interaction as never);
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: "No active turn." }));
    expect(h.host.store.turnAttempts.get(h.attempt.id)).toEqual(before);
  });
});
