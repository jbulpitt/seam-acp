import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { savedSessionHost, SAVED_SESSION } from "./helpers/saved-session-recovery.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function steerNow(prompt = "ORIGINAL-STEER-BRIEF") {
  const host = await savedSessionHost();
  const router = host.makeRouter();
  const orch = host.makeOrchestrator(router);
  const internal = orch as any;
  Object.assign(internal.config, { TURN_TIMEOUT_SECONDS: 60, SEAM_TURN_RESUME_ENABLED: true,
    DISCORD_USER_NAMES: new Map() });
  const panels: unknown[] = [];
  Object.assign(internal.adapter, {
    sendPanel: async (channel: unknown, panel: unknown) => {
      panels.push(panel); return { channel, id: "steer-card" };
    },
    editPanel: async (_ref: unknown, panel: unknown) => { panels.push(panel); },
  });
  await orch.loadPlugins();
  const interaction = { id: "638000000000000002", channelId: host.record.channelRef,
    channel: { isThread: () => true }, deferred: true,
    options: { getString: (name: string) => name === "prompt" ? prompt : null,
      getBoolean: () => true },
    user: { id: "fixture-user", username: "Fixture" }, member: null,
    editReply: vi.fn(async () => {}) };
  const run = internal.cmdSteer(interaction) as Promise<void>;
  run.catch(() => {});
  cleanups.push(async () => {
    orch.suspendForRestart();
    await router.disposeAll();
    await run.catch(() => {});
    await host.close();
  });
  await vi.waitFor(async () => expect((await host.requests())
    .filter(row => row.method === "session/prompt")).toHaveLength(1), { timeout: 10_000 });
  const pids = () => fs.readFile(path.join(host.root, "agent.pids"), "utf8")
    .then(text => text.trim().split("\n").map(Number));
  const [pid] = await pids();
  return { host, router, orch, internal, interaction, id: `inbound-${interaction.id}`,
    run, pid, pids, panels };
}

describe("slash steer-now through sessiond and adapter-child", () => {
  it("recovers a dead child on the saved session without replaying the steer", async () => {
    const h = await steerNow();
    // This is the fake ACP agent in this test's private sessiond, not a host agent.
    process.kill(h.pid!, "SIGKILL");
    await h.run;
    await vi.waitFor(() => expect(h.host.store.turnAttempts.get(h.id)).toMatchObject({
      state: "completed", generation: 2, acpSessionId: SAVED_SESSION,
      outcome: { status: "completed", stopReason: "end_turn" },
    }), { timeout: 15_000 });
    const requests = await h.host.requests();
    const prompts = requests.filter(row => row.method === "session/prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[0].params.prompt[0].text).toContain("ORIGINAL-STEER-BRIEF");
    expect(prompts[1].params.prompt[0].text).toMatch(/^continue\b/);
    expect(prompts[1].params.prompt[0].text).not.toContain("ORIGINAL-STEER-BRIEF");
    expect(prompts.map(row => row.params.sessionId)).toEqual([SAVED_SESSION, SAVED_SESSION]);
    expect(requests.filter(row => row.method === "session/load")
      .map(row => row.params.sessionId)).toEqual([SAVED_SESSION, SAVED_SESSION]);
    expect(requests.filter(row => row.method === "session/new")).toEqual([]);
    expect(await h.pids()).toHaveLength(2);
    expect(JSON.stringify(h.panels)).not.toMatch(/Steer failed|"Failed"/);
    expect(h.host.notices.some(notice => notice.text.includes("resumed ok"))).toBe(true);
  }, 30_000);

  it("detaches the owned steer at the restart cutoff instead of killing its child", async () => {
    const h = await steerNow();
    h.orch.suspendForRestart();
    await h.router.disposeAll();
    await h.run;
    expect(() => process.kill(h.pid!, 0)).not.toThrow();
    expect(h.host.store.turnAttempts.get(h.id)).toMatchObject({
      state: "suspended", generation: 1, promptStarted: true,
      remoteRecovery: { acpSessionId: SAVED_SESSION },
    });
    expect(await h.pids()).toHaveLength(1);
    expect((await h.host.requests()).filter(row => row.method === "session/prompt")).toHaveLength(1);
    expect(JSON.stringify(h.panels)).not.toMatch(/Steer failed|"Failed"/);
  }, 20_000);

  it("delivers a completed steer through the human turn while preserving its author", async () => {
    const h = await steerNow("continue and finish the steer");
    await h.run;
    expect(h.host.store.getInbound(h.interaction.id)).toMatchObject({
      state: "completed", authorId: "fixture-user", authorName: "Fixture", preemptive: true,
    });
    expect(h.host.store.turnAttempts.get(h.id)).toMatchObject({
      state: "completed", generation: 1, outcome: { status: "completed", stopReason: "end_turn" },
    });
    expect(h.host.notices.filter(notice => notice.text.includes("resumed ok"))).toHaveLength(1);
    expect(await h.pids()).toHaveLength(1);
    expect(JSON.stringify(h.panels)).not.toMatch(/Steer failed|"Failed"/);
  }, 20_000);
});
