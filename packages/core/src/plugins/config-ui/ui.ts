import { ConfigEditorStore } from "./store.js";
import { randomUUID } from "node:crypto";
import { EmbedBuilder, MessageFlags } from "discord.js";
import type { ComponentEvent, IncomingMessage, ChannelRef } from "../../platforms/chat-adapter.js";
import type { CatalogBinding } from "../../core/model-catalog/service.js";
import { LOCAL_LOCATION, parseAgentAtLocation } from "../../core/location.js";
import { configSetRequestError, CONFIG_SET_FIELD_NAMES, type ConfigSetFieldName, type ConfigSetRequest } from "../../core/config-apply-plan.js";
import { configTarget, formatOverrideCounts, type ConfigDefaultField } from "../../core/config-target.js";
import { FAST_MODE_CONFIG_ID, FAST_MODE_COST_WARNING, FAST_MODE_RESET_NOTICE, isFastModeDisabledByEnv, fastModeEnvRefusal, fastModeAgentRefusal } from "../../core/fast-mode.js";
import { catalogEffortChoices } from "../../platforms/discord/catalog-view.js";
import { INHERIT_VALUE, RIDER_MODAL_MAX, applyPickerValue, authorizeDraftClick, currentRiderText, decodeRiderUpload, editScopeOf, effectiveAgentAtLocation, isDirty, makeCustomId, parseCustomId, renderCancelledHub, renderExpiredHub, renderHub, renderSavedHub, riderDownloadFilename, riderTooLong, snapshotFromDescribe, type DraftAgentCapabilities, type ThreadConfigDraft } from "../../platforms/discord/config-editor.js";
import type { ComponentAcknowledgementContext, ComponentResponseMode } from "../../platforms/interaction-response.js";
import { findAuditEntry, formatConfigAuditDetail, formatConfigAuditView } from "../../platforms/discord/config-audit-view.js";
import { clampFieldValue } from "../../platforms/discord/workflows-view.js";
import type { ConfigInteraction, ConfigUiPorts } from "./ports.js";
import { configSetRequest, configSetSummary, saveConfigEditorCard } from "./view.js";
import { buildSavePlan } from "../../platforms/discord/config-editor.js";
import type { SlashInvocation } from "../slash-registry.js";

const CONFIG_AUDIT_COLOR = 0x8e44ad;

export class ConfigUi {
  readonly configEditor = new ConfigEditorStore();
  constructor(readonly ports: ConfigUiPorts) {}
  private get logger() { return this.ports.logger; }

  async cmdConfigCleanup(i: SlashInvocation): Promise<void> {
    const preview = await this.ports.cleanup.preview();
    const rows = preview.entries.filter(entry => entry.sessionId).length;
    const pins = preview.entries.filter(entry => entry.threadEntry).length;
    await i.reply(`Dry-run only: ${rows} misfiled parent session rows, ${pins} parent thread entries. Nothing applied.`);
    if (!preview.entries.length) return;
    const channel: ChannelRef = { platform: "discord", id: i.threadId, ...(i.parentId ? { parentId: i.parentId } : {}) };
    const details = preview.entries.map(entry => `${entry.guildName} / ${entry.name} (${entry.id}):\n` +
      `Move: ${JSON.stringify(entry.changes)}. Preserve existing channel fields: ${entry.preserved.join(", ") || "none"}. ` +
      `Thread overrides: ${formatOverrideCounts(entry.overrides)}.`).join("\n\n");
    await this.ports.transport.sendMessage(channel, details);
    await this.ports.transport.sendChoicePicker?.(channel, {
      panel: { title: "Confirm parent configuration cleanup", description: "Preserves existing channel defaults and thread overrides. Deletes only the listed misfiled parent rows and entries.", color: 0x5865f2, fields: [] },
      choices: [{ value: "keep", label: "Leave unchanged" }, { value: "apply", label: "Confirm: apply this preview" }],
      authorizedUserIds: new Set([i.actor.id]),
      commit: async picked => {
        if (picked.value === "apply") {
          const count = await this.ports.cleanup.apply(preview, i.actor);
          this.logger.warn({ count, actor: i.actor }, "confirmed parent configuration cleanup applied");
          await i.reply(`Applied cleanup to ${count} parent channels. Existing channel defaults and thread overrides preserved.`);
        }
        return { ok: true };
      },
    });
  }

  async offerFollowChannel(channel: ChannelRef, user: ConfigInteraction["user"], fields: readonly ConfigDefaultField[]): Promise<void> {
    const id = configTarget(channel, "channel").id;
    const counts = this.ports.overrideCounts(id, fields);
    if (!Object.values(counts).some(count => count! > 0) || !this.ports.transport.sendChoicePicker) return;
    await this.ports.transport.sendChoicePicker(channel, {
      panel: { title: "Apply channel defaults to existing threads?", color: 0x5865f2,
        fields: [],
        description: `Thread overrides (${formatOverrideCounts(counts)}) stay unchanged unless you confirm. Only these fields will be cleared.` },
      choices: [{ value: "keep", label: "Keep thread overrides" }, { value: "apply", label: "Confirm: use channel defaults" }],
      authorizedUserIds: new Set([user.id]),
      commit: async picked => {
        if (picked.value === "apply") await this.ports.followChannel(id, fields, { id: user.id, name: user.displayName ?? user.username });
        return { ok: true };
      },
    });
  }

  async setChannel(i: ConfigInteraction, request: ConfigSetRequest): Promise<void> {
    const channel = i.channelRef!;
    const target = configTarget(channel, "channel");
    if (!this.ports.canEditChannelPreset(i.user.id, target.id)) {
      await i.reply("Channel-preset edits require a config admin.");
      return;
    }
    const prepared = await this.ports.prepareChannelSet(channel, request);
    if (!prepared.ok) { await i.reply(prepared.message); return; }
    const applied = await this.ports.applyChannelSet(channel, prepared.prepared, { id: i.user.id, name: i.user.displayName ?? i.user.username });
    if (!applied.ok) { await i.reply(applied.message); return; }
    const fields = Object.keys(prepared.prepared.changes) as ConfigDefaultField[];
    await i.reply(`Channel default updated. Effective: ${configSetSummary(applied.effective, this.ports.repoDisplay)}. Thread overrides: ${formatOverrideCounts(this.ports.overrideCounts(target.id, fields))}.`);
    await this.offerFollowChannel(channel, i.user, fields);
  }

  /** Direct commands and their pickers share the same scope as bulk set and Save. */
  async cmdScopedField(i: ConfigInteraction, field: ConfigSetFieldName, option: string): Promise<boolean> {
    const channel = i.channelRef;
    if (!channel) return false;
    const value = i.options.getString(option);
    const target = configTarget(channel, i.options.getString("scope"));
    if (target.kind === "thread") {
      if (value !== INHERIT_VALUE && value !== "inherit") return false;
      const key = field === "repo" ? "cwd" : field === "card" ? "statusCardStyle" : field === "gif" ? "simpleCardGif" : field;
      const fields: ConfigDefaultField[] = field === "agent" ? ["agent", "model", "effort"] : field === "model" ? ["model", "effort"] : [key as ConfigDefaultField];
      const effective = await this.ports.clearThreadOverrides(channel, fields, { id: i.user.id, name: i.user.username });
      await i.reply(`Thread override cleared. Effective: ${configSetSummary(effective, this.ports.repoDisplay)}.`);
      return true;
    }
    const requestFor = (next: string): ConfigSetRequest => ({ json: null, rebuild: false, scope: "channel",
      supplied: [field], values: { ...Object.fromEntries(CONFIG_SET_FIELD_NAMES.map(key => [key, null])), [field]: next } as ConfigSetRequest["values"] });
    if (value !== null) { await this.setChannel(i, requestFor(value)); return true; }
    const snapshot = this.ports.snapshot({ platform: channel.platform, id: target.id }).desc;
    if (field === "role") { await i.reply(`Channel role: ${snapshot.role.value ?? "none"} (from ${snapshot.role.source}).`); return true; }
    if (!this.ports.canEditChannelPreset(i.user.id, target.id)) { await i.reply("Channel-preset edits require a config admin."); return true; }
    await i.reply("Posting channel-default picker…");
    if (field === "repo") {
      const picked = await this.ports.promptRepoPath(channel, { title: "Choose channel repo", location: LOCAL_LOCATION, authorizedUserIds: new Set([i.user.id]), includeInherit: true });
      if (picked !== null) await this.setChannel(i, requestFor(picked));
      return true;
    }
    const binding = { agentId: snapshot.agent.value, location: LOCAL_LOCATION };
    const choices = field === "agent" ? this.ports.agentChoices().filter(choice => !parseAgentAtLocation(choice.value).explicit || parseAgentAtLocation(choice.value).location === LOCAL_LOCATION)
      .map(choice => ({ ...choice, value: parseAgentAtLocation(choice.value).agentId }))
      : field === "model" ? this.ports.catalog.models(binding, { includeHidden: false }).map(model => ({ value: model.id, label: model.displayName }))
      : catalogEffortChoices(this.ports.catalog.effortChoices(binding, snapshot.model.value));
    let changedFields: ConfigDefaultField[] = [];
    const picked = await this.ports.transport.sendChoicePicker?.(channel, {
      panel: { title: `Choose channel ${field}`, color: 0x5865f2, fields: [] },
      choices: [{ value: INHERIT_VALUE, label: "Use global default" }, ...choices], authorizedUserIds: new Set([i.user.id]),
      commit: async selected => {
        const prepared = await this.ports.prepareChannelSet(channel, requestFor(selected.value));
        if (!prepared.ok) return { ok: false, error: prepared.message };
        const applied = await this.ports.applyChannelSet(channel, prepared.prepared, { id: i.user.id, name: i.user.username });
        if (!applied.ok) return { ok: false, error: applied.message };
        changedFields = Object.keys(prepared.prepared.changes) as ConfigDefaultField[];
        await i.reply(`Channel default updated. Effective: ${configSetSummary(applied.effective, this.ports.repoDisplay)}. Thread overrides: ${formatOverrideCounts(this.ports.overrideCounts(target.id))}.`);
        return { ok: true };
      },
    });
    if (picked) await this.offerFollowChannel(channel, i.user, changedFields);
    return true;
  }
  async cmdConfig(i: ConfigInteraction): Promise<void> {
    const record = i.channelRef;
    if (!record) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const cfg = this.ports.readConfig(record);
    await i.reply({
      content: this.ports.codeBlock(JSON.stringify(cfg, null, 2), "json"),
      flags: MessageFlags.Ephemeral,
    });
  }

  /** `/seam config edit` — visual draft-then-save hub (#90). Does not abort a live turn. */
  async cmdConfigEdit(i: ConfigInteraction): Promise<void> {
    const channel = i.channelRef;
    if (!channel) {
      await i.reply({
        content: "Use `/seam config edit` in a channel or thread.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!this.ports.transport.sendPanel) {
      await i.reply({
        content: "This platform cannot render the config editor card.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await i.reply({
      content: "Opening config editor…",
      flags: MessageFlags.Ephemeral,
    });
    await this.openConfigEditorCard(channel, i.user.id, i.options.getString("scope"));
  }

  /** Post an owned editor draft; parent-channel drafts never bind a session. */
  async openConfigEditorCard(
    channel: ChannelRef,
    userId: string,
    scope?: string | null
  ): Promise<ThreadConfigDraft | null> {
    if (!this.ports.transport.sendPanel) return null;
    const { desc, withoutThread, channelPins } = this.ports.snapshot(channel);
    const now = Date.now();
    const draft: ThreadConfigDraft = {
      id: randomUUID(),
      threadId: channel.id,
      parentRef: channel.parentId ?? channel.id,
      channelOnly: !channel.parentId,
      userId,
      createdAt: now,
      updatedAt: now,
      snapshot: {
        ...snapshotFromDescribe(desc, withoutThread),
        channelPins,
      },
      overlay: {},
      warnings: [],
      editScope: configTarget(channel, scope).kind,
    };
    const evicted = this.configEditor.put(draft);
    if (evicted?.messageId) {
      await this.editConfigEditorCard(channel, evicted.messageId, renderExpiredHub(evicted));
    }
    const panel = renderHub(draft, {
      modelHidden: this.ports.catalog.isHidden?.(this.catalogBindingForDraft(draft), this.catalogModelForDraft(draft)),
      effortDisabled: this.effortDisabledFor(draft),
      fastDisabled: this.fastDisabledFor(draft),
      canEditChannel: this.ports.canEditChannelPreset(userId,
        channel.parentId
      ),
    });
    const ref = await this.ports.transport.sendPanel(channel, panel);
    return this.configEditor.touch(draft.id, { messageId: ref.id }) ?? draft;
  }

  /**
   * #37: hide the Fast control unless the drafted agent actually has Fast (and
   * the deployment has not killed it). Offering a button that could only ever
   * refuse is worse than not offering one.
   */
  private fastDisabledFor(draft: ThreadConfigDraft): boolean {
    if (isFastModeDisabledByEnv()) return true;
    const agentId =
      draft.overlay.agent === undefined
        ? draft.snapshot.agent.value
        : draft.overlay.agent ?? draft.snapshot.withoutThread.agent;
    return !this.ports.hasFastMode(agentId);
  }

  private catalogBindingForDraft(draft: ThreadConfigDraft): CatalogBinding {
    const channelScope = editScopeOf(draft) === "channel";
    const selectedAgent = channelScope
      ? draft.overlay.channelAgent === undefined
        ? draft.snapshot.channelPins?.agent ?? draft.snapshot.withoutThread.agent
        : draft.overlay.channelAgent ?? draft.snapshot.withoutThread.agent
      : effectiveAgentAtLocation(draft);
    const parsed = parseAgentAtLocation(selectedAgent);
    return {
      agentId: parsed.agentId,
      location: channelScope ? LOCAL_LOCATION : parsed.explicit ? parsed.location : draft.snapshot.location.value,
    };
  }

  private catalogModelForDraft(draft: ThreadConfigDraft): string {
    const channelScope = editScopeOf(draft) === "channel";
    return channelScope
      ? draft.overlay.channelModel === undefined
        ? draft.snapshot.channelPins?.model ?? draft.snapshot.withoutThread.model
        : draft.overlay.channelModel ?? draft.snapshot.withoutThread.model
      : draft.overlay.model === undefined
        ? draft.snapshot.model.value
        : draft.overlay.model ?? draft.snapshot.withoutThread.model;
  }

  private effortDisabledFor(draft: ThreadConfigDraft): boolean {
    const model = this.ports.catalog.model(
      this.catalogBindingForDraft(draft),
      this.catalogModelForDraft(draft)
    );
    return !model || model.effort.mechanism === "none" ||
      model.effort.choices.every((choice) => choice.id === "default");
  }

  private capsForAgent = (agentId: string, location = LOCAL_LOCATION): DraftAgentCapabilities | undefined => {
    const models = this.ports.catalog.models({ agentId, location }, { includeHidden: true });
    if (!models.length) return undefined;
    return {
      models: models.map((model) => ({
        modelId: model.id,
        effortMechanism: model.effort.mechanism,
        effortLevels: model.effort.choices.map((choice) => choice.id),
        effortDefault: model.effort.selectionDefault,
      })),
    };
  };

  async editConfigEditorCard(
    channel: ChannelRef,
    messageId: string,
    panel: ReturnType<typeof renderHub>
  ): Promise<void> {
    if (!this.ports.transport.editPanel) return;
    try {
      await this.ports.transport.editPanel({ channel, id: messageId }, panel);
    } catch (err) {
      this.logger.warn({ err, messageId }, "config editor hub edit failed");
    }
  }

  private async refreshConfigEditorHub(draft: ThreadConfigDraft): Promise<void> {
    if (!draft.messageId) return;
    const panel = renderHub(draft, {
      modelHidden: this.ports.catalog.isHidden?.(this.catalogBindingForDraft(draft), this.catalogModelForDraft(draft)),
      effortDisabled: this.effortDisabledFor(draft),
      fastDisabled: this.fastDisabledFor(draft),
      canEditChannel: this.ports.canEditChannelPreset(draft.userId,
        draft.parentRef
      ),
    });
    await this.editConfigEditorCard(
      { platform: "discord", id: draft.threadId, ...(draft.parentRef ? { parentId: draft.parentRef } : {}) },
      draft.messageId,
      panel
    );
  }

  private async downloadConfigEditorRider(
    draft: ThreadConfigDraft,
    evt: ComponentEvent
  ): Promise<void> {
    const scope = editScopeOf(draft);
    const text = currentRiderText(draft);
    const noun = scope === "channel" ? "channel rider" : "thread rider";
    if (text == null || text.length === 0) {
      await evt
        .followUpEphemeral(`No ${noun} to download. Use **Upload** to set one, then Save.`)
        .catch(() => {});
      return;
    }
    if (!this.ports.transport.sendFile) {
      await evt.followUpEphemeral("This platform cannot send files.").catch(() => {});
      return;
    }
    await this.ports.transport.sendFile(evt.channel, {
      data: Buffer.from(text, "utf8"),
      filename: riderDownloadFilename(
        scope === "channel" ? (draft.parentRef ?? draft.threadId) : draft.threadId,
        scope
      ),
      mimeType: "text/markdown",
      caption: `${scope === "channel" ? "Channel" : "Thread"} rider (draft if you already edited). **Save** on the card to persist.`,
    });
  }

  /**
   * If this user has a config-editor draft waiting for a rider file in this
   * thread, consume the message (do not start/abort a turn).
   */
  async tryConsumeConfigEditorRiderUpload(msg: IncomingMessage): Promise<boolean> {
    const draft = this.configEditor.getForUserThread(msg.authorId, msg.channel.id);
    if (!draft?.awaitingRiderUpload) return false;
    const atts = msg.attachments ?? [];
    if (atts.length === 0) {
      await this.ports.transport
        .sendMessage(
          msg.channel,
          "📎 Need a `.md` or `.txt` attachment for the rider (or click **Cancel** on the config card)."
        )
        .catch(() => {});
      return true;
    }
    const att = atts[0]!;
    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`download ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const decoded = decodeRiderUpload(buf, att.filename);
      if (!decoded.ok) {
        await this.ports.transport.sendMessage(msg.channel, `📎 ${decoded.error}`).catch(() => {});
        return true;
      }
      const next = applyPickerValue(
        { ...draft, awaitingRiderUpload: false },
        "rider",
        decoded.text ?? "",
        this.capsForAgent
      );
      next.awaitingRiderUpload = false;
      this.configEditor.put(next);
      await this.refreshConfigEditorHub(next);
      await this.ports.transport
        .sendMessage(
          msg.channel,
          decoded.text == null
            ? `📝 Rider upload is empty — draft will **inherit/clear** the ${editScopeOf(draft) === "channel" ? "channel" : "thread"} rider. Click **Save** to apply.`
            : `📝 Rider loaded from \`${att.filename}\` (${decoded.text.length} chars). Click **Save** on the card to apply.`
        )
        .catch(() => {});
    } catch (err) {
      this.logger.warn({ err }, "config editor rider upload failed");
      await this.ports.transport
        .sendMessage(msg.channel, "📎 Could not read that file. Try again.")
        .catch(() => {});
    }
    return true;
  }

  acknowledgement(evt: ComponentAcknowledgementContext): ComponentResponseMode {
    const parsed = parseCustomId(evt.customId);
    if (evt.kind !== "button" || !parsed) return "update";
    if (parsed.action === "role") return "modal";
    const draft = this.configEditor.get(parsed.draftId);
    return parsed.action === "rider" && draft && !riderTooLong(draft) ? "modal" : "update";
  }

  async handleConfigEditorComponent(evt: ComponentEvent): Promise<void> {
    const parsed = parseCustomId(evt.customId);
    if (!parsed) return;
    let draft = this.configEditor.get(parsed.draftId);
    const auth = authorizeDraftClick(draft, evt.userId);
    if (auth === "not-yours") {
      await evt.replyEphemeral("This editor isn't yours.");
      return;
    }
    if (auth === "expired" || !draft) {
      if (evt.messageId) {
        await this.editConfigEditorCard(evt.channel, evt.messageId, {
          color: 0x99aab5,
          title: "🧩 Thread config",
          fields: [],
          footer: "draft expired",
          actions: [],
        });
      }
      return;
    }

    const action = parsed.action;
    if (draft.awaitingRiderUpload && action !== "rider-put") {
      this.configEditor.touch(draft.id, { awaitingRiderUpload: false });
      draft = this.configEditor.get(draft.id) ?? draft;
    }
    if (action === "save") {
      if (!isDirty(draft)) {
        await evt.replyEphemeral("Nothing to save.");
        return;
      }
      await this.saveConfigEditorDraft(draft, evt);
      return;
    }
    if (action === "scope") {
      if (
        !this.ports.canEditChannelPreset(evt.userId, draft.parentRef)
      ) {
        await evt.replyEphemeral(
          "Channel-preset edits need a config admin (locked channels refuse non-admins)."
        );
        return;
      }
      const nextScope = editScopeOf(draft) === "channel" ? "thread" : "channel";
      this.configEditor.touch(draft.id, {
        editScope: nextScope,
        awaitingRiderUpload: false,
      });
      const next = this.configEditor.get(draft.id) ?? { ...draft, editScope: nextScope };
      await this.refreshConfigEditorHub(next);
      return;
    }
    if (action === "cancel") {
      this.configEditor.delete(draft.id);
      if (draft.messageId) {
        await this.editConfigEditorCard(evt.channel, draft.messageId, renderCancelledHub(draft));
      }
      return;
    }
    if (action === "rider-get") {
      await this.downloadConfigEditorRider(draft, evt);
      return;
    }
    if (action === "rider-put") {
      this.configEditor.touch(draft.id, { awaitingRiderUpload: true });
      const waiting = this.configEditor.get(draft.id) ?? draft;
      await this.refreshConfigEditorHub(waiting);
      await evt
        .followUpEphemeral(
          `Attach a \`.md\` or \`.txt\` file in this thread. It becomes the **draft** ${editScopeOf(draft) === "channel" ? "channel" : "thread"} rider (Save still required). Empty file = inherit/clear. Cancel the editor to abort.`
        )
        .catch(() => {});
      return;
    }
    if (action === "rider-save" || (evt.kind === "modal" && action === "rider-save")) {
      const text = evt.fields?.rider ?? "";
      const next = applyPickerValue(
        draft,
        "rider",
        text,
        this.capsForAgent
      );
      this.configEditor.put(next);
      await this.refreshConfigEditorHub(next);
      return;
    }

    if (action === "role-save" || (evt.kind === "modal" && action === "role-save")) {
      const text = evt.fields?.role ?? "";
      const next = applyPickerValue(draft, "role", text, this.capsForAgent);
      this.configEditor.put(next);
      await this.refreshConfigEditorHub(next);
      return;
    }

    if (action === "role") {
      const channelScope = editScopeOf(draft);
      const current =
        channelScope
          ? (draft.overlay.channelRole === undefined
              ? draft.snapshot.channelPins?.role ?? ""
              : draft.overlay.channelRole ?? "")
          : (draft.overlay.role === undefined
              ? draft.snapshot.role.value ?? ""
              : draft.overlay.role ?? "");
      await evt.showModal({
        customId: makeCustomId(draft.id, "role-save"),
        title: channelScope ? "Channel role" : "Thread role",
        inputs: [
          {
            id: "role",
            label: channelScope
              ? "Role (empty/auto = inherit)"
              : "Role (empty/auto = inherit)",
            style: "short",
            value: String(current).slice(0, 64) || undefined,
            maxLength: 64,
            required: false,
          },
        ],
      });
      return;
    }

    if (action === "rider") {
      if (riderTooLong(draft)) {
        await this.pickConfigEditorField(draft, "rider", evt);
        return;
      }
      const current = currentRiderText(draft) ?? "";
      const channelScope = editScopeOf(draft) === "channel";
      await evt.showModal({
        customId: makeCustomId(draft.id, "rider-save"),
        title: channelScope ? "Channel rider" : "Thread rider",
        inputs: [
          {
            id: "rider",
            label: channelScope
              ? "Channel rider (empty = inherit)"
              : "Thread rider (empty = inherit)",
            style: "paragraph",
            value: current.slice(0, RIDER_MODAL_MAX) || undefined,
            maxLength: RIDER_MODAL_MAX,
            required: false,
          },
        ],
      });
      return;
    }

    await this.pickConfigEditorField(draft, action, evt);
  }

  async saveConfigEditorDraft(draft: ThreadConfigDraft, evt: ComponentEvent): Promise<void> {
    try {
      await saveConfigEditorCard(draft, evt, {
        saveEditor: this.ports.saveEditor, deleteDraft: id => this.configEditor.delete(id),
        editCard: (channel, message, panel) => this.editConfigEditorCard(channel, message, panel),
        channelSaved: async saved => {
          const fields = Object.keys(buildSavePlan(saved).channelPreset ?? {}) as ConfigDefaultField[];
          if (!fields.length || !saved.parentRef) return;
          await evt.followUpEphemeral(`Channel default saved. Thread overrides: ${formatOverrideCounts(this.ports.overrideCounts(saved.parentRef, fields))}.`);
          await this.offerFollowChannel(evt.channel, { id: evt.userId, username: evt.userName }, fields);
        },
      });
    } catch (err) {
      this.logger.warn({ err, threadId: draft.threadId }, "config editor Save failed");
      await evt.followUpEphemeral(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async pickConfigEditorField(
    draft: ThreadConfigDraft,
    action: string,
    evt: ComponentEvent
  ): Promise<void> {
    const channel: ChannelRef = {
      platform: "discord",
      id: draft.threadId,
      ...(draft.parentRef ? { parentId: draft.parentRef } : {}),
    };
    const owner = new Set([draft.userId]);
    const channelScope = editScopeOf(draft) === "channel";
    const inherit = {
      value: INHERIT_VALUE,
      label: "Inherit",
      description: channelScope
        ? "Clear the channel-preset pin"
        : "Clear this thread's overlay",
    };

    if (!this.ports.transport.sendChoicePicker && action !== "rider") {
      return;
    }

    let picked: { value: string; userId: string } | null = null;
    const field = action as Parameters<typeof applyPickerValue>[1];

    if (action === "agent") {
      // #156: there is no separate Host control — an agent id encodes its host,
      // so this picker offers every `agentId@host` the fleet actually has and
      // is the single writer of the thread's location.
      const choices = this.ports.agentChoices();
      const current = channelScope
        ? draft.overlay.channelAgent === undefined
          ? draft.snapshot.channelPins?.agent ?? "not set"
          : draft.overlay.channelAgent ?? "not set"
        : effectiveAgentAtLocation(draft);
      picked = await this.ports.transport.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: channelScope ? "🤖 Choose an agent" : "🤖 Choose an agent @ host",
          fields: [{ name: "Current", value: `\`${current}\``, inline: true }],
        },
        choices: [inherit, ...choices],
        authorizedUserIds: owner,
      });
    } else if (action === "model") {
      const binding = this.catalogBindingForDraft(draft);
      const agentId = binding.agentId;
      const models = this.ports.catalog.models(binding, { current: this.catalogModelForDraft(draft) });
      const choices = models.map((m) => ({
        value: m.id,
        label: m.displayName,
        description: m.id,
      }));
      if (choices.length === 0) {
        await this.ports.transport.sendMessage(
          channel,
          `No advertised models for \`${agentId}\` — Inherit is still available.`
        );
      }
      picked = await this.ports.transport.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: "🧠 Choose a model",
          fields: [{ name: "Agent", value: `\`${agentId}\``, inline: true }],
        },
        choices: [inherit, ...choices],
        authorizedUserIds: owner,
      });
    } else if (action === "effort") {
      if (this.effortDisabledFor(draft)) return;
      const supported = this.ports.catalog.effortChoices(
        this.catalogBindingForDraft(draft),
        this.catalogModelForDraft(draft)
      );
      const effortChoices = catalogEffortChoices(supported).slice(0, 24);
      picked = await this.ports.transport.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: "🧠 Choose reasoning effort",
          fields: [],
        },
        choices: [inherit, ...effortChoices],
        authorizedUserIds: owner,
      });
    } else if (action === "repo") {
      const loc =
        draft.overlay.location === undefined
          ? draft.snapshot.location.value
          : draft.overlay.location ?? draft.snapshot.withoutThread.location;
      picked = await this.ports.promptRepoPath(channel, {
        title: "🗂️ Choose a working repo",
        location: loc,
        authorizedUserIds: owner,
        includeInherit: true,
      }).then((value) => (value ? { value, userId: draft.userId } : null));
    } else if (action === "approve") {
      picked = await this.ports.transport.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: "🔐 Permission policy",
          fields: [
            { name: "Current", value: `\`${draft.snapshot.permission.value}\``, inline: true },
          ],
        },
        choices: [
          inherit,
          { value: "always", label: "always", description: "Auto-approve every request" },
          { value: "ask", label: "ask", description: "Prompt in Discord" },
          { value: "deny", label: "deny", description: "Auto-deny every request" },
        ],
        authorizedUserIds: owner,
      });
    } else if (action === "card") {
      picked = await this.ports.transport.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: channelScope ? "🃏 Channel status card" : "🃏 Status card",
          description: this.ports.description("statusCardStyle"),
          fields: [
            {
              name: "Current",
              value: `\`${draft.snapshot.statusCardStyle.value}\``,
              inline: true,
            },
          ],
        },
        choices: channelScope
          ? [
              inherit,
              {
                value: "full",
                label: "full (channel)",
                description: "Every thread inherits unless it overrides",
              },
              {
                value: "simple",
                label: "simple (channel)",
                description: "Every thread inherits unless it overrides",
              },
            ]
          : [
              inherit,
              {
                value: "full",
                label: "full (this thread)",
                description: "Repo, model, action, effort — overrides channel",
              },
              {
                value: "simple",
                label: "simple (this thread)",
                description: "State + brand icon + thought — overrides channel",
              },
            ],
        authorizedUserIds: owner,
      });
    } else if (action === "gif") {
      picked = await this.ports.transport.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: channelScope ? "🎞 Channel simple-card GIF" : "🎞 Simple-card GIF",
          description: this.ports.description("simpleCardGif"),
          fields: [
            {
              name: "Current",
              value: `\`${draft.snapshot.simpleCardGif.value ? "on" : "off"}\``,
              inline: true,
            },
          ],
        },
        choices: channelScope
          ? [
              inherit,
              {
                value: "on",
                label: "on (channel)",
                description: "Every thread inherits unless it overrides",
              },
              {
                value: "off",
                label: "off (channel)",
                description: "Every thread inherits unless it overrides",
              },
            ]
          : [
              inherit,
              {
                value: "on",
                label: "on (this thread)",
                description: "Random GIF thumbnail on the simple card",
              },
              {
                value: "off",
                label: "off (this thread)",
                description: "No GIF — overrides channel",
              },
            ],
        authorizedUserIds: owner,
      });
    } else if (action === "prefix") {
      picked = await this.ports.transport.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: channelScope ? "🏷️ Channel automatic naming" : "🏷️ Thread automatic naming",
          fields: [{
            name: "Current",
            value: draft.snapshot.disableThreadPrefix.value ? "`disabled`" : "`enabled`",
            inline: true,
          }],
        },
        choices: [
          inherit,
          { value: "enabled", label: "Enabled", description: "Allow managed thread prefixes" },
          { value: "disabled", label: "Disabled", description: "Leave thread names completely untouched" },
        ],
        authorizedUserIds: owner,
      });
    } else if (action === "attach") {
      picked = await this.ports.transport.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: "📌 Thread attachment",
          fields: [
            {
              name: "Current",
              value: draft.snapshot.detached.value ? "`detached`" : "`attached`",
              inline: true,
            },
          ],
        },
        choices: [
          inherit,
          { value: "attached", label: "Attached", description: "Bot replies in this thread" },
          { value: "detached", label: "Detached", description: "No bot replies" },
        ],
        authorizedUserIds: owner,
      });
    } else if (action === "fast") {
      // #37: hard-refuse rather than render a picker whose "on" can never land.
      if (channelScope) return;
      if (this.fastDisabledFor(draft)) {
        const agentId =
          draft.overlay.agent === undefined
            ? draft.snapshot.agent.value
            : draft.overlay.agent ?? draft.snapshot.withoutThread.agent;
        await evt
          .followUpEphemeral(
            isFastModeDisabledByEnv()
              ? fastModeEnvRefusal()
              : fastModeAgentRefusal(agentId)
          )
          .catch(() => {});
        return;
      }
      picked = await this.ports.transport.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: "⚡ Claude Fast mode",
          description:
            `${FAST_MODE_COST_WARNING} ${FAST_MODE_RESET_NOTICE} ` +
            `Availability is decided by the fresh session's advertised \`${FAST_MODE_CONFIG_ID}\` ` +
            `option, so a model without it is refused on Save rather than silently ignored.`,
          fields: [
            {
              name: "Current",
              value: draft.snapshot.fastMode?.value ? "`on`" : "`off`",
              inline: true,
            },
          ],
        },
        choices: [
          {
            value: "off",
            label: "Off (default)",
            description: "Normal serving; covered by your subscription",
          },
          {
            value: "on",
            label: "On — paid usage credits",
            description: "Lower latency, billed outside subscription limits",
          },
        ],
        authorizedUserIds: owner,
      });
    } else if (action === "rider") {
      picked = await this.ports.transport.sendChoicePicker!(channel, {
        panel: {
          color: 0x5865f2,
          title: channelScope ? "📝 Channel rider" : "📝 Thread rider",
          description:
            "This rider is too long for a Discord modal. Use **Download** / **Upload** on the hub, or Inherit/Clear here.",
          fields: [],
        },
        choices: [
          {
            value: INHERIT_VALUE,
            label: "Inherit / Clear",
            description: channelScope
              ? "Remove the channel-preset rider"
              : "Remove the thread rider",
          },
        ],
        authorizedUserIds: owner,
      });
    } else {
      return;
    }

    if (!picked) {
      await this.refreshConfigEditorHub(draft);
      return;
    }
    const next = applyPickerValue(draft, field, picked.value, this.capsForAgent);
    this.configEditor.put(next);
    await this.refreshConfigEditorHub(next);
  }

  async cmdConfigAudit(i: ConfigInteraction): Promise<void> {
    const limit = i.options.getInteger("limit") ?? 20;
    const now = new Date();
    // Pull one page; a requested detail id must resolve within it, matching the
    // "recent tail" framing of the view (older rows aren't a lookup surface).
    const entries = this.ports.auditEntries(limit);

    const entryId = i.options.getString("entry");
    if (entryId) {
      const match = findAuditEntry(entries, entryId);
      if (!match) {
        await i.reply({
          content:
            `No config-audit entry \`${entryId}\` in the last ${limit} mutations. ` +
            `Raise \`limit\` or copy an id from \`/seam config audit\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const detail = formatConfigAuditDetail(match, now);
      const embed = new EmbedBuilder()
        .setTitle("📜 Config mutation")
        .setColor(CONFIG_AUDIT_COLOR)
        .setDescription(detail.entry.summary);
      for (const m of detail.meta) {
        // Same 1024 field-value clamp the confirm card uses (adapter.ts).
        embed.addFields({ name: m.label, value: m.value.slice(0, 1024) });
      }
      embed.addFields(
        { name: "before", value: this.ports.codeBlock(detail.before, "json").slice(0, 1024) },
        { name: "after", value: this.ports.codeBlock(detail.after, "json").slice(0, 1024) }
      );
      await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    const view = formatConfigAuditView(entries, now);
    const embed = new EmbedBuilder()
      .setTitle("📜 Config audit")
      .setColor(CONFIG_AUDIT_COLOR);
    if (view.empty) {
      embed.setDescription(
        "No config mutations recorded yet — nothing has been applied via `config_propose`."
      );
    } else {
      // `clampFieldValue` keeps the list under Discord's 1024 field cap with an
      // `…and N more` tail (shared with `/seam workflows`).
      embed.addFields({
        name: `🕑 Recent (${view.lines.length})`,
        value: clampFieldValue(view.lines),
      });
      embed.setFooter({
        text: `newest first · up to ${limit} rows · inspect one with entry:<id>`,
      });
    }
    await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }

  async cmdConfigSet(
    i: ConfigInteraction
  ): Promise<void> {
    const channel = i.channelRef;
    if (!channel) {
      await i.reply({ content: "Use inside a thread.", flags: MessageFlags.Ephemeral });
      return;
    }
    const request = configSetRequest(i.options);
    if (configTarget(channel, request.scope).kind === "channel") {
      await this.setChannel(i, request);
      return;
    }
    this.ports.bind(channel);
    const requestError = configSetRequestError(request);
    if (requestError && !request.rebuild) {
      await i.reply({
        content: requestError,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // A repo lookup or runtime retirement can exceed Discord's three-second
    // interaction deadline. Acknowledge before either one starts.

    if (request.json === null && request.supplied.length === 0 && request.rebuild) {
      await i.reply((await this.ports.rebuild(channel)).trim() || "🏗️ Rebuild complete.");
      return;
    }
    const validated = await this.ports.prepareSet(channel, request);
    if (!validated.ok) {
      await i.reply(validated.message);
      return;
    }
    const applied = await this.ports.applySet(
      channel,
      request,
      validated.prepared,
      { id: i.user.id, name: i.user.displayName ?? i.user.username },
      { retireRuntime: true, applyName: true }
    );
    if (!applied.ok) {
      this.logger.warn({ sessionId: `discord:${channel.id}`, error: applied.message }, "bulk config set failed");
      await i.reply(
        `${validated.prepared.kind === "json" ? "Could not replace config" : "Could not update config"}: ` +
          `${applied.message}${applied.rollbackError}`
      );
      return;
    }
    const rebuildNote = request.rebuild
      ? await this.ports.rebuild(channel)
      : "";
    if (validated.prepared.kind === "json") {
      await i.reply("Config replaced; next turn starts a fresh runtime." + rebuildNote);
      return;
    }
    const changed = request.supplied.map((name) => `\`${name}\``).join(", ");
    await i.reply(
      `Updated ${changed}. Effective: ${configSetSummary(applied.effective, this.ports.repoDisplay)}.` +
        (applied.restartRequested ? " Next turn uses the new runtime configuration." : "") +
        rebuildNote
    );
  }
}
