import { PresetCards, routePresetView, type PresetCard, type PresetBuilderCard, type PresetListCard, type PresetController } from "./cards.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import type { Preset, PermissionPolicyMode, StatusCardStyle } from "../../core/types.js";
import type { ChannelRef } from "../../platforms/chat-adapter.js";
import type { PresetInteraction, PresetClick, PresetUiPorts } from "./ports.js";
import { expiredCardView } from "../../platforms/discord/collector-lifecycle.js";
import { paginatePresetList, PRESET_LIST_PAGE_SIZE } from "../../platforms/discord/preset-list.js";
import { choicePickerPageCaption } from "../../platforms/discord/choice-picker.js";
import { catalogEffortChoices } from "../../platforms/discord/catalog-view.js";
import { INHERIT_VALUE } from "../../platforms/discord/config-editor.js";
import { presetModelSelectOptions } from "./view.js";
const PRESET_COLOR = 0x9b59b6;
export class PresetUi {
  get repository() { return this.ports.repository; }
  readonly cards: PresetCards;
  constructor(readonly ports: PresetUiPorts) {
    this.cards = new PresetCards(ports, card => this.resumeCard(card));
  }
  private restoredInteraction(card: PresetCard): PresetInteraction {
    const reply = this.ports.reply(card.target, card.owner, card.channel?.id ?? "");
    return { cardReply: reply, user: { id: card.owner }, channelRef: card.channel, channelId: card.channel?.id,
      parentId: card.channel?.parentId, projectScopeId: card.projectRef ?? undefined, deferred: true, replied: true,
      options: { getString: (() => "") as PresetInteraction["options"]["getString"], getBoolean: () => null, getInteger: () => null },
      reply: view => reply.followUp(view as never), editReply: view => reply.editReply(typeof view === "string" ? { content: view } : view),
      deferReply: async () => {}, fetchReply: async () => ({ id: "" }),
    };
  }
  private async resumeCard(card: PresetCard): Promise<PresetController> {
    const i = this.restoredInteraction(card);
    return card.kind === "list" ? this.openPresetList(i, card, true) : this.cmdPresetBuilder(i, card.existing, card.projectRef, undefined, card);
  }
  get logger() { return this.ports.logger; }
  private async openEditorAfterFreeze(c: PresetClick, open: () => Promise<unknown>, surface: string, retryCommand: string): Promise<void> {
    try { await open(); }
    catch (err) {
      this.logger.warn({ err, surface }, "editor failed to open after list freeze");
      await c.editReply({ content: `❌ Could not open the ${surface} editor. Run \`${retryCommand}\` again.`, embeds: [], components: [] }).catch(() => {});
    }
  }
  private presetSummaryLine(p: Preset): string {
    const parts: string[] = [];
    if (p.agentId) parts.push(`Agent: ${p.agentId}`);
    if (p.model) parts.push(`Model: ${p.model}`);
    if (p.effort) parts.push(`Effort: ${p.effort}`);
    if (p.repoPath) parts.push(`Repo: ${this.ports.repoDisplay(p.repoPath)}`);
    if (p.role) parts.push(`Role: ${p.role}`);
    if (p.disableThreadPrefix) parts.push("Auto-name: disabled");
    if (p.permission) parts.push(`Policy: ${p.permission}`);
    if (p.statusCardStyle) parts.push(`Card: ${p.statusCardStyle}`);
    if (p.toolsAllow?.length) parts.push(`Allow: ${p.toolsAllow.join(", ")}`);
    if (p.toolsExclude?.length) parts.push(`Exclude: ${p.toolsExclude.join(", ")}`);
    if (p.instructions) parts.push("📝 Has instructions");
    const scope = p.projectRef ? "📁" : "🌐";
    const desc = p.description ? ` — ${p.description}` : "";
    const config = parts.length > 0 ? `\n   ${parts.join(" · ")}` : "";
    return `${scope} **${p.name}**${desc}${config}`;
  }

  private buildPresetListMessage(
    projectRef: string | null,
    page = 0
  ): {
    embeds: EmbedBuilder[];
    components: ActionRowBuilder<ButtonBuilder>[];
  } {
    const presets = this.repository.listPresetsForProject(projectRef);
    const slice = paginatePresetList(presets, page);
    const caption = choicePickerPageCaption(
      presets.length,
      slice.page,
      PRESET_LIST_PAGE_SIZE
    );
    const body = slice.items.length
      ? slice.items.map((p) => this.presetSummaryLine(p)).join("\n\n")
      : "_No presets in this project yet._";
    const embed = new EmbedBuilder()
      .setTitle("🎛️ Presets")
      .setColor(PRESET_COLOR)
      .setDescription(
        [body, caption, "_📁 this project · 🌐 global_"].filter(Boolean).join("\n\n")
      );
    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    // Discord caps a message at 5 action rows. Four preset rows leave room
    // for Prev / Page X/Y / Next when there is more than one page.
    for (const p of slice.items) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`pr:apply:${p.id}`)
            .setLabel(`▶️ ${p.name}`.slice(0, 80))
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`pr:edit:${p.id}`)
            .setLabel("✏️ Edit")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`pr:del:${p.id}`)
            .setLabel("🗑️ Delete")
            .setStyle(ButtonStyle.Danger)
        )
      );
    }
    if (slice.pageCount > 1) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`pr:page:${slice.page - 1}`)
            .setLabel("◀ Prev")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(slice.page === 0),
          new ButtonBuilder()
            .setCustomId(`pr:page:${slice.page}`)
            .setLabel(`Page ${slice.page + 1}/${slice.pageCount}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId(`pr:page:${slice.page + 1}`)
            .setLabel("Next ▶")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(slice.page >= slice.pageCount - 1)
        )
      );
    }
    return { embeds: [embed], components };
  }

  async cmdPresetList(i: PresetInteraction): Promise<void> {
    const projectRef = i.projectScopeId ?? null;
    const presets = this.repository.listPresetsForProject(projectRef);
    if (presets.length === 0) {
      await i.reply({
        content: "No presets here yet. Create one with `/seam preset create`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const card: PresetListCard = { kind: "list", id: randomUUID(), owner: i.user.id, channel: i.channelRef,
      projectRef, target: "", expires: 0, page: 0 };
    await this.openPresetList(i, card);
  }

  private async openPresetList(i: PresetInteraction, card: PresetListCard, restored = false): Promise<PresetController> {
    const projectRef = card.projectRef;
    if (!restored) {
      await i.reply({ ...routePresetView(this.buildPresetListMessage(projectRef, card.page), card.id), flags: MessageFlags.Ephemeral });
      await i.fetchReply();
      card.target = i.cardReply.target; card.expires = Date.now() + 600_000;
      this.cards.checkpoint(card);
    }
    return this.cards.bind(card, view => i.reply(view), () =>
      expiredCardView("⏰ Preset list expired. Run `/seam preset list` again."), async (c, lifecycle) => {
      try {
        if (!c.isButton()) return;
        const [, action, id] = c.customId.split(":");
        if (!id) return;
        if (action === "page") {
          const requested = Number(id);
          if (!Number.isFinite(requested)) return;
          const remaining = this.repository.listPresetsForProject(projectRef);
          card.page = paginatePresetList(remaining, requested).page;
          this.cards.checkpoint(card);
          await c.update(routePresetView(this.buildPresetListMessage(projectRef, card.page), card.id));
          return;
        }
        const refusal = c.mutationRefusal();
        if (refusal) {
          await c.reply({ content: refusal, flags: MessageFlags.Ephemeral });
          return;
        }
        const preset = this.repository.getPreset(id);
        if (!preset) {
          await c.reply({
            content: "That preset no longer exists.",
            flags: MessageFlags.Ephemeral,
          });
          // Repeatable: rebuild from the store so the vanished row's controls go.
          await lifecycle.refresh(this.buildPresetListMessage(projectRef, card.page));
          return;
        }
        if (action === "apply") {
          const channel = c.channelRef;
          if (!channel) {
            await c.reply({
              content: "Use inside a thread to apply a preset.",
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          const summary = await this.ports.apply(channel, preset);
          await c.reply({
            content: `✅ Applied preset **${preset.name}**.\n${summary}`,
            flags: MessageFlags.Ephemeral,
          });
        } else if (action === "edit") {
          // Close the list, acknowledge the click, then repaint before opening the editor.
          await lifecycle.transitionWithAck(
            "edit",
            {
              content: `✏️ Editing preset **${preset.name}** — this listing was replaced by the editor below.`,
              embeds: [],
              components: [],
            },
            async () => {
              await c.deferReply({ flags: MessageFlags.Ephemeral });
            }
          );
          await this.openEditorAfterFreeze(
            c,
            () => this.cmdPresetBuilder(c, preset),
            "preset",
            "/seam preset edit"
          );
        } else if (action === "del") {
          this.repository.deletePreset(id);
          const remaining = this.repository.listPresetsForProject(projectRef);
          card.page = paginatePresetList(remaining, card.page).page;
          this.cards.checkpoint(card);
          await c.update(routePresetView(this.buildPresetListMessage(projectRef, card.page), card.id));
        }
      } catch (err) {
        this.logger.warn({ err }, "preset-list button handler failed");
      }
    });
  }

  async cmdPresetCreate(i: PresetInteraction): Promise<void> {
    // A new preset is stamped with the current project by default; `--global`
    // makes it a global preset visible in every project.
    const global = i.options.getBoolean("global") ?? false;
    const createScope = global ? null : i.projectScopeId ?? null;
    const seedRole = i.options.getString("role");
    await this.cmdPresetBuilder(i, undefined, createScope, seedRole);
  }

  async cmdPresetEdit(i: PresetInteraction): Promise<void> {
    const name = i.options.getString("name", true);
    const preset = this.repository.getPresetByNameScoped(name, i.projectScopeId ?? null);
    if (!preset) {
      await i.reply({ content: `No preset named \`${name}\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
    await this.cmdPresetBuilder(i, preset);
  }

  /**
   * Interactive preset builder card: selects for agent/model/effort, modals for
   * the free-text fields, and a save button. Shared by `create` and `edit`.
   */
  async cmdPresetBuilder(
    i: PresetInteraction,
    existing?: Preset,
    createScope?: string | null,
    seedRole?: string | null,
    restored?: PresetBuilderCard
  ): Promise<PresetController> {
    const { location: presetLocation, profiles } = restored ?? this.ports.builderDefaults(i.channelRef);

    // Scope is fixed at creation: editing preserves the preset's scope, while a
    // new preset takes `createScope` (the current project, or null for global).
    const projectRef: string | null = existing
      ? existing.projectRef ?? null
      : createScope ?? null;

    const state: {
      name: string;
      description: string;
      agentId: string | null;
      model: string | null;
      effort: string | null;
      repoPath: string | null;
      permission: PermissionPolicyMode | null;
      toolsAllow: string[] | null;
      toolsExclude: string[] | null;
      instructions: string | null;
      statusCardStyle: StatusCardStyle | null;
      role: string | null;
      disableThreadPrefix: boolean | null;
    } = restored?.draft ?? {
      name: existing?.name ?? "",
      description: existing?.description ?? "",
      agentId: existing?.agentId ?? null,
      model: existing?.model ?? null,
      effort: existing?.effort ?? null,
      repoPath: existing?.repoPath ?? null,
      permission: existing?.permission ?? null,
      toolsAllow: existing?.toolsAllow ?? null,
      toolsExclude: existing?.toolsExclude ?? null,
      instructions: existing?.instructions ?? null,
      statusCardStyle: existing?.statusCardStyle ?? null,
      role: existing?.role ?? (seedRole?.trim() || null),
      disableThreadPrefix: existing?.disableThreadPrefix ?? null,
    };

    // Preset editing uses only the controller's cache for this thread's host;
    // it never starts an ACP session or reads an adapter source. Presets remain
    // locationless, so applying one elsewhere revalidates against that host.
    const loadModels = async (
      agentId: string | null
    ): Promise<ReadonlyArray<{ modelId: string; name: string }>> => {
      if (!agentId) return [];
      return this.ports.catalog.models({ agentId, location: presetLocation }, { current: state.model ?? undefined })
        .map((model) => ({ modelId: model.id, name: model.displayName }));
    };
    let models = await loadModels(state.agentId);
    const repoDirs = restored?.repoDirs ?? (await this.ports.listWorkspace(i.channelRef)) ?? [];
    const card: PresetBuilderCard = restored ?? { kind: "builder", id: randomUUID(), owner: i.user.id, channel: i.channelRef,
      projectRef, existing, draft: state, location: presetLocation, profiles, repoDirs, target: "", expires: 0, modals: {} };
    if (!restored) this.cards.states.set(card.id, card);

    const render = () => {
      if (card.target && this.cards.states.has(card.id)) this.cards.checkpoint(card);
      const agentDisplay = state.agentId ? `\`${state.agentId}\`` : "*(default)*";
      const modelDisplay = state.model ? `\`${state.model}\`` : "*(default)*";
      const effortDisplay = state.effort ?? "*(default)*";
      const repoDisplay = state.repoPath
        ? `\`${this.ports.repoDisplay(state.repoPath)}\``
        : "*(default)*";
      const permDisplay = state.permission ?? "*(default)*";
      const cardDisplay = state.statusCardStyle ? `\`${state.statusCardStyle}\`` : "*(default)*";
      const toolsDisplay = (() => {
        const parts: string[] = [];
        if (state.toolsAllow?.length) parts.push(`Allow: ${state.toolsAllow.join(", ")}`);
        if (state.toolsExclude?.length) parts.push(`Exclude: ${state.toolsExclude.join(", ")}`);
        return parts.length > 0 ? parts.join("\n") : "*(default)*";
      })();
      const instrDisplay = state.instructions
        ? "```\n" + state.instructions.slice(0, 500) + "\n```"
        : "*(none)*";

      const embed = new EmbedBuilder()
        .setTitle(existing ? `✏️ Edit preset \`${existing.name}\`` : "🎛️ New preset")
        .setColor(PRESET_COLOR)
        .setDescription(
          "A preset is a reusable bundle of session settings. " +
          "When applied, it overrides only the fields it specifies — everything else keeps its default."
        )
        .addFields(
          { name: "🏷️ Name", value: state.name || "*(not set)*" },
          { name: "🗂️ Scope", value: projectRef ? `<#${projectRef}>` : "🌐 Global" },
          { name: "📝 Description", value: state.description || "*(none)*" },
          { name: "🤖 Agent", value: agentDisplay, inline: true },
          { name: "🧠 Model", value: modelDisplay, inline: true },
          { name: "⚡ Effort", value: effortDisplay, inline: true },
          { name: "📂 Repo", value: repoDisplay, inline: true },
          { name: "🎭 Role", value: state.role ? `\`${state.role}\`` : "*(none)*", inline: true },
          { name: "🏷️ Auto-name", value: state.disableThreadPrefix ? "disabled" : "enabled", inline: true },
          { name: "🔒 Permission", value: permDisplay, inline: true },
          { name: "🃏 Status card", value: cardDisplay, inline: true },
          { name: "🔧 Tools", value: toolsDisplay },
          { name: "📋 Instructions", value: instrDisplay }
        );

      const agentSelect = new StringSelectMenuBuilder()
        .setCustomId("preset:agent")
        .setPlaceholder("🤖 Agent")
        .addOptions(
          { label: "Default", value: "__default__", default: state.agentId === null },
          ...profiles.slice(0, 24).map((p) => ({
            label: p.displayName.slice(0, 100),
            value: p.id,
            description: p.id.slice(0, 100),
            default: p.id === state.agentId,
          }))
        );

      const modelSelect = new StringSelectMenuBuilder()
        .setCustomId("preset:model")
        .setPlaceholder("🧠 Model");
      if (models.length > 0) {
        modelSelect.addOptions(presetModelSelectOptions(models, state.model));
      } else {
        modelSelect.addOptions({
          label: state.agentId
            ? "Default (no models advertised for this agent)"
            : "Default (select an agent first for model list)",
          value: "__default__",
          default: true,
        });
      }

      const effortLevels = state.agentId
        ? this.ports.catalog.model(
            { agentId: state.agentId, location: presetLocation },
            state.model ?? "default"
          )?.effort.choices.map((choice) => choice.id) ?? []
        : [];
      const effortSelect = new StringSelectMenuBuilder()
        .setCustomId("preset:effort")
        .setPlaceholder("⚡ Effort")
        .addOptions(
          { label: "Default", value: "__default__", default: state.effort === null },
          ...catalogEffortChoices(effortLevels.filter((value) => value !== "default")).slice(0, 24).map((e) => ({
            label: e.label,
            value: e.value,
            description: e.description,
            default: e.value === state.effort,
          }))
        );

      const repoSelect = new StringSelectMenuBuilder()
        .setCustomId("preset:repo")
        .setPlaceholder("📂 Repo");
      const repoOpts: Array<{
        label: string;
        value: string;
        description?: string;
        default?: boolean;
      }> = [
        {
          label: "Inherit / clear (no pin)",
          value: "__default__",
          description: "Don't pin a repo on this preset",
          default: state.repoPath === null,
        },
      ];
      const fit = repoDirs.filter((p) => p.length <= 100);
      for (const p of fit.slice(0, 23)) {
        repoOpts.push({
          label: path.basename(p).slice(0, 100) || p.slice(0, 100),
          value: p,
          description: p.slice(0, 100),
          default: p === state.repoPath,
        });
      }
      if (
        state.repoPath &&
        state.repoPath.length <= 100 &&
        !repoOpts.some((o) => o.value === state.repoPath)
      ) {
        repoOpts.splice(1, 0, {
          label: path.basename(state.repoPath).slice(0, 100),
          value: state.repoPath,
          description: state.repoPath.slice(0, 100),
          default: true,
        });
      }
      if (fit.length > 23 || fit.length < repoDirs.length) {
        repoOpts.push({
          label: "More… (full picker)",
          value: "__more__",
          description: "Open the paginated repo picker",
        });
      }
      repoSelect.addOptions(repoOpts);

      const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("preset:details")
          .setLabel("✏️ Name & details")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("preset:tools")
          .setLabel("🔧 Tools")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("preset:card")
          .setLabel(state.statusCardStyle ? `🃏 ${state.statusCardStyle}` : "🃏 Card")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("preset:naming")
          .setLabel("🏷️ Naming")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("preset:save")
          .setLabel(existing ? "💾 Save" : "✅ Create")
          .setStyle(ButtonStyle.Success)
          .setDisabled(!state.name),
      );

      return routePresetView({
        embeds: [embed],
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(agentSelect),
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modelSelect),
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(effortSelect),
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(repoSelect),
          buttons,
        ],
      }, card.id);
    };

    if (!restored) {
      // Edit from a list already acknowledged the component.

      await i.reply(render());
      await i.fetchReply();
      card.target = i.cardReply.target; card.expires = Date.now() + 600_000;
      this.cards.checkpoint(card);
    }
    const showModal = async (c: PresetClick, modal: ModalBuilder) => {
      const action = modal.data.custom_id!;
      card.modals[action] = Date.now() + 300_000;
      this.cards.checkpoint(card);
      await c.showModal(modal.setCustomId(`${action}:${card.id}`));
    };
    return this.cards.bind(card, view => i.reply(view), () =>
      expiredCardView("⏰ Preset builder timed out — nothing was saved. Run the command again."), async (c, lifecycle) => {
      try {
        if (c.isModalSubmit() && c.customId === "preset:details-modal") {
          state.name = c.fields.getTextInputValue("name").trim();
          state.description = c.fields.getTextInputValue("desc").trim();
          const permVal = c.fields
            .getTextInputValue("permission")
            .trim()
            .toLowerCase();
          state.permission =
            permVal === "always" || permVal === "ask" || permVal === "deny"
              ? permVal
              : null;
          const instrVal = c.fields.getTextInputValue("instr").trim();
          state.instructions = instrVal || null;
          await c.deferUpdate();
          await i.reply(render());
          return;
        }
        if (c.isModalSubmit() && c.customId === "preset:naming-modal") {
          const rawRole = c.fields.getTextInputValue("role").trim();
          state.role = !rawRole || rawRole.toLowerCase() === "auto" ? null : rawRole;
          const rawDisable = c.fields.getTextInputValue("disable").trim().toLowerCase();
          state.disableThreadPrefix = rawDisable === "yes" || rawDisable === "true"
            ? true
            : rawDisable === "no" || rawDisable === "false" || rawDisable === ""
              ? null
              : state.disableThreadPrefix;
          await c.deferUpdate();
          await i.reply(render());
          return;
        }
        if (c.isModalSubmit() && c.customId === "preset:tools-modal") {
          const allow = parseCsv(c.fields.getTextInputValue("allow"));
          const exclude = parseCsv(c.fields.getTextInputValue("exclude"));
          state.toolsAllow = allow.length > 0 ? allow : null;
          state.toolsExclude = exclude.length > 0 ? exclude : null;
          await c.deferUpdate();
          await i.reply(render());
          return;
        }
        if (c.isModalSubmit() && c.customId === "preset:instr-modal") {
          const val = c.fields.getTextInputValue("instr").trim();
          state.instructions = val || null;
          await c.deferUpdate();
          await i.reply(render());
          return;
        }
        if (c.isStringSelectMenu() && c.customId === "preset:agent") {
          const v = c.values[0]!;
          state.agentId = v === "__default__" ? null : v;
          // Model ids are agent-specific; a stale pick would be invalid.
          state.model = null;
          state.effort = null;
          await c.deferUpdate();
          models = await loadModels(state.agentId);
          await c.editReply(render());
        } else if (c.isStringSelectMenu() && c.customId === "preset:model") {
          const v = c.values[0]!;
          if (v === "__more__") {
            await c.deferUpdate();
            const channel = c.channelRef;
            if (!channel || !this.ports.transport.sendChoicePicker) return;
            const picked = await this.ports.transport.sendChoicePicker(channel, {
              panel: {
                color: PRESET_COLOR,
                title: "🧠 Choose a preset model",
                fields: [{ name: "Current", value: state.model ? `\`${state.model}\`` : "Default" }],
              },
              choices: models.map((model) => ({
                value: model.modelId,
                label: model.name,
                description: model.modelId,
              })),
              authorizedUserIds: new Set([i.user.id]),
            });
            if (picked && picked.value !== state.model) {
              state.model = picked.value;
              state.effort = state.agentId
                ? this.ports.catalog.model(
                    { agentId: state.agentId, location: presetLocation },
                    picked.value
                  )?.effort.selectionDefault ?? null
                : null;
            }
            await i.reply(render());
            return;
          }
          const nextModel = v === "__default__" ? null : v;
          if (nextModel !== state.model) {
            state.model = nextModel;
            state.effort = nextModel && state.agentId
              ? this.ports.catalog.model(
                  { agentId: state.agentId, location: presetLocation },
                  nextModel
                )?.effort.selectionDefault ?? null
              : null;
          }
          await c.update(render());
        } else if (c.isStringSelectMenu() && c.customId === "preset:effort") {
          const v = c.values[0]!;
          state.effort = v === "__default__" ? null : v;
          await c.update(render());
        } else if (c.isStringSelectMenu() && c.customId === "preset:repo") {
          const v = c.values[0]!;
          if (v === "__more__") {
            await c.deferUpdate();
            const channel = c.channelRef;
            if (!channel) return;
            const picked = await this.ports.promptRepoPath(channel, {
              title: "📂 Preset repo",
              includeInherit: true,
              authorizedUserIds: new Set([i.user.id]),
            });
            if (picked === INHERIT_VALUE) {
              state.repoPath = null;
            } else if (picked) {
              try {
                state.repoPath = await this.ports.resolveRequestedRepoPath(channel, picked);
              } catch {
                state.repoPath = picked;
              }
            }
            await i.reply(render());
          } else {
            state.repoPath = v === "__default__" ? null : v;
            await c.update(render());
          }
        } else if (c.isButton() && c.customId === "preset:card") {
          state.statusCardStyle =
            state.statusCardStyle === null
              ? "full"
              : state.statusCardStyle === "full"
                ? "simple"
                : null;
          await c.update(render());
        } else if (c.isButton() && c.customId === "preset:details") {
          const modal = new ModalBuilder()
            .setCustomId("preset:details-modal")
            .setTitle("Preset details");
          modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("name")
                .setLabel("Name (required)")
                .setStyle(TextInputStyle.Short)
                .setMaxLength(80)
                .setValue(state.name)
                .setRequired(true)
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("desc")
                .setLabel("Description")
                .setStyle(TextInputStyle.Short)
                .setMaxLength(200)
                .setValue(state.description)
                .setRequired(false)
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("permission")
                .setLabel("Permission: always / ask / deny")
                .setStyle(TextInputStyle.Short)
                .setMaxLength(10)
                .setValue(state.permission ?? "")
                .setRequired(false)
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("instr")
                .setLabel("Instructions (worker identity)")
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(4000)
                .setValue(state.instructions ?? "")
                .setRequired(false)
            ),
          );
          await showModal(c, modal);
        } else if (c.isButton() && c.customId === "preset:naming") {
          const modal = new ModalBuilder()
            .setCustomId("preset:naming-modal")
            .setTitle("Preset naming");
          modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("role")
                .setLabel("Role (empty / auto = none)")
                .setStyle(TextInputStyle.Short)
                .setMaxLength(64)
                .setValue(state.role ?? "")
                .setRequired(false)
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("disable")
                .setLabel("Disable auto-name? yes / no")
                .setStyle(TextInputStyle.Short)
                .setMaxLength(3)
                .setValue(state.disableThreadPrefix ? "yes" : "no")
                .setRequired(false)
            )
          );
          await showModal(c, modal);
        } else if (c.isButton() && c.customId === "preset:tools") {
          const modal = new ModalBuilder()
            .setCustomId("preset:tools-modal")
            .setTitle("Tool lists");
          modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("allow")
                .setLabel("Allow list (comma-separated, blank = all)")
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(1000)
                .setValue(state.toolsAllow?.join(", ") ?? "")
                .setRequired(false)
            ),
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("exclude")
                .setLabel("Exclude list (comma-separated)")
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(1000)
                .setValue(state.toolsExclude?.join(", ") ?? "")
                .setRequired(false)
            )
          );
          await showModal(c, modal);
        } else if (c.isButton() && c.customId === "preset:instr") {
          const modal = new ModalBuilder()
            .setCustomId("preset:instr-modal")
            .setTitle("Custom instructions");
          modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("instr")
                .setLabel("Instructions (worker identity)")
                .setStyle(TextInputStyle.Paragraph)
                .setMaxLength(4000)
                .setValue(state.instructions ?? "")
                .setRequired(false)
            )
          );
          await showModal(c, modal);
        } else if (c.isButton() && c.customId === "preset:save") {
          if (!state.name) {
            await c.reply({ content: "Name is required.", flags: MessageFlags.Ephemeral });
            return;
          }
          // Names are matched case-insensitively, so guard against a collision
          // that differs only in case — but only WITHIN the same scope, so a
          // project preset may reuse a name that exists globally or elsewhere.
          if (!existing || existing.name.toLowerCase() !== state.name.toLowerCase()) {
            const found = this.repository.getPresetByNameScoped(state.name, projectRef);
            const collision = found && (found.projectRef ?? null) === projectRef;
            if (collision) {
              await c.reply({
                content:
                  `A ${projectRef ? "project" : "global"} preset named ` +
                  `\`${state.name}\` already exists.`,
                flags: MessageFlags.Ephemeral,
              });
              return;
            }
          }
          const now = new Date().toISOString();
          const preset: Preset = {
            id: existing?.id ?? `pre_${randomUUID().slice(0, 8)}`,
            name: state.name,
            projectRef,
            description: state.description || null,
            agentId: state.agentId,
            model: state.model,
            effort: state.effort,
            repoPath: state.repoPath,
            permission: state.permission,
            toolsAllow: state.toolsAllow,
            toolsExclude: state.toolsExclude,
            instructions: state.instructions,
            statusCardStyle: state.statusCardStyle,
            role: state.role,
            disableThreadPrefix: state.disableThreadPrefix,
            createdBy: existing?.createdBy ?? i.user.id,
            createdUtc: existing?.createdUtc ?? now,
            updatedUtc: now,
          };
          this.repository.upsertPreset(preset);
          await c.deferUpdate();
          await lifecycle.terminal(existing ? "saved" : "created", {
            content: `${existing ? "💾 Updated" : "✅ Created"} preset **${preset.name}** (\`${preset.id}\`).`,
            embeds: [],
            components: [],
          });
        } else if (c.isButton() && c.customId === "preset:cancel") {
          await c.deferUpdate();
          await lifecycle.terminal("cancel", { content: "Cancelled.", embeds: [], components: [] });
        }
      } catch (err) {
        this.logger.warn({ err }, "preset builder interaction failed");
      }
    });
  }

  async cmdPresetApply(i: PresetInteraction): Promise<void> {
    const name = i.options.getString("name", true);
    const preset = this.repository.getPresetByNameScoped(name, i.projectScopeId ?? null);
    if (!preset) {
      await i.reply({ content: `No preset named \`${name}\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const channel = i.channelRef;
    if (!channel) {
      await i.reply({
        content: "Use `/seam preset apply` inside a thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const summary = await this.ports.apply(channel, preset);
    await i.reply(`✅ Applied preset **${preset.name}**.\n${summary}`);
  }

  /**
   * `/seam preset thread` (#93): create NEW thread(s) under the parent channel
   * (sibling if invoked inside a thread — same path as `/seam new`) and bind
   * the picked preset's full config onto each session. `quantity` > 1 allocates
   * stable role-group numbers without colliding in-loop.
   */
  async cmdPresetThread(i: PresetInteraction): Promise<void> {
    const rawName = i.options.getString("name") ?? "";
    const presetName = (i.options.getString("preset", true) ?? "").trim();
    if (!presetName) {
      await i.reply({
        content: "Pick a preset from the list — that field can't be blank.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const preset = this.repository.getPresetByNameScoped(
      presetName,
      i.projectScopeId ?? null
    );
    if (!preset) {
      await i.reply({
        content:
          `No preset named \`${presetName}\` in this project. Use \`/seam preset list\` to see what's available.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!this.ports.canCreateThread) {
      await i.reply({
        content: "This platform does not support creating threads.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!i.channelId) {
      await i.reply({ content: "No channel.", flags: MessageFlags.Ephemeral });
      return;
    }
    const quantityRaw = i.options.getInteger("quantity");
    const quantity =
      typeof quantityRaw === "number" && Number.isInteger(quantityRaw)
        ? Math.max(1, quantityRaw)
        : 1;
    // `name` is only honored for a single spawn.
    const name = quantity === 1 ? rawName.trim() : "";
    const parentId =
      i.parentId ?? i.channelId;
    const effectiveRole = preset.role ?? this.ports.defaultRole(parentId) ?? null;

    // Discord requires an initial acknowledgement within three seconds. Auto-
    // naming may need to inspect many sibling threads, so acknowledge before
    // that I/O instead of letting large projects intermittently expire here.


    if (quantity > 1 && !effectiveRole) {
      await i.reply("Multiple threads need a role so their prefixes can be enumerated.");
      return;
    }

    const baseName = name || preset.name || "seam";

    const created: ChannelRef[] = [];
    let lastSummary = "";
    try {
      for (let index = 0; index < quantity; index += 1) {
        const { thread, summary } = await this.ports.createFromPreset(i.channelId, baseName, i.user.id, preset);
        lastSummary = summary;
        created.push(thread);
      }
      if (created.length === 1 && quantity === 1) {
        await i.reply(
          `🧵 Created <#${created[0]!.id}> from preset **${preset.name}**.\n${lastSummary}`
        );
        return;
      }
      const links = created.map((t) => `• <#${t.id}>`).join("\n");
      const header = `🧵 Created ${created.length} threads from preset **${preset.name}**:`;
      await i.reply(links ? `${header}\n${links}` : header);
    } catch (err) {
      this.logger.warn({ err }, "/seam preset thread failed");
      try {
        const links = created.map((t) => `• <#${t.id}>`).join("\n");
        const prefix = created.length
          ? `Created ${created.length} of ${quantity} before failing: ${(err as Error).message}`
          : `Could not create the thread: ${(err as Error).message}`;
        await i.reply(links ? `${prefix}\n${links}` : prefix);
      } catch {
        /* already replied */
      }
    }
  }

  async cmdPresetShow(i: PresetInteraction): Promise<void> {
    const name = i.options.getString("name", true);
    const preset = this.repository.getPresetByNameScoped(name, i.projectScopeId ?? null);
    if (!preset) {
      await i.reply({ content: `No preset named \`${name}\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle(`🎛️ Preset: ${preset.name}`)
      .setColor(PRESET_COLOR)
      .setDescription(preset.description || "*(no description)*")
      .addFields(
        { name: "🗂️ Scope", value: preset.projectRef ? `<#${preset.projectRef}>` : "🌐 Global", inline: true },
        { name: "🤖 Agent", value: preset.agentId ? `\`${preset.agentId}\`` : "*(default)*", inline: true },
        { name: "🧠 Model", value: preset.model ? `\`${preset.model}\`` : "*(default)*", inline: true },
        { name: "⚡ Effort", value: preset.effort ?? "*(default)*", inline: true },
        { name: "📂 Repo", value: preset.repoPath ? `\`${this.ports.repoDisplay(preset.repoPath)}\`` : "*(default)*", inline: true },
        { name: "🎭 Role", value: preset.role ? `\`${preset.role}\`` : "*(none)*", inline: true },
        { name: "🏷️ Auto-name", value: preset.disableThreadPrefix ? "disabled" : "enabled", inline: true },
        { name: "🔒 Permission", value: preset.permission ?? "*(default)*", inline: true },
        { name: "🃏 Status card", value: preset.statusCardStyle ?? "*(default)*", inline: true },
        { name: "🔧 Tools allow", value: preset.toolsAllow?.join(", ") || "*(all)*" },
        { name: "🔧 Tools exclude", value: preset.toolsExclude?.join(", ") || "*(none)*" },
        {
          name: "📋 Instructions",
          value: preset.instructions
            ? "```\n" + preset.instructions.slice(0, 1000) + "\n```"
            : "*(none)*",
        }
      )
      .setFooter({
        text: `ID: ${preset.id} · Created by ${preset.createdBy} · ${preset.createdUtc}`,
      });
    await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  async cmdPresetDelete(i: PresetInteraction): Promise<void> {
    const name = i.options.getString("name", true);
    const preset = this.repository.getPresetByNameScoped(name, i.projectScopeId ?? null);
    if (!preset) {
      await i.reply({ content: `No preset named \`${name}\`.`, flags: MessageFlags.Ephemeral });
      return;
    }
    this.repository.deletePreset(preset.id);
    await i.reply({
      content: `🗑️ Deleted preset **${preset.name}** (\`${preset.id}\`).`,
      flags: MessageFlags.Ephemeral,
    });
  }

}

function parseCsv(s: string): string[] { return s.split(",").map(x => x.trim()).filter(x => x.length > 0); }
