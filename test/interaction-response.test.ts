import { testSessionStore } from "./helpers/session-fixture.js";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { pino } from "pino";
import { MessageFlags } from "discord.js";
import { acknowledgeInteraction, replyToInteraction } from "../packages/core/src/platforms/discord/interaction-response.js";
import type { InteractionResponseMode } from "../packages/core/src/platforms/interaction-response.js";
import { runAcknowledged } from "../packages/core/src/platforms/interaction-response.js";
import { SyntheticInteraction } from "../packages/core/src/platforms/discord/synthetic-interaction.js";
import { getSlashAcknowledgement, buildSlashRegistrationBody } from "../packages/core/src/platforms/discord/commands.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import { SlashRegistry, type SlashContribution, type SlashDispatchInvocation } from "../packages/core/src/plugins/slash-registry.js";
import { createQuotaPlugin } from "../packages/core/src/plugins/quota/index.js";
import { sessionBrowserPlugin } from "../packages/core/src/plugins/session-browser/index.js";
import { createCardVisualsPlugin } from "../packages/core/src/plugins/card-visuals/index.js";
import { namingRegistry } from "./plugin-naming-fixture.js";
import { planSessionAttachment } from "../packages/core/src/core/session-attach.js";

const logger = pino({ level: "silent" });
function interaction(command = "seam", group = "info", leaf = "help") {
  const clock = { now: 0 };
  const message = { id: "reply", edit: vi.fn(async () => message), delete: vi.fn(async () => {}) };
  const native = new SyntheticInteraction({ kind: "slash", channelId: "thread", command,
    subcommandGroup: group || undefined, subcommand: leaf }, {
    client: {} as never, channel: { id: "thread", send: vi.fn(async () => message) } as never,
    user: { id: "owner", username: "Owner" } as never, member: null, now: () => clock.now,
  });
  return { clock, native, typed: native as never, message };
}

function invocation(native: SyntheticInteraction): SlashDispatchInvocation {
  return { threadId: "thread", actor: { id: "owner", name: "Owner" }, string: () => null, boolean: () => null,
    acknowledge: mode => acknowledgeInteraction(native as never, mode),
    reply: view => replyToInteraction(native as never, view as never) };
}

describe("central slash acknowledgement", () => {
  it.each(["ephemeral", "public"] as const)("captures plugin admission state before the %s ACK completes, but waits to reply", async mode => {
    const i = interaction();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const defer = i.native.deferReply.bind(i.native);
    const ack = vi.spyOn(i.native, "deferReply").mockImplementation(async options => {
      await pending;
      return defer(options);
    });
    let binding = "original";
    let observed: string | undefined;
    const registry = new SlashRegistry(logger);
    registry.register("snapshot", [{ command: "seam", leaf: { type: 1, name: "snapshot", description: "Snapshot" },
      acknowledgement: mode, access: { kind: "read-only" }, authorization: "user", help: "Snapshot",
      handle: async input => { observed = binding; await input.reply("Completed"); } }], { logger, config: undefined });
    const dispatched = registry.dispatch("seam", null, "snapshot", invocation(i.native));
    expect(ack).toHaveBeenCalledOnce();
    expect(observed).toBe("original");
    expect(i.native.transcript).toEqual([]);
    binding = "detached";
    release();
    await dispatched;
    expect(binding).toBe("detached");
    expect(i.native.transcript.map(entry => entry.op)).toEqual(["deferReply", "editReply"]);
  });

  it("propagates a failed ACK without trying an undeferred reply", async () => {
    const i = interaction();
    const error = new Error("Discord acknowledgement: connection reset");
    vi.spyOn(i.native, "deferReply").mockRejectedValue(error);
    await expect(runAcknowledged(acknowledgeInteraction(i.typed, "ephemeral"),
      () => replyToInteraction(i.typed, "Result"))).rejects.toBe(error);
    expect(i.native.transcript).toEqual([]);
  });

  it("keeps a Detach during rebuild's ACK out of its attachment CAS", async () => {
    const i = interaction("seamadmin", "", "rebuild");
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const defer = i.native.deferReply.bind(i.native);
    vi.spyOn(i.native, "deferReply").mockImplementation(async options => { await pending; return defer(options); });
    let binding = "original";
    let captured: string | undefined;
    const reconstruct = vi.fn(async ({ observedAtStart }: { observedAtStart: string }) => {
      captured = observedAtStart;
      const plan = planSessionAttachment({ current: binding, observedAtStart, sourceId: observedAtStart,
        newId: "rebuilt", intent: "attach" });
      if (plan.action === "cas") binding = plan.next;
      return plan;
    });
    const orchestrator = Object.assign(Object.create(Orchestrator.prototype), {
      config: {}, plugins: { slash: new SlashRegistry(logger) },
      store: testSessionStore({ getByChannel: () => ({ acpSessionId: binding }) }),
      channelRefFromInteraction: () => ({ platform: "discord", id: "thread" }),
      runInbound: async (_kind: string, run: () => Promise<void>) => run(),
      loadPlugins: async () => {}, slashAccessRefusal: () => undefined,
      reconstructSessionFromDiscord: reconstruct,
    });
    const dispatched = orchestrator.handleSlashInteraction(i.typed);
    for (let n = 0; n < 10; n++) await Promise.resolve();
    binding = "";
    release();
    await dispatched;
    expect(captured).toBe("original");
    expect(await reconstruct.mock.results[0]!.value).toEqual({ action: "skip", attached: false, reason: "rebound-elsewhere" });
    expect(binding).toBe("");
  });

  it("keeps an ACK failure observable even when the handler never replies", async () => {
    const i = interaction();
    const error = new Error("Discord acknowledgement: Unknown interaction");
    vi.spyOn(i.native, "deferReply").mockRejectedValue(error);
    let changed = false;
    await expect(runAcknowledged(acknowledgeInteraction(i.typed, "ephemeral"), async () => { changed = true; })).rejects.toBe(error);
    expect(changed).toBe(true);
  });

  it("requires a mode in the contribution type and declares every registered kernel/plugin leaf", () => {
    expectTypeOf<SlashContribution>().toMatchTypeOf<{ acknowledgement: InteractionResponseMode }>();
    const registry = namingRegistry();
    for (const plugin of [createQuotaPlugin({} as never), sessionBrowserPlugin({} as never),
      createCardVisualsPlugin({} as never)]) registry.register(plugin.id, plugin.contributions.slash!, { logger, config: undefined });
    const missing: string[] = [];
    for (const command of buildSlashRegistrationBody(registry)) for (const option of command.options ?? []) {
      const group = option.type === 2 ? option.name : null;
      const leaves = option.type === 2 ? option.options ?? [] : [option];
      for (const leaf of leaves) {
        const mode = registry.get(command.name, group, leaf.name)?.acknowledgement
          ?? getSlashAcknowledgement(command.name, group, leaf.name);
        if (!["ephemeral", "public", "modal"].includes(mode!)) missing.push([command.name, group, leaf.name].filter(Boolean).join("/"));
      }
    }
    expect(missing).toEqual([]);
    expect(getSlashAcknowledgement("seamadmin", "upload", "secret")).toBe("modal");
    expect(getSlashAcknowledgement("seam", null, "queue")).toBe("public");
  });

  it.each(["ephemeral", "public"] as const)("acks a slow plugin handler once in %s mode", async mode => {
    const i = interaction();
    const registry = new SlashRegistry(logger);
    registry.register("slow", [{ command: "seam", leaf: { type: 1, name: "slow", description: "Slow" },
      acknowledgement: mode, access: { kind: "read-only" }, authorization: "user", help: "Slow",
      handle: async input => {
        expect(i.native.transcript[0]).toMatchObject({ op: "deferReply", atMs: 0, ephemeral: mode === "ephemeral" });
        i.clock.now = 4_500;
        await input.reply("Actual result");
      } }], { logger, config: undefined });
    await registry.dispatch("seam", null, "slow", invocation(i.native));
    expect(i.native.transcript.map(entry => entry.op)).toEqual(["deferReply", "editReply"]);
    expect(i.native.transcript.at(-1)).toMatchObject({ content: "Actual result", atMs: 4_500 });
  });

  it.each([
    { command: "seam", group: "info", leaf: "help", method: "cmdHelp", mode: "ephemeral" },
    { command: "seam", group: "", leaf: "queue", method: "cmdQueue", mode: "public" },
  ])("acks $command/$group/$leaf before slow kernel preparation and dispatch", async spec => {
    const i = interaction(spec.command, spec.group, spec.leaf);
    const orchestrator = Object.assign(Object.create(Orchestrator.prototype), {
      plugins: { slash: new SlashRegistry(logger) },
      runInbound: async (_kind: string, run: () => Promise<void>) => run(),
      loadPlugins: async () => { i.clock.now = 4_500; },
      slashAccessRefusal: () => undefined,
      [spec.method]: async () => replyToInteraction(i.typed, "Actual kernel result"),
    });
    await orchestrator.handleSlashInteraction(i.typed);
    expect(i.native.transcript.map(entry => entry.op)).toEqual(["deferReply", "editReply"]);
    expect(i.native.transcript[0]).toMatchObject({ atMs: 0, ephemeral: spec.mode === "ephemeral" });
    expect(i.native.transcript.at(-1)).toMatchObject({ atMs: 4_500, content: "Actual kernel result" });
  });

  it("leaves a modal-first leaf free to show its form before slow work", async () => {
    const i = interaction("seamadmin", "upload", "secret");
    await acknowledgeInteraction(i.typed, getSlashAcknowledgement("seamadmin", "upload", "secret")!);
    await i.native.showModal({ custom_id: "secret", title: "Secret", components: [] });
    i.clock.now = 4_500;
    expect(i.native.transcript.map(entry => entry.op)).toEqual(["showModal"]);
    expect(i.native.transcript[0]).toMatchObject({ atMs: 0 });
  });

  it("retains a real failure after a slow transition and does not acknowledge twice", async () => {
    const i = interaction();
    await acknowledgeInteraction(i.typed, "ephemeral");
    await acknowledgeInteraction(i.typed, "ephemeral");
    i.clock.now = 4_500;
    const error = new Error("effort transition: session/load rejected the model");
    await replyToInteraction(i.typed, `Could not apply effort: ${error.message}`);
    expect(i.native.transcript.map(entry => entry.op)).toEqual(["deferReply", "editReply"]);
    expect(i.native.transcript.at(-1)?.content).toContain(error.message);
  });

  it("reports the original error through the dispatch reply after a slow handler throws", async () => {
    const i = interaction();
    const error = new Error("session/load: Authentication required");
    const adapter = Object.assign(Object.create(DiscordAdapter.prototype), {
      config: { DISCORD_ALLOWED_USER_IDS: new Set(["owner"]) }, logger,
      slashHandler: async () => {
        await acknowledgeInteraction(i.typed, "ephemeral");
        i.clock.now = 4_500;
        throw error;
      },
    });
    await adapter.handleSlash(i.native);
    expect(i.native.transcript.map(entry => entry.op)).toEqual(["deferReply", "editReply"]);
    expect(i.native.transcript.at(-1)?.content).toBe(`That command failed: ${error.message}`);
  });

  it("keeps a private refusal private for a public leaf", async () => {
    const i = interaction();
    await acknowledgeInteraction(i.typed, "public");
    await replyToInteraction(i.typed, { content: "This command requires a config admin.", flags: MessageFlags.Ephemeral });
    expect(i.native.transcript.at(-1)).toMatchObject({ op: "followUp", ephemeral: true,
      content: "This command requires a config admin." });
  });

  it("keeps autocomplete on its own three-second response budget, with no defer", async () => {
    const clock = { now: 0 };
    const native = new SyntheticInteraction({ kind: "autocomplete", channelId: "thread", command: "seam",
      subcommandGroup: "config", subcommand: "model", focused: "id" }, {
      client: {} as never, channel: { id: "thread" } as never, user: { id: "owner" } as never,
      member: null, now: () => clock.now,
    });
    const adapter = Object.assign(Object.create(DiscordAdapter.prototype), {
      config: { DISCORD_ALLOWED_USER_IDS: new Set(["owner"]) }, logger,
      autocompleteHandler: async () => { clock.now = 2_999; await native.respond([{ name: "model", value: "model" }]); },
    });
    await adapter.handleAutocomplete(native);
    expect(native.transcript.map(entry => entry.op)).toEqual(["respond"]);
    expect(native.transcript[0]).toMatchObject({ atMs: 2_999 });
  });
});
