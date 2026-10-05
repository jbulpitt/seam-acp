import { randomUUID } from "node:crypto";
import { ApplicationCommandOptionType as Option, MessageFlags, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import type { ChannelRef } from "../../platforms/chat-adapter.js";
import { expiredCardView } from "../../platforms/discord/collector-lifecycle.js";
import { paginateSchedules, parseScheduleListCustomId, requestedSchedulePage, scheduleListDescription, scheduleNavState, schedulePageCaption, schedulePageCustomId, scheduleRunOutcome } from "../../platforms/discord/schedule-list-view.js";
import { AutocompleteRegistry, tokenAutocompleteChoices } from "../../platforms/discord/autocomplete.js";
import { describeCron, validateCron, nextRun as cronNextRun } from "../../core/scheduled-prompts/cron.js";
import { legacyAttachmentQuarantine } from "../../core/scheduled-prompts/quarantine.js";
import { resolveRepoPath } from "../../core/path-utils.js";
import type { ScheduledPrompt } from "../../core/scheduled-prompts/types.js";
import type { Plugin } from "../types.js";
import type { SlashContribution } from "../slash-registry.js";
import type { ScheduleInteraction, ScheduleClick, ScheduleUiPorts } from "./ports.js";

const PLATFORM = "discord";
const SCHEDULED_COLOR = 0x3498db;
const SCHEDULE_DEFAULT_TZ = "America/Chicago";
const SCHEDULE_TIMEZONES = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
];
const SCHEDULE_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Every day at 9:00 AM", value: "0 9 * * *" },
  { label: "Weekdays at 9:00 AM", value: "0 9 * * 1-5" },
  { label: "Every Monday at 9:00 AM", value: "0 9 * * 1" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Custom cron…", value: "__custom__" },
];
const SCHEDULE_LEAVES = [
  { name: "add", description: "Create a scheduled prompt (finish setup on the card)", handle: "cmdScheduleAdd", id: false },
  { name: "list", description: "List this thread's scheduled prompts", handle: "cmdScheduleList", id: false },
  { name: "remove", description: "Delete a scheduled prompt", handle: "cmdScheduleRemove", id: true },
  { name: "toggle", description: "Enable or disable a scheduled prompt", handle: "cmdScheduleToggle", id: true },
  { name: "edit", description: "Edit a scheduled prompt (reopens the builder card)", handle: "cmdScheduleEdit", id: true },
] as const;

export class ScheduleUi {
  readonly autocomplete = new AutocompleteRegistry();
  logger: ScheduleUiPorts["logger"];
  constructor(readonly ports: ScheduleUiPorts) {
    this.logger = ports.logger;
    for (const leaf of SCHEDULE_LEAVES.filter(leaf => leaf.id)) this.autocomplete.register("schedule", leaf.name, "id", "opaque", ctx => {
      try {
        if (!ctx.channelId) return [];
        return tokenAutocompleteChoices(ports.repository.list(ctx.channelId).map(row => ({ id: row.id, label: row.name })), ctx.focusedValue);
      } catch { return []; }
    });
  }
  private normalizeId(i: ScheduleInteraction, sub: string, option: string, input: string): Promise<string> {
    return this.autocomplete.normalizeSubmission("schedule", sub, option, input, {
      group: "schedule", subcommand: sub, optionName: option, focusedValue: input,
      channelId: i.channelRef?.id, parentId: i.channelRef?.parentId, projectScopeId: i.channelRef?.parentId,
    });
  }
  private async openEditorAfterFreeze(c: ScheduleClick, open: () => Promise<void>, surface: string, retryCommand: string): Promise<void> {
    try { await open(); }
    catch (err) {
      this.logger.warn({ err, surface }, "editor failed to open after list freeze");
      await c.editReply({ content: `❌ Could not open the ${surface} editor. Run \`${retryCommand}\` again.`, embeds: [], components: [] }).catch(() => {});
    }
  }
  private scheduleSummaryLine(s: ScheduledPrompt): string {
    const state = s.enabled ? "🟢" : "⏸️";
    const last = s.lastStatus ? ` · last: ${s.lastStatus}` : "";
    const next = s.enabled && s.nextRunUtc ? ` · next: <t:${Math.floor(Date.parse(s.nextRunUtc) / 1000)}:R>` : "";
    const quarantined = legacyAttachmentQuarantine(s) ? " · ⚠️ legacy files — edit to re-arm" : "";
    const model = s.sessionMode !== "live" && s.model ? ` · 🤖${s.model}` : "";
    const mode = s.sessionMode === "live" ? " · 🧠live" : "";
    return `${state} **${s.name}** \`${s.id}\`\n   ${describeCron(s.cron)} (${s.timezone})${mode}${model}${quarantined}${next}${last}`;
  }

  async cmdScheduleList(i: ScheduleInteraction): Promise<void> {
    const channel = i.channelRef;
    if (!channel) {
      await i.reply({ content: "Use this inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const rows = this.ports.repository.list(channel.id);
    if (rows.length === 0) {
      await i.reply({ content: "No scheduled prompts for this thread. Create one with `/seamadmin schedule add`.", flags: MessageFlags.Ephemeral });
      return;
    }
    let page = 0;
    const rebuild = (requested: number = page) => {
      const built = this.buildScheduleListMessage(channel, requested);
      page = built.page;
      return { embeds: built.embeds, components: built.components };
    };
    await i.reply({ ...rebuild(), flags: MessageFlags.Ephemeral });
    const msg = await i.fetchReply();
    const collector = msg.createMessageComponentCollector({
      filter: (c) => c.user.id === i.user.id,
      time: 600_000,
    });
    const lifecycle = i.attachLifecycle(collector, () =>
      expiredCardView("⏰ Schedule list expired — run `/seamadmin schedule list` again.")
    );
    collector.on("collect", async (c) => {
      try {
        if (!c.isButton()) return;
        const wantedPage = requestedSchedulePage(c.customId);
        if (wantedPage !== null) {
          await c.deferUpdate();
          await lifecycle.refresh(rebuild(wantedPage));
          return;
        }
        const parsed = parseScheduleListCustomId(c.customId);
        const action = parsed?.action;
        const refusal = c.mutationRefusal();
        if (refusal) {
          await c.reply({ content: refusal, flags: MessageFlags.Ephemeral });
          return;
        }
        const id = parsed?.arg;
        const row = id ? this.ports.repository.get(id) : undefined;
        if (!row || !id || row.channelRef !== channel.id) {
          await c.reply({ content: "That schedule no longer exists.", flags: MessageFlags.Ephemeral });
          await lifecycle.refresh(rebuild());
          return;
        }
        if (action === "run") {
          await c.deferReply({ flags: MessageFlags.Ephemeral });
          await this.ports.admin.runNow(id);
          const fresh = this.ports.repository.get(id);
          await c.editReply(
            scheduleRunOutcome({
              name: row.name,
              status: fresh?.lastStatus,
              quarantined: !!legacyAttachmentQuarantine(fresh ?? row),
            })
          );
          await lifecycle.refresh(rebuild());
        } else if (action === "edit") {
          await lifecycle.transitionWithAck(
            "edit",
            {
              content: `✏️ Editing **${row.name}** — this listing was replaced by the editor below.`,
              embeds: [],
              components: [],
            },
            async () => {
              await c.deferReply({ flags: MessageFlags.Ephemeral });
            }
          );
          await this.openEditorAfterFreeze(
            c,
            () => this.cmdScheduleAdd(c, row),
            "schedule",
            "/seamadmin schedule edit"
          );
        } else if (action === "toggle") {
          const updated: ScheduledPrompt = { ...row, enabled: !row.enabled, updatedUtc: new Date().toISOString() };
          this.ports.repository.save(updated);
          if (updated.enabled) this.ports.admin.arm(updated);
          else this.ports.admin.disarm(id);
          await c.deferUpdate();
          await lifecycle.refresh(rebuild());
        } else if (action === "del") {
          this.ports.admin.disarm(id);
          this.ports.repository.remove(id);
          await c.deferUpdate();
          await lifecycle.refresh(rebuild());
        }
      } catch (err) {
        this.logger.warn({ err }, "schedule-list button handler failed");
      }
    });
  }

  buildScheduleListMessage(
    channel: ChannelRef,
    page = 0
  ): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
    page: number;
  } {
    const rows = this.ports.repository.list(channel.id);
    const slice = paginateSchedules(rows, page);
    const embed = new EmbedBuilder()
      .setTitle("⏰ Scheduled prompts")
      .setColor(SCHEDULED_COLOR)
      .setDescription(
        scheduleListDescription(
          slice.items.map((r) => this.scheduleSummaryLine(r)),
          schedulePageCaption(slice)
        )
      );
    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    for (const r of slice.items) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`sl:run:${r.id}`).setLabel("▶️ Run now").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`sl:edit:${r.id}`).setLabel(`✏️ ${r.name}`.slice(0, 80)).setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`sl:toggle:${r.id}`).setLabel(r.enabled ? "⏸️ Disable" : "🟢 Enable").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`sl:del:${r.id}`).setLabel("🗑️ Delete").setStyle(ButtonStyle.Danger),
        )
      );
    }
    const nav = scheduleNavState(slice.page, slice.pageCount);
    if (nav.show) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(schedulePageCustomId(nav.prevPage))
            .setLabel("◀ Prev")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(nav.prevDisabled),
          new ButtonBuilder()
            .setCustomId(schedulePageCustomId(slice.page))
            .setLabel(nav.label)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId(schedulePageCustomId(nav.nextPage))
            .setLabel("Next ▶")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(nav.nextDisabled),
        )
      );
    }
    return { embeds: [embed], components, page: slice.page };
  }

  async cmdScheduleRemove(i: ScheduleInteraction): Promise<void> {
    const id = await this.normalizeId(
      i,
      "remove",
      "id",
      i.options.getString("id", true)
    );
    const row = this.ports.repository.get(id);
    const channel = i.channelRef;
    if (!row || !channel || row.channelRef !== channel.id) {
      await i.reply({ content: `No schedule \`${id}\` in this thread.`, flags: MessageFlags.Ephemeral });
      return;
    }
    this.ports.admin.disarm(id);
    this.ports.repository.remove(id);
    await i.reply({ content: `🗑️ Deleted scheduled prompt **${row.name}** (\`${id}\`).`, flags: MessageFlags.Ephemeral });
  }

  async cmdScheduleToggle(i: ScheduleInteraction): Promise<void> {
    const id = await this.normalizeId(
      i,
      "toggle",
      "id",
      i.options.getString("id", true)
    );
    const row = this.ports.repository.get(id);
    const channel = i.channelRef;
    if (!row || !channel || row.channelRef !== channel.id) {
      await i.reply({ content: `No schedule \`${id}\` in this thread.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const updated: ScheduledPrompt = { ...row, enabled: !row.enabled, updatedUtc: new Date().toISOString() };
    this.ports.repository.save(updated);
    if (updated.enabled) this.ports.admin.arm(updated);
    else this.ports.admin.disarm(id);
    await i.reply({
      content: `${updated.enabled ? "🟢 Enabled" : "⏸️ Disabled"} **${row.name}** (\`${id}\`).`,
      flags: MessageFlags.Ephemeral,
    });
  }

  async cmdScheduleEdit(i: ScheduleInteraction): Promise<void> {
    const id = await this.normalizeId(
      i,
      "edit",
      "id",
      i.options.getString("id", true)
    );
    const row = this.ports.repository.get(id);
    const channel = i.channelRef;
    if (!row || !channel || row.channelRef !== channel.id) {
      await i.reply({ content: `No schedule \`${id}\` in this thread.`, flags: MessageFlags.Ephemeral });
      return;
    }
    return this.cmdScheduleAdd(i, row);
  }

  async cmdScheduleAdd(i: ScheduleInteraction, existing?: ScheduledPrompt): Promise<void> {
    const channel = i.channelRef;
    if (!channel) {
      await i.respondInitial( { content: "Use `/seamadmin schedule add` inside a thread." });
      return;
    }
    const { agent: inheritedAgent, registered: profile, model: sessionModel, cwd: inheritedCwd, models } = this.ports.builderDefaults(channel);

    const state = {
      name: existing?.name ?? "",
      promptText: existing?.promptText ?? "",
      cron: (existing?.cron ?? null) as string | null,
      timezone: existing?.timezone ?? SCHEDULE_DEFAULT_TZ,
      model: existing?.model ?? null, // null = inherit effective thread model at fire time
      cwd: existing?.cwd ?? null, // null = inherit effective thread cwd at fire time
      target: existing?.targetChannel ?? null, // null = this thread
      outputType: (existing?.outputType ?? "card") as "card" | "messages",
      sessionMode: (existing?.sessionMode ?? "isolated") as "isolated" | "live",
    };
    const quarantine = existing ? legacyAttachmentQuarantine(existing) : null;

    const render = () => {
      const cronLine = state.cron
        ? `${describeCron(state.cron)} \`${state.cron}\``
        : "*(not set)*";
      const next = state.cron ? cronNextRun(state.cron, state.timezone) : null;
      const isLive = state.sessionMode === "live";
      const embed = new EmbedBuilder()
        .setTitle(existing ? `✏️ Edit scheduled prompt \`${existing.id}\`` : "⏰ New scheduled prompt")
        .setColor(SCHEDULED_COLOR)
        .setDescription(
          (isLive
            ? "This runs **in this thread**, as a real turn on this conversation's session. " +
              "It streams like a normal message, shares and remembers this thread's context, and " +
              "waits its turn if the thread is busy."
            : "This runs **on its own, on a clean session** — it won't remember this conversation. " +
              "Write the prompt so it stands alone.") +
            " Schedules don't carry files: for anything substantial, commit a runbook to the repo and " +
            "have the prompt ask the agent to read it." +
            (profile
              ? ""
              : `\n\n⚠️ Effective agent \`${inheritedAgent}\` is not registered on this bot — isolated fires will fail closed.`) +
            (quarantine ? `\n\n⚠️ ${quarantine}` : "")
        )
        .addFields(
          { name: "🏷️ Name", value: state.name || "*(not set)*" },
          { name: "✏️ Prompt", value: state.promptText ? "```\n" + state.promptText.slice(0, 1000) + "\n```" : "*(not set — click ✏️ Prompt & name)*" },
          { name: "🕐 Runs", value: cronLine + (next ? `\nNext: <t:${Math.floor(next.getTime() / 1000)}:F>` : ""), inline: true },
          { name: "🌍 Timezone", value: state.timezone, inline: true },
          { name: "🧠 Session", value: isLive ? "live (in this thread)" : "isolated (clean session)", inline: true },
          ...(isLive ? [] : [
            { name: "Agent", value: `\`${inheritedAgent}\``, inline: true },
            { name: "🤖 Model", value: state.model ? `\`${state.model}\`` : `Thread default (\`${sessionModel}\`)`, inline: true },
            { name: "📂 Working dir", value: state.cwd ? `\`${state.cwd}\`` : `\`${inheritedCwd}\``, inline: true },
            { name: "📮 Output to", value: state.target ? `<#${state.target}>` : "*(this thread)*", inline: true },
            { name: "🖼️ Output as", value: state.outputType === "messages" ? "plain messages" : "status cards", inline: true },
          ])
        );
      const cadence = new StringSelectMenuBuilder()
        .setCustomId("sched:cadence")
        .setPlaceholder("🕐 How often?")
        .addOptions(SCHEDULE_PRESETS.map((p) => ({ label: p.label, value: p.value })));
      const tz = new StringSelectMenuBuilder()
        .setCustomId("sched:tz")
        .setPlaceholder("🌍 Timezone")
        .addOptions(SCHEDULE_TIMEZONES.map((z) => ({ label: z, value: z, default: z === state.timezone })));
      const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("sched:prompt").setLabel("✏️ Prompt & details").setStyle(ButtonStyle.Primary),
        ...(isLive ? [] : [
          new ButtonBuilder().setCustomId("sched:output").setLabel(state.outputType === "messages" ? "🖼️ Output: messages" : "🖼️ Output: cards").setStyle(ButtonStyle.Secondary),
        ]),
        new ButtonBuilder().setCustomId("sched:mode").setLabel(isLive ? "🧠 Session: live" : "🧵 Session: isolated").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("sched:create").setLabel(existing ? "💾 Save" : "✅ Create").setStyle(ButtonStyle.Success).setDisabled(!state.cron || !state.promptText || !state.name),
        new ButtonBuilder().setCustomId("sched:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
      );
      const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(cadence),
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(tz),
      ];
      if (models.length > 0 && !isLive) {
        const modelSelect = new StringSelectMenuBuilder()
          .setCustomId("sched:model")
          .setPlaceholder("🤖 Model")
          .addOptions(
            { label: `Thread default (${sessionModel})`.slice(0, 100), value: "__default__", default: state.model === null },
            ...models.map((m) => ({ label: m.name.slice(0, 100), value: m.modelId, default: m.modelId === state.model }))
          );
        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modelSelect));
      }
      rows.push(buttons);
      return { embeds: [embed], components: rows };
    };

    await i.respondInitial( render());
    const msg = await i.fetchReply();
    const collector = msg.createMessageComponentCollector({
      filter: (c) => c.user.id === i.user.id,
      time: 600_000,
    });
    const lifecycle = i.attachLifecycle(collector, () =>
      expiredCardView(
        "⏰ Schedule builder timed out — nothing was saved. Run the schedule builder again to start over."
      )
    );

    collector.on("collect", async (c) => {
      try {
        if (c.isStringSelectMenu() && c.customId === "sched:tz") {
          state.timezone = c.values[0]!;
          await c.update(render());
        } else if (c.isStringSelectMenu() && c.customId === "sched:model") {
          const v = c.values[0]!;
          state.model = v === "__default__" ? null : v;
          await c.update(render());
        } else if (c.isStringSelectMenu() && c.customId === "sched:cadence") {
          const v = c.values[0]!;
          if (v === "__custom__") {
            const modal = new ModalBuilder().setCustomId(`sched:cronmodal:${msg.id}`).setTitle("Custom schedule")
              .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId("cron").setLabel("Cron expression (min hour dom mon dow)")
                  .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder("0 9 * * 1-5")
              ));
            await c.showModal(modal);
            const sub = await c.awaitModalSubmit({ filter: (m) => m.customId === `sched:cronmodal:${msg.id}` && m.user.id === i.user.id, time: 120_000 }).catch(() => null);
            if (sub) {
              const cron = sub.fields.getTextInputValue("cron").trim();
              const v2 = validateCron(cron, state.timezone);
              if (!v2.ok) {
                await sub.reply({ content: `❌ Invalid cron: ${v2.error}`, flags: MessageFlags.Ephemeral });
              } else {
                state.cron = cron;
                await sub.deferUpdate();
                await i.editReply(render());
              }
            }
          } else {
            state.cron = v;
            await c.update(render());
          }
        } else if (c.isButton() && c.customId === "sched:output") {
          state.outputType = state.outputType === "messages" ? "card" : "messages";
          await c.update(render());
        } else if (c.isButton() && c.customId === "sched:mode") {
          state.sessionMode = state.sessionMode === "live" ? "isolated" : "live";
          await c.update(render());
        } else if (c.isButton() && c.customId === "sched:prompt") {
          const modalLive = state.sessionMode === "live";
          const modalRows: ActionRowBuilder<TextInputBuilder>[] = [
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId("name").setLabel("Name").setStyle(TextInputStyle.Short).setRequired(true).setValue(state.name).setMaxLength(80)
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId("prompt")
                .setLabel(modalLive ? "Prompt (runs in this thread, with context)" : "Prompt (stands on its own — no prior context)")
                .setStyle(TextInputStyle.Paragraph).setRequired(true).setValue(state.promptText)
                .setPlaceholder("e.g. Run `npm test`, then post any failures as file:line with a one-line fix.")
            ),
          ];
          if (!modalLive) {
            modalRows.push(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId("cwd").setLabel("Working dir (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(state.cwd ?? "")
                  .setPlaceholder("blank = this thread's repo; or a path under REPOS_ROOT")
              ),
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder().setCustomId("target").setLabel("Output channel/thread id (optional)").setStyle(TextInputStyle.Short).setRequired(false).setValue(state.target ?? "")
                  .setPlaceholder("blank = post here; or a numeric channel/thread id")
              )
            );
          }
          const modal = new ModalBuilder().setCustomId(`sched:promptmodal:${msg.id}`).setTitle("Prompt & details").addComponents(...modalRows);
          await c.showModal(modal);
          const sub = await c.awaitModalSubmit({ filter: (m) => m.customId === `sched:promptmodal:${msg.id}` && m.user.id === i.user.id, time: 600_000 }).catch(() => null);
          if (sub) {
            state.name = sub.fields.getTextInputValue("name").trim();
            state.promptText = sub.fields.getTextInputValue("prompt").trim();
            const errors: string[] = [];
            if (!modalLive) {
              const rawCwd = sub.fields.getTextInputValue("cwd").trim();
              if (rawCwd) {
                try { state.cwd = resolveRepoPath(this.ports.reposRoot, rawCwd); }
                catch (e) { errors.push(`cwd: ${(e as Error).message}`); }
              } else state.cwd = null;
              const rawTarget = sub.fields.getTextInputValue("target").trim();
              if (rawTarget) {
                if (/^\d+$/.test(rawTarget)) state.target = rawTarget;
                else errors.push("output id must be a numeric channel/thread id");
              } else state.target = null;
            }
            await sub.deferUpdate();
            await i.editReply(render());
            if (errors.length) await sub.followUp({ content: `⚠️ ${errors.join("; ")}`, flags: MessageFlags.Ephemeral });
          }
        } else if (c.isButton() && c.customId === "sched:cancel") {
          await c.deferUpdate();
          await lifecycle.terminal("cancel", { content: "Cancelled.", embeds: [], components: [] });
        } else if (c.isButton() && c.customId === "sched:create") {
          await c.deferUpdate();
          if (!state.name || !state.promptText || !state.cron) {
            const missing: string[] = [];
            if (!state.name) missing.push("a name");
            if (!state.promptText) missing.push("a prompt");
            if (!state.cron) missing.push("a cadence/schedule");
            await c.followUp({
              content: `⚠️ Not created yet — still need ${missing.join(", ")}. Use **Prompt & details** to set the name + prompt and pick a cadence, then click Create.`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const now = new Date().toISOString();
          const next = cronNextRun(state.cron, state.timezone);
          const live = state.sessionMode === "live";
          const persistedModel = live ? null : state.model;
          const persistedCwd = live ? null : state.cwd;
          const persistedTarget = live ? null : state.target;
          const persistedOutput: "card" | "messages" = live ? "card" : state.outputType;
          let row: ScheduledPrompt;
          if (existing) {
            row = {
              ...existing,
              name: state.name, promptText: state.promptText, cron: state.cron, timezone: state.timezone,
              model: persistedModel, cwd: persistedCwd, targetChannel: persistedTarget, outputType: persistedOutput,
              sessionMode: state.sessionMode,
              legacyAttachmentCount: 0,
              updatedUtc: now, nextRunUtc: next ? next.toISOString() : null,
            };
            this.ports.repository.save(row);
            this.ports.admin.reschedule(existing.id);
          } else {
            const id = `sch_${randomUUID().slice(0, 8)}`;
            row = {
              id, platform: PLATFORM, channelRef: channel.id, parentRef: channel.parentId ?? null,
              name: state.name, promptText: state.promptText, cron: state.cron, timezone: state.timezone,
              model: persistedModel, cwd: persistedCwd, targetChannel: persistedTarget, outputType: persistedOutput,
              sessionMode: state.sessionMode,
              catchupSeconds: 7200, enabled: true, legacyAttachmentCount: 0, createdBy: i.user.id,
              createdUtc: now, updatedUtc: now, lastRunUtc: null, lastStatus: null,
              nextRunUtc: next ? next.toISOString() : null, pinnedSessionId: null,
            };
            this.ports.repository.save(row);
            this.ports.admin.arm(row);
          }
          const confirm = new EmbedBuilder()
            .setTitle(existing ? "✏️ Scheduled prompt updated" : "⏰ Scheduled prompt created")
            .setColor(0x2ecc71)
            .setDescription(
              `**${state.name}** \`${row.id}\`\nRuns ${describeCron(state.cron)} (${state.timezone})` +
              `\nSession: ${live ? "🧠 live (in this thread)" : "🧵 isolated (clean session)"}` +
              (live ? "" :
                (state.model ? `\nModel: \`${state.model}\`` : "") +
                (state.cwd ? `\nWorking dir: \`${state.cwd}\`` : "") +
                (state.target ? `\nOutput to: <#${state.target}>` : "") +
                `\nOutput as: ${state.outputType === "messages" ? "plain messages" : "status cards"}`) +
              (next ? `\nNext run: <t:${Math.floor(next.getTime() / 1000)}:F>` : "") +
              (quarantine
                ? `\n\n📎 Cleared this schedule's legacy reference files (#158) — it can run again. ` +
                  `The stored bytes were left on disk under \`data/scheduled-attachments/${row.id}/\`.`
                : "") +
              (existing && !row.enabled ? `\n\n⏸️ This schedule is currently disabled — enable it with \`/seamadmin schedule toggle\`.` : "") +
              `\n\nManage it with \`/seamadmin schedule list\`.`
            );
          await lifecycle.terminal(existing ? "saved" : "created", {
            embeds: [confirm],
            components: [],
          });
        }
      } catch (err) {
        this.logger.error({ err }, "schedule builder interaction failed");
      }
    });
  }

}

export function createScheduleUiPlugin(ports: ScheduleUiPorts): Plugin {
  const ui = new ScheduleUi(ports);
  const group = { name: "schedule", description: "Recurring scheduled prompts for this thread" };
  const slash: SlashContribution[] = SCHEDULE_LEAVES.map(({ name, description, handle, id }) => ({
    command: "seamadmin", group,
    leaf: { type: Option.Subcommand, name, description, ...(id ? { options: [
      { type: Option.String, name: "id", description: name === "remove" ? "Schedule id (see /seamadmin schedule list)" : "Schedule id", required: true, autocomplete: true },
    ] } : {}) },
    access: { kind: name === "list" ? "read-only" : "mutating" }, authorization: "user",
    help: `/seamadmin schedule ${name}${id ? " id" : ""} — ${description}`,
    ...(id ? { autocomplete: [{ option: "id", policy: "opaque" as const, respond: ui.autocomplete.get("schedule", name, "id")! }] } : {}),
    handle: async invocation => ui[handle](ports.interaction(invocation)),
  }));
  return {
    id: "schedule-ui", apiVersion: 1, builtin: true, internal: true,
    activate: context => { ui.logger = context.logger; },
    contributions: { slash, components: ["sl:", "sched:"].map(namespace => ({
      namespace, types: ["button", "select", "modal"] as const, lifetime: "collector" as const,
      access: "read-only" as const, authorization: "user" as const, handle: async () => {},
    })) },
  };
}
