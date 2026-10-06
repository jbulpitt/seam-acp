import { EventEmitter } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { pino } from "pino";
import { MessageFlags } from "discord.js";
import { acknowledgeComponentInteraction, awaitAcknowledgedInteraction, collectAcknowledgedInteractions, replyToInteraction, ignoreCollectorTimeout } from "../packages/core/src/platforms/discord/interaction-response.js";
import type { ComponentAcknowledgement, ComponentResponseMode } from "../packages/core/src/platforms/interaction-response.js";
import { SyntheticInteraction } from "../packages/core/src/platforms/discord/synthetic-interaction.js";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { ComponentRegistry, type ComponentContribution } from "../packages/core/src/plugins/component-registry.js";
import { ConfigUi, createConfigUiPlugin } from "../packages/core/src/plugins/config-ui/index.js";
import { createPresetPlugin } from "../packages/core/src/plugins/presets/index.js";
import { createQuotaPlugin } from "../packages/core/src/plugins/quota/index.js";
import { createServiceStatusPlugin } from "../packages/core/src/plugins/service-status/index.js";
import { createScheduleUiPlugin, scheduleBuilderAcknowledgement } from "../packages/core/src/plugins/schedule-ui/index.js";
import type { ScheduleInteraction, ScheduleClick } from "../packages/core/src/plugins/schedule-ui/ports.js";
import { sessionBrowserPlugin } from "../packages/core/src/plugins/session-browser/index.js";
import { createThreadNamingPlugin } from "../packages/core/src/plugins/thread-naming/index.js";
import { makeCustomId, RIDER_MODAL_MAX } from "../packages/core/src/platforms/discord/config-editor.js";
import { WorkflowInventoryController } from "../packages/core/src/platforms/discord/workflow-inventory-controls.js";

const logger = pino({ level: "silent" });
function interaction(kind: "button" | "select" | "modal" = "button", customId = "test:run", values = ["value"]) {
  const clock = { now: 0 };
  const card = { id: "original", edit: vi.fn(async () => card), delete: vi.fn(async () => {}) };
  const reply = { id: "private-reply", edit: vi.fn(async () => reply), delete: vi.fn(async () => {}) };
  const native = new SyntheticInteraction({ kind, channelId: "thread", messageId: card.id, customId,
    ...(kind === "select" ? { values } : {}), ...(kind === "modal" ? { fields: { value: "saved" } } : {}) } as never, {
    client: {} as never, channel: { id: "thread", send: vi.fn(async () => reply) } as never,
    user: { id: "owner", username: "Owner" } as never, member: null, message: card as never, now: () => clock.now,
  });
  return { native, typed: native as never, clock, card, reply };
}

function registry() {
  const components = new ComponentRegistry(logger);
  const ui = Object.assign(Object.create(ConfigUi.prototype), { configEditor: { get: () => undefined }, ports: {} });
  const plugins = [
    createConfigUiPlugin(ui), createPresetPlugin({} as never), createQuotaPlugin({} as never),
    createServiceStatusPlugin({} as never).plugin, createScheduleUiPlugin({ logger } as never), sessionBrowserPlugin({} as never),
    createThreadNamingPlugin({ threads: {}, internal: { rules: {}, setNamePrefix() {} } } as never),
  ];
  for (const plugin of plugins) components.register(plugin.id, plugin.contributions.components!, { logger, config: undefined });
  const orchestrator = Object.assign(Object.create(Orchestrator.prototype), { logger, plugins: { components } });
  orchestrator.registerKernelComponents();
  return components;
}

describe("component acknowledgement declarations", () => {
  it("requires an explicit mode on every persistent/collector route and collector port", () => {
    expectTypeOf<ComponentContribution>().toMatchTypeOf<{ acknowledgement: ComponentAcknowledgement }>();
    type CollectorOptions = Parameters<Awaited<ReturnType<ScheduleInteraction["fetchReply"]>>["createMessageComponentCollector"]>[0];
    expectTypeOf<CollectorOptions>().toMatchTypeOf<{ acknowledgement: ComponentAcknowledgement }>();
    expectTypeOf<Parameters<ScheduleClick["awaitModalSubmit"]>[0]>().toMatchTypeOf<{ acknowledgement: ComponentAcknowledgement }>();
    const components = registry();
    expect(components.contributions().map(route => route.namespace).sort()).toEqual([
      "preset:", "pr:", "sched:", "seam-cfg:", "seam-cfg-edit:", "seam-elicit:", "seam-namer:",
      "seam-perm:", "seam-quota:", "seam-service-status:", "seam-tts:", "sessions:", "sl:", "tvc:",
    ].sort());
    for (const route of components.contributions()) for (const kind of route.types) {
      expect(["ephemeral", "public", "modal", "update"]).toContain(components.acknowledgement({ customId: `${route.namespace}test`, kind }));
    }
  });

  it.each([
    ["preset:details:draft", "button", "modal"], ["preset:details:draft", "modal", "update"],
    ["pr:edit:preset", "button", "ephemeral"], ["pr:delete:preset", "button", "update"],
    ["seam-namer:edit:owner:deadline", "button", "modal"], ["seam-namer:save:owner:deadline", "modal", "ephemeral"],
    ["seam-elicit:answer:request", "button", "modal"], ["seam-elicit:answer:request", "modal", "update"],
    ["tvc:tvc_abc:3:edit-alias:tvb_a", "button", "modal"], ["tvc:tvc_abc:3:alias-save:tvb_a", "modal", "update"],
    ["sessions:import_to_cwd:state", "button", "modal"], ["sessions:import_cwd_modal:state", "modal", "update"],
    ["seam-service-status:refresh", "button", "ephemeral"], ["seam-quota:refresh", "button", "update"],
  ] as const)("classifies %s (%s) as %s", (customId, kind, expected) => {
    expect(registry().acknowledgement({ customId, kind })).toBe(expected);
  });

  it("classifies role and short-rider editors as modal-first, but keeps long-rider pickers on update", () => {
    let rider = "short";
    const ui = Object.assign(Object.create(ConfigUi.prototype), { configEditor: { get: () => ({ overlay: { rider }, snapshot: { rider: { thread: null } } }) } });
    expect(ui.acknowledgement({ kind: "button", customId: makeCustomId("draft", "role") })).toBe("modal");
    expect(ui.acknowledgement({ kind: "button", customId: makeCustomId("draft", "rider") })).toBe("modal");
    rider = "x".repeat(RIDER_MODAL_MAX + 1);
    expect(ui.acknowledgement({ kind: "button", customId: makeCustomId("draft", "rider") })).toBe("update");
    expect(ui.acknowledgement({ kind: "modal", customId: makeCustomId("draft", "role-save") })).toBe("update");
  });

  it("classifies both schedule modal openers, not the normal cadence or modal submission", () => {
    expect(scheduleBuilderAcknowledgement({ kind: "button", customId: "sched:prompt" })).toBe("modal");
    expect(scheduleBuilderAcknowledgement({ kind: "select", customId: "sched:cadence", values: ["__custom__"] })).toBe("modal");
    expect(scheduleBuilderAcknowledgement({ kind: "select", customId: "sched:cadence", values: ["*/15 * * * *"] })).toBe("update");
    expect(scheduleBuilderAcknowledgement({ kind: "modal", customId: "sched:prompt" })).toBe("update");
  });

  it("declares a modal only for a durable choice that opens custom input", () => {
    let declaration!: ComponentAcknowledgement;
    let select: { min: number; max: number } | undefined;
    const orchestrator = Object.assign(Object.create(Orchestrator.prototype), {
      adapter: { onMessage() {}, onComponent() {}, onChoiceInteraction(_handle: unknown, mode: ComponentAcknowledgement) { declaration = mode; } },
      store: { getChoiceCard: () => ({ options: [{ kind: "prompt" }, { kind: "custom" }], select }) },
      watchSentinel() {}, watchQueueWedges() {},
    });
    orchestrator.install();
    expect(typeof declaration).toBe("function");
    const mode = declaration as Exclude<ComponentAcknowledgement, string>;
    expect(mode({ kind: "button", customId: "choice:card:0" })).toBe("update");
    expect(mode({ kind: "button", customId: "choice:card:1" })).toBe("modal");
    expect(mode({ kind: "select", customId: "choice:card:s", values: ["1"] })).toBe("modal");
    expect(mode({ kind: "modal", customId: "choice:card:m:1" })).toBe("update");
    select = { min: 1, max: 2 };
    expect(mode({ kind: "select", customId: "choice:card:s", values: ["1"] })).toBe("update");
  });
});

describe("central component acknowledgement", () => {
  it.each(["update", "ephemeral", "public"] as const)("enters a persistent handler before the %s ACK completes, but waits to reply", async mode => {
    const i = interaction();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const operation = mode === "update" ? "deferUpdate" : "deferReply";
    const defer = i.native[operation].bind(i.native);
    const ack = vi.spyOn(i.native, operation).mockImplementation(async options => { await pending; return defer(options as never); });
    let binding = "original";
    let observed: string | undefined;
    const adapter = Object.assign(Object.create(DiscordAdapter.prototype), { logger, componentAcknowledgement: mode,
      componentHandler: async (event: { cardReply: { editReply(view: unknown): Promise<void> } }) => {
        observed = binding;
        await event.cardReply.editReply({ content: "Completed" });
      } });
    const dispatched = adapter.handlePersistentComponent(i.native);
    expect(ack).toHaveBeenCalledOnce();
    expect(observed).toBe("original");
    expect(i.native.transcript).toEqual([]);
    binding = "detached";
    release();
    await dispatched;
    expect(binding).toBe("detached");
    expect(i.native.transcript.map(entry => entry.op)).toEqual([operation, "editReply"]);
  });

  it("reports a synchronous handler error privately after the ACK completes", async () => {
    const i = interaction();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const defer = i.native.deferUpdate.bind(i.native);
    vi.spyOn(i.native, "deferUpdate").mockImplementation(async () => { await pending; return defer(); });
    const adapter = Object.assign(Object.create(DiscordAdapter.prototype), { logger, componentAcknowledgement: "update",
      componentHandler: () => { throw new Error("synchronous save: database closed"); } });
    const dispatched = adapter.handlePersistentComponent(i.native);
    await Promise.resolve();
    expect(i.native.transcript).toEqual([]);
    release();
    await dispatched;
    expect(i.native.transcript.map(entry => entry.op)).toEqual(["deferUpdate", "followUp"]);
    expect(i.native.transcript.at(-1)).toMatchObject({ ephemeral: true, content: "Could not complete this action: synchronous save: database closed" });
    expect(i.card.edit).not.toHaveBeenCalled();
  });

  it("keeps the first workflow row claim even when the second click's ACK is faster", async () => {
    const first = interaction("button", "wf:resume:row");
    const second = interaction("button", "wf:abandon:row");
    let releaseAck!: () => void;
    const ackGate = new Promise<void>(resolve => { releaseAck = resolve; });
    let releaseMutation!: () => void;
    const mutationGate = new Promise<void>(resolve => { releaseMutation = resolve; });
    const defer = first.native.deferUpdate.bind(first.native);
    vi.spyOn(first.native, "deferUpdate").mockImplementation(async () => { await ackGate; return defer(); });
    const resume = vi.fn(async () => { await mutationGate; return "Resumed"; });
    const cancel = vi.fn(async () => "Cancelled");
    const controller = new WorkflowInventoryController({ resume, cancel,
      render: async () => ({ embeds: [], components: [], page: 0 }),
      refresh: async () => true, terminal: async () => true });
    const collector = new EventEmitter();
    const onError = vi.fn();
    let firstComplete!: (value: unknown) => void, secondComplete!: (value: unknown) => void;
    const completedFirst = new Promise(resolve => { firstComplete = resolve; });
    const completedSecond = new Promise(resolve => { secondComplete = resolve; });
    collectAcknowledgedInteractions(collector, "update", async click => {
      const result = await controller.handle(click.customId, {
        followUp: text => replyToInteraction(click, { content: text, flags: MessageFlags.Ephemeral }, { followUp: true }),
      });
      (click === first.native ? firstComplete : secondComplete)(result);
    }, onError);
    collector.emit("collect", first.native);
    expect(controller.busy).toBe(true);
    collector.emit("collect", second.native);
    expect(await completedSecond).toBe("dropped");
    expect(resume).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
    releaseMutation();
    for (let n = 0; n < 10; n++) await Promise.resolve();
    expect(first.native.transcript).toEqual([]);
    releaseAck();
    expect(await completedFirst).toBe("mutated");
    expect(first.native.transcript.map(entry => entry.op)).toEqual(["deferUpdate", "followUp"]);
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(["update", "ephemeral", "public"] as const)("acks a slow persistent handler in %s mode before dispatch", async mode => {
    const i = interaction();
    const adapter = Object.assign(Object.create(DiscordAdapter.prototype), { logger, componentAcknowledgement: mode,
      componentHandler: async () => {
        expect(i.native.transcript[0]).toMatchObject({ op: mode === "update" ? "deferUpdate" : "deferReply", atMs: 0 });
        i.clock.now = 4_500;
        await replyToInteraction(i.typed, "Actual result");
      } });
    await adapter.handlePersistentComponent(i.native);
    expect(i.native.transcript.map(entry => entry.op)).toEqual([mode === "update" ? "deferUpdate" : "deferReply", "editReply"]);
    expect(i.native.transcript.at(-1)).toMatchObject({ content: "Actual result", atMs: 4_500 });
    if (mode !== "update") expect(i.native.transcript[0]?.ephemeral).toBe(mode === "ephemeral");
  });

  it("lets a modal-first handler show its form without deferring", async () => {
    const i = interaction();
    const adapter = Object.assign(Object.create(DiscordAdapter.prototype), { logger, componentAcknowledgement: "modal",
      componentHandler: async (event: { showModal(options: unknown): Promise<void> }) => {
        await event.showModal({ customId: "test:save", title: "Value", inputs: [{ id: "value", label: "Value", style: "short" }] });
        i.clock.now = 4_500;
      } });
    await adapter.handlePersistentComponent(i.native);
    expect(i.native.transcript.map(entry => entry.op)).toEqual(["showModal"]);
    expect(i.native.transcript[0]).toMatchObject({ atMs: 0 });
  });

  it("acks a durable choice before its slow handler and reports the real failure privately", async () => {
    const i = interaction();
    const adapter = Object.assign(Object.create(DiscordAdapter.prototype), { logger, choiceAcknowledgement: "update",
      choiceHandler: async () => { i.clock.now = 4_500; throw new Error("dispatch rejected: session unavailable"); } });
    await adapter.handleChoiceInteraction(i.native);
    expect(i.native.transcript.map(entry => entry.op)).toEqual(["deferUpdate", "followUp"]);
    expect(i.native.transcript.at(-1)).toMatchObject({ ephemeral: true, content: "Could not complete this choice: dispatch rejected: session unavailable" });
    expect(i.card.edit).not.toHaveBeenCalled();
    expect(i.card.delete).not.toHaveBeenCalled();
  });

  it("reports a persistent handler's real failure after slow work without changing its card", async () => {
    const i = interaction();
    const adapter = Object.assign(Object.create(DiscordAdapter.prototype), { logger, componentAcknowledgement: "update",
      componentHandler: async () => { i.clock.now = 4_500; throw new Error("effort transition: backend rejected high"); } });
    await adapter.handlePersistentComponent(i.native);
    expect(i.native.transcript.map(entry => entry.op)).toEqual(["deferUpdate", "followUp"]);
    expect(i.native.transcript.at(-1)?.content).toContain("effort transition: backend rejected high");
    expect(i.card.edit).not.toHaveBeenCalled();
    expect(i.card.delete).not.toHaveBeenCalled();
  });

  it("returns the new private reply id after an update acknowledgement, not the source card id", async () => {
    const i = interaction();
    await acknowledgeComponentInteraction(i.typed, "update");
    const id = await replyToInteraction(i.typed, { content: "Private editor", flags: MessageFlags.Ephemeral }, { fetchReply: true });
    expect(id).toBe(i.reply.id);
    expect(i.card.delete).not.toHaveBeenCalled();
    expect(i.native.transcript.map(entry => entry.op)).toEqual(["deferUpdate", "followUp"]);
  });

  it.each(["update", "ephemeral", "public", "modal"] as const)("acks a slow collector callback in %s mode", async (mode: ComponentResponseMode) => {
    const i = interaction();
    const collector = new EventEmitter();
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    const onError = vi.fn();
    collectAcknowledgedInteractions(collector, mode, async native => {
      if (mode === "modal") await native.showModal({ custom_id: "test:save", title: "Value", components: [] } as never);
      i.clock.now = 4_500;
      if (mode !== "modal") await replyToInteraction(native, "Collector result");
      complete();
    }, onError);
    collector.emit("collect", i.native);
    await completed;
    expect(onError).not.toHaveBeenCalled();
    expect(i.native.transcript[0]).toMatchObject({ atMs: 0, op: mode === "modal" ? "showModal" : mode === "update" ? "deferUpdate" : "deferReply" });
    if (mode !== "modal") expect(i.native.transcript.at(-1)).toMatchObject({ atMs: 4_500, content: "Collector result" });
  });

  it("reports a collector's real error after acknowledging instead of leaving it in a log", async () => {
    const i = interaction();
    const collector = new EventEmitter();
    const error = new Error("schedule save: database is locked");
    const original = i.native.followUp.bind(i.native);
    let complete!: () => void;
    const completed = new Promise<void>(resolve => { complete = resolve; });
    vi.spyOn(i.native, "followUp").mockImplementation(async payload => { const reply = await original(payload); complete(); return reply; });
    const onError = vi.fn();
    collectAcknowledgedInteractions(collector, "update", async () => { i.clock.now = 4_500; throw error; }, onError);
    collector.emit("collect", i.native);
    await completed;
    expect(onError).toHaveBeenCalledWith(error);
    expect(i.native.transcript.at(-1)).toMatchObject({ ephemeral: true, content: `Could not complete this action: ${error.message}` });
    expect(i.card.edit).not.toHaveBeenCalled();
  });

  it.each(["select", "modal"] as const)("acks a one-shot %s before returning it to slow handler work", async kind => {
    const i = interaction(kind);
    const native = await awaitAcknowledgedInteraction(async () => i.typed, kind === "modal" ? "ephemeral" : "update");
    i.clock.now = 4_500;
    await replyToInteraction(native, "Saved result");
    expect(i.native.transcript[0]).toMatchObject({ atMs: 0, op: kind === "modal" ? "deferReply" : "deferUpdate" });
    expect(i.native.transcript.at(-1)).toMatchObject({ atMs: 4_500, content: "Saved result" });
  });

  it("does not turn a failed acknowledgement into a modal timeout", async () => {
    const i = interaction("modal");
    i.clock.now = 4_500;
    await expect(awaitAcknowledgedInteraction(async () => i.typed, "ephemeral").catch(ignoreCollectorTimeout)).rejects.toMatchObject({ code: 10062 });
    const timeout = Object.assign(new Error("Collector received no interactions before ending with reason: time"), { code: "InteractionCollectorError" });
    expect(ignoreCollectorTimeout(timeout)).toBeNull();
  });

  it("has no handler-local defers left in production source", () => {
    const root = path.resolve("packages/core/src");
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
      ? files(path.join(dir, entry.name)) : entry.name.endsWith(".ts") ? [path.join(dir, entry.name)] : []);
    const sites = files(root).flatMap(file => [...readFileSync(file, "utf8").matchAll(/\.(deferReply|deferUpdate)\s*\(/g)]
      .map(match => `${path.relative(root, file)}:${match[1]}`));
    expect(sites.sort()).toEqual(["platforms/discord/interaction-response.ts:deferReply", "platforms/discord/interaction-response.ts:deferUpdate"]);
  });
});
