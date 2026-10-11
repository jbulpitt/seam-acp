import { afterAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "../packages/core/src/agents/agent-runtime.js";
import { DEFAULT_REMOTE_RUNG1_POLICY, spawnRemoteSlot } from "../packages/core/src/core/remote-spawn.js";
import { scheduledOccurrenceKey } from "../packages/core/src/core/scheduled-prompts/occurrence-store.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import { savedSessionHost } from "./helpers/saved-session-recovery.js";
import { prepareSessionExecutables } from "./helpers/saved-session-executables.js";
import { pino } from "pino";

const executables = await prepareSessionExecutables();
afterAll(() => executables.close());
const logger = pino({ level: "silent" });
const fixture = fileURLToPath(new URL("./fixtures/isolated-permission-agent.mjs", import.meta.url));
const allow = { outcome: { outcome: "selected" as const, optionId: "allow" } };

async function interruptedSchedule(policy: "always" | "ask") {
  const h = await savedSessionHost({ ...executables, agentFixture: fixture });
  const now = new Date().toISOString();
  h.store.upsert({ ...h.record, configJson: JSON.stringify({ permissionPolicy: policy }) });
  const router = h.makeRouter();
  const old = h.makeOrchestrator(router);
  const row: ScheduledPrompt = { id: "permission-schedule", platform: "discord", channelRef: h.record.channelRef,
    parentRef: null, name: "Permission boundary", promptText: "read snapshots", cron: "0 * * * *", timezone: "UTC",
    model: null, cwd: null, targetChannel: null, outputType: "messages", sessionMode: "isolated",
    catchupSeconds: 0, enabled: true, legacyAttachmentCount: 0, createdBy: "fixture-user", createdUtc: now, updatedUtc: now,
    lastRunUtc: null, lastStatus: null, nextRunUtc: null, pinnedSessionId: null };
  h.store.upsertScheduled(row);
  const occurrence = h.store.scheduledOccurrences.prepare(scheduledOccurrenceKey(row.id), row, row => old.scheduleExecution(row))!;
  h.store.turnAttempts.registerOwner("old-controller");
  const attempt = h.store.turnAttempts.claim({ id: occurrence.id, target: row.channelRef, prompt: row.promptText,
    session: "isolated", kind: "scheduled", createdUtc: now }, occurrence.execution.fingerprint, "old-controller", "schedule");
  const runtime = new AgentRuntime({ profile: router.getProfile("codex", "fixture")!, logger,
    permissionPolicy: () => new Promise(() => {}),
    bridgeHealth: h.mux,
    spawnFn: () => spawnRemoteSlot(h.mux, { agentId: "codex", cwd: h.root, mcpServers: [],
      rung1Recovery: DEFAULT_REMOTE_RUNG1_POLICY }) });
  await runtime.start();
  const info = await runtime.newSession({ cwd: h.root });
  h.store.turnAttempts.bind(attempt, info.sessionId);
  h.store.turnAttempts.startPrompt(attempt);
  const original = runtime.prompt(row.promptText, undefined, {
    onRemoteRecovery: binding => { h.store.turnAttempts.recordRemoteRecovery(attempt, { ...binding, location: "fixture" }); },
    onRemoteRecoveryReleased: () => {},
    recoveryScope: "ephemeral",
  }).catch(() => undefined);
  const slot = runtime.getSlot()!;
  const permission = { requestId: "isolated-permission", sessionId: info.sessionId, toolCallId: "isolated-tool" };
  await vi.waitFor(async () => expect(await h.slots.permissionControl(slot, "permission_status", permission))
    .toMatchObject({ state: "pending" }), { timeout: 10_000 });
  expect(h.store.turnAttempts.get(attempt.id)?.remoteRecovery).toMatchObject({ slot, acpSessionId: info.sessionId });
  const owner = (await h.client.listSlots()).health.find(row => row.slot === slot)!;
  await runtime.detach();
  await original;
  h.store.turnAttempts.suspendBoot("old-controller");
  return { h, attempt, slot, permission, owner };
}

describe("isolated restart adoption services the surviving permission", () => {
  it("answers under the recorded policy, settles once without resending, and leaves a parallel live runtime untouched", async () => {
    const { h, attempt, slot, permission, owner } = await interruptedSchedule("always");
    const router = h.makeRouter();
    const orch = h.makeOrchestrator(router);
    const live = await router.getOrStartRuntime(h.store.get(h.record.id)!);
    const liveSlot = live.getSlot()!;
    const parallel = live.prompt("parallel live turn", undefined, {
      onRemoteRecovery: () => {}, onRemoteRecoveryReleased: () => {},
    }).catch(() => undefined);
    const liveOwner = (await h.client.listSlots()).health.find(row => row.slot === liveSlot)!;
    const hang = vi.spyOn(AgentRuntime.prototype, "watchInFlightHang");
    // A later thread edit must not change the admitted occurrence's policy.
    h.store.upsert({ ...h.store.get(h.record.id)!, configJson: JSON.stringify({ permissionPolicy: "deny", model: "later-model" }) });
    const settle = vi.spyOn(h.store.scheduledOccurrences, "settle");
    const adoption = (orch as any).adoptRemoteRecoveryOwned(h.store.turnAttempts.get(attempt.id));
    try {
      await vi.waitFor(() => expect(h.store.scheduledOccurrences.get(attempt.id)?.settled).toBe(true), { timeout: 10_000 });
      await adoption;
      const requests = await h.requests();
      const answers = requests.filter(row => row.id === permission.requestId && row.result);
      expect(answers).toHaveLength(1);
      expect(answers[0]).toMatchObject({ result: allow });
      expect(requests.filter(row => row.method === "session/prompt" && row.params.sessionId === permission.sessionId)).toHaveLength(1);
      expect(h.store.turnAttempts.get(attempt.id)).toMatchObject({ state: "completed", outcome: {
        status: "completed", stopReason: "end_turn", output: "isolated finished once",
      } });
      expect(settle).toHaveBeenCalledTimes(1);
      expect(h.notices.filter(row => row.text.includes("isolated finished once"))).toHaveLength(1);
      expect(hang).toHaveBeenCalledOnce();
      expect(router.getRuntime(h.record.id)).toBe(live);
      const after = (await h.client.listSlots()).health.find(row => row.slot === liveSlot)!;
      expect(after).toMatchObject({ pid: liveOwner.pid, alive: true });
      expect(answers[0].pid).toBe(requests.find(row => row.method === "session/new")!.pid);
      expect(h.commands.filter(row => row.type === "kill" && row.slot === liveSlot)).toEqual([]);
      expect(owner.alive).toBe(true);
    } finally {
      orch.suspendForRestart();
      (orch as any).remoteAdoptionFinishers.get(attempt.id)?.();
      await live.detach();
      await parallel;
      await h.close();
      vi.restoreAllMocks();
    }
  }, 25_000);

  it("recovers the same pending request after a second controller restart and an acknowledged output cursor", async () => {
    const { h, attempt, slot, permission, owner } = await interruptedSchedule("ask");
    const firstRouter = h.makeRouter();
    const held = vi.fn(() => new Promise<typeof allow>(() => {}));
    const first = h.makeOrchestrator(firstRouter);
    firstRouter.setAskUser(held);
    const firstAdoption = (first as any).adoptRemoteRecoveryOwned(h.store.turnAttempts.get(attempt.id));
    let second: ReturnType<typeof h.makeOrchestrator> | undefined;
    try {
      await vi.waitFor(() => expect(held).toHaveBeenCalled(), { timeout: 10_000 });
      const replay = await h.client.replayOutput({ slot, afterSeq: 0 });
      const throughSeq = replay.frames.at(-1)!.seq;
      await h.slots.ack(slot, throughSeq);
      expect((await h.client.replayOutput({ slot, afterSeq: throughSeq })).frames).toEqual([]);
      expect(await h.slots.permissionControl(slot, "permission_status", permission)).toMatchObject({ state: "pending" });
      first.suspendForRestart();
      (first as any).remoteAdoptionFinishers.get(attempt.id)?.();
      await firstAdoption;
      const router = h.makeRouter();
      const answer = vi.fn(async () => allow);
      second = h.makeOrchestrator(router);
      router.setAskUser(answer);
      const secondAdoption = (second as any).adoptRemoteRecoveryOwned(h.store.turnAttempts.get(attempt.id));
      await vi.waitFor(() => expect(h.store.scheduledOccurrences.get(attempt.id)?.settled).toBe(true), { timeout: 10_000 });
      await secondAdoption;
      expect(answer).toHaveBeenCalled();
      const requests = await h.requests();
      expect(requests.filter(row => row.id === permission.requestId && row.result)).toHaveLength(1);
      expect(requests.filter(row => row.method === "session/prompt")).toHaveLength(1);
      expect(new Set(requests.map(row => row.pid)).size).toBe(1);
      expect(owner.alive).toBe(true);
      expect(h.store.turnAttempts.get(attempt.id)?.acpSessionId).toBe(permission.sessionId);
      expect(h.notices.filter(row => row.text.includes("isolated finished once"))).toHaveLength(1);
    } finally {
      first.suspendForRestart();
      (first as any).remoteAdoptionFinishers.get(attempt.id)?.();
      second?.suspendForRestart();
      (second as any)?.remoteAdoptionFinishers.get(attempt.id)?.();
      await h.close();
      vi.restoreAllMocks();
    }
  }, 30_000);
});
