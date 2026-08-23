import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  REST,
  Routes,
  MessageFlags,
  MessageType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder,
  type Message,
  type TextChannel,
  type ThreadChannel,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  type MessageComponentInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../../lib/logger.js";
import { isThreadDetached, mayConfigureUserIds, type Config } from "../../config.js";
import { isObfuscatedChannel, visibleDiscordChannelName } from "./channel-visibility.js";
import type {
  ChatAdapter,
  ChannelRef,
  ComponentEvent,
  ChoiceCardPost,
  ChoiceInteraction,
  ConfirmationCard,
  ConfirmationDecision,
  IncomingMessage,
  MessageAttachment,
  MessageRef,
} from "../chat-adapter.js";
import type { PanelButton, StructuredPanel } from "../../core/types.js";
import {
  CHOICE_CUSTOM_ID_PREFIX,
  CHOICE_CUSTOM_TEXT_MAX,
  makeChoiceConfirmId,
  makeChoiceCustomId,
  makeChoiceModalId,
  makeChoiceSelectId,
} from "../../core/choice/types.js";
import { buildSeamCommand } from "./commands.js";
import { sanitizeSpeakerName } from "../../core/agent-conventions.js";
import {
  DISCORD_BUTTONS_PER_ROW,
  choicePickerLayout,
  choicePickerPageCaption,
  describeMultiSelectMenu,
  sliceChoicePage,
} from "./choice-picker.js";

const PLATFORM = "discord";

/** Build Discord action rows for a choice card. Multi-select (#94) is one
 *  String Select + Confirm; single-select layout is unchanged. */
export function buildChoiceCardComponents(
  card: ChoiceCardPost
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  if (card.hideButtons) return [];
  const disabled = Boolean(card.disabled);
  if (card.select) {
    const spec = describeMultiSelectMenu({
      choiceId: card.choiceId,
      options: card.options,
      min: card.select.min,
      max: card.select.max,
      pendingSelection: card.pendingSelection,
      disabled,
      makeSelectId: makeChoiceSelectId,
      makeConfirmId: makeChoiceConfirmId,
    });
    const select = new StringSelectMenuBuilder()
      .setCustomId(spec.customId)
      .setPlaceholder(spec.placeholder)
      .setMinValues(spec.minValues)
      .setMaxValues(spec.maxValues)
      .setDisabled(disabled)
      .addOptions(
        spec.options.map((o) => ({
          label: o.label,
          value: o.value,
          ...(o.default ? { default: true } : {}),
        }))
      );
    const confirm = new ButtonBuilder()
      .setCustomId(spec.confirmCustomId)
      .setLabel(spec.confirmLabel)
      .setStyle(ButtonStyle.Success)
      .setDisabled(spec.confirmDisabled);
    return [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      new ActionRowBuilder<ButtonBuilder>().addComponents(confirm),
    ];
  }
  const prompts = card.options
    .map((o, i) => ({ o, i }))
    .filter((x) => x.o.kind === "prompt");
  const customs = card.options
    .map((o, i) => ({ o, i }))
    .filter((x) => x.o.kind === "custom");
  const layout = choicePickerLayout({
    choiceCount: prompts.length,
    allowCustom: customs.length > 0,
  });
  const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (layout.useButtons) {
    const buttons = card.options.map((o, i) =>
      new ButtonBuilder()
        .setCustomId(makeChoiceCustomId(card.choiceId, i))
        .setLabel(o.label.slice(0, 80))
        .setStyle(o.kind === "custom" ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(disabled)
    );
    for (let i = 0; i < buttons.length; i += DISCORD_BUTTONS_PER_ROW) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          buttons.slice(i, i + DISCORD_BUTTONS_PER_ROW)
        )
      );
    }
  } else {
    const select = new StringSelectMenuBuilder()
      .setCustomId(makeChoiceSelectId(card.choiceId))
      .setPlaceholder("Choose an option")
      .setDisabled(disabled)
      .addOptions(
        prompts.map(({ o, i }) => ({
          label: o.label.slice(0, 100),
          value: String(i),
        }))
      );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
    for (const { o, i } of customs) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(makeChoiceCustomId(card.choiceId, i))
            .setLabel(o.label.slice(0, 80))
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled)
        )
      );
    }
  }
  return rows.slice(0, 5);
}

/**
 * Resolve a Discord author's display name per issue #57 D5:
 *   config override map → guild nickname → global name → username,
 * then sanitize (control chars / length) via the shared preamble sanitizer so
 * the result is safe wherever it lands (preamble, history render). The override
 * map matters most because it moves the name from user control to admin control.
 */
export function resolveDiscordSpeakerName(
  author: {
    userId: string;
    nickname?: string | null;
    globalName?: string | null;
    username: string;
  },
  overrides: Map<string, string>
): string {
  const raw =
    overrides.get(author.userId) ??
    author.nickname ??
    author.globalName ??
    author.username ??
    "";
  return sanitizeSpeakerName(raw);
}

export type SlashHandler = (
  interaction: ChatInputCommandInteraction
) => Promise<void>;

export type AutocompleteHandler = (
  interaction: AutocompleteInteraction
) => Promise<void>;

/**
 * Classify a Discord interaction for the InteractionCreate router.
 * Autocomplete is a first-class branch parallel to chat-input / button / modal
 * — adding it must not steal those routes. Exported so tests can lock the
 * dispatch table without standing up a Client.
 */
export type DiscordInteractionRoute =
  | "autocomplete"
  | "slash"
  | "config-edit"
  | "choice"
  | "none";

export function classifyDiscordInteraction(interaction: {
  isAutocomplete?: () => boolean;
  isChatInputCommand: () => boolean;
  isButton: () => boolean;
  isModalSubmit: () => boolean;
  isStringSelectMenu?: () => boolean;
  commandName?: string;
  customId?: string;
}): DiscordInteractionRoute {
  if (interaction.isAutocomplete?.()) {
    return interaction.commandName === "seam" ? "autocomplete" : "none";
  }
  if (interaction.isChatInputCommand()) {
    return interaction.commandName === "seam" ? "slash" : "none";
  }
  const isButton = interaction.isButton();
  const isModal = interaction.isModalSubmit();
  const isSelect = interaction.isStringSelectMenu?.() === true;
  const cid = isButton || isModal || isSelect ? (interaction.customId ?? "") : "";
  if ((isButton || isModal) && cid.startsWith("seam-cfg-edit:")) return "config-edit";
  if (cid.startsWith(CHOICE_CUSTOM_ID_PREFIX)) return "choice";
  return "none";
}

/**
 * discord.js v14 chat adapter.
 *
 * Responsibilities:
 *  - connect with Guild + GuildMessages + MessageContent intents
 *  - register `/seam` slash commands (guild-scoped if DEV guild set, global otherwise)
 *  - filter incoming messages: only thread messages, only the configured owner,
 *    only when the bot is in a thread it created (parent channel match optional)
 *  - send/edit messages
 */
export class DiscordAdapter implements ChatAdapter {
  readonly platform = PLATFORM;

  private readonly client: Client;
  private readonly logger: Logger;
  private readonly config: Config;
  private readonly slashHandler: SlashHandler;
  private readonly autocompleteHandler?: AutocompleteHandler;

  private messageHandler?: (msg: IncomingMessage) => void | Promise<void>;
  private componentHandler?: (evt: ComponentEvent) => void | Promise<void>;
  private choiceHandler?: (evt: ChoiceInteraction) => void | Promise<void>;
  private threadDeleteHandler?: (channelRef: string) => void | Promise<void>;
  /** DB-backed channel activation (#22): additive to the env allowlist. */
  private activeChannelCheck?: (channelRef: string) => boolean;
  private botUserId?: string;

  constructor(opts: {
    config: Config;
    logger: Logger;
    slashHandler: SlashHandler;
    autocompleteHandler?: AutocompleteHandler;
  }) {
    this.config = opts.config;
    this.logger = opts.logger.child({ adapter: PLATFORM });
    this.slashHandler = opts.slashHandler;
    this.autocompleteHandler = opts.autocompleteHandler;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  onComponent(handler: (evt: ComponentEvent) => void | Promise<void>): void {
    this.componentHandler = handler;
  }

  onChoiceInteraction(handler: (evt: ChoiceInteraction) => void | Promise<void>): void {
    this.choiceHandler = handler;
  }

  onThreadDelete(handler: (channelRef: string) => void | Promise<void>): void {
    this.threadDeleteHandler = handler;
  }

  setActiveChannelCheck(check: (channelRef: string) => boolean): void {
    this.activeChannelCheck = check;
  }

  async start(): Promise<void> {
    this.wire();
    await this.client.login(this.config.DISCORD_BOT_TOKEN);
    await new Promise<void>((resolve) => {
      if (this.client.isReady()) return resolve();
      this.client.once(Events.ClientReady, () => resolve());
    });
    this.botUserId = this.client.user?.id;
    this.logger.info({ botUserId: this.botUserId }, "discord adapter ready");
    await this.registerSlashCommands();
    await this.applyAvatarIfNeeded();
  }

  /** Gateway heartbeat RTT in ms; undefined if the WS isn't ready. */
  gatewayPingMs(): number | undefined {
    const ping = this.client.ws.ping;
    if (!Number.isFinite(ping) || ping < 0) return undefined;
    return Math.round(ping);
  }

  async stop(): Promise<void> {
    try {
      await this.client.destroy();
    } catch (err) {
      this.logger.warn({ err }, "discord client destroy failed");
    }
  }

  async sendMessage(channel: ChannelRef, text: string): Promise<MessageRef> {
    const ch = await this.fetchSendableChannel(channel.id);
    const sent = await ch.send({
      content: text,
      flags: MessageFlags.SuppressEmbeds,
      // M0 (#57): never turn a model-emitted <@id> into a real ping. Mentions
      // still render as a highlighted name; they just don't notify.
      allowedMentions: { parse: [] },
    });
    return { channel, id: sent.id };
  }

  async editMessage(message: MessageRef, text: string): Promise<void> {
    const ch = await this.fetchSendableChannel(message.channel.id);
    const msg = await ch.messages.fetch(message.id);
    await msg.edit({
      content: text,
      flags: MessageFlags.SuppressEmbeds,
      allowedMentions: { parse: [] },
    });
  }

  async sendFile(
    channel: ChannelRef,
    file: { data: Buffer; filename: string; mimeType: string; caption?: string }
  ): Promise<MessageRef> {
    const ch = await this.fetchSendableChannel(channel.id);
    const sent = await ch.send({
      ...(file.caption ? { content: file.caption } : {}),
      files: [{ attachment: file.data, name: file.filename }],
      flags: MessageFlags.SuppressEmbeds,
      allowedMentions: { parse: [] },
    });
    return { channel, id: sent.id };
  }

  async sendTyping(channel: ChannelRef): Promise<void> {
    try {
      const ch = await this.fetchSendableChannel(channel.id);
      await ch.sendTyping();
    } catch {
      // Best-effort — typing indicators must never break a turn.
    }
  }

  /**
   * Show an interactive picker. Small lists are buttons; larger lists are a
   * string-select (Discord's 25-option cap). Lists bigger than 25 paginate
   * instead of being truncated. Optional `allowCustom` adds a modal for a
   * free-typed value. Returns null on timeout or unauthorized interaction.
   */
  async sendChoicePicker(
    channel: ChannelRef,
    opts: {
      prompt?: string;
      panel?: import("../../core/types.js").StructuredPanel;
      choices: ReadonlyArray<{ value: string; label: string; description?: string }>;
      timeoutMs?: number;
      authorizedUserIds?: ReadonlySet<string>;
      successPanel?: (picked: { value: string; label: string }, username: string) => import("../../core/types.js").StructuredPanel;
      allowCustom?: {
        buttonLabel?: string;
        modalTitle?: string;
        inputLabel?: string;
        placeholder?: string;
      };
      validate?: (value: string) => Promise<string | null | undefined> | string | null | undefined;
    }
  ): Promise<{ value: string; userId: string } | null> {
    const ch = await this.fetchSendableChannel(channel.id);
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    const choices = opts.choices;
    if (choices.length === 0 && !opts.allowCustom) return null;

    const layout = choicePickerLayout({
      choiceCount: choices.length,
      allowCustom: Boolean(opts.allowCustom),
    });
    const customId = `seam-pick:${Date.now()}`;

    const panelForPage = (page: number) => {
      if (!opts.panel) return undefined;
      const caption = choicePickerPageCaption(choices.length, page, layout.pageSize);
      if (!caption) return opts.panel;
      const description = opts.panel.description
        ? `${opts.panel.description}\n${caption}`
        : caption;
      return { ...opts.panel, description };
    };

    const buildEmbeds = (page: number) => {
      const panel = panelForPage(page);
      return panel ? [DiscordAdapter.buildEmbed(panel)] : [];
    };

    const buildComponents = (page: number) => {
      const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
      const { items, start, page: p } = sliceChoicePage(
        choices,
        page,
        layout.pageSize
      );
      if (layout.useButtons && items.length > 0) {
        const buttons = items.map((c, idx) =>
          new ButtonBuilder()
            .setCustomId(`${customId}:c:${start + idx}`)
            .setLabel(c.label.slice(0, 80))
            .setStyle(ButtonStyle.Secondary)
        );
        for (let i = 0; i < buttons.length; i += DISCORD_BUTTONS_PER_ROW) {
          rows.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              buttons.slice(i, i + DISCORD_BUTTONS_PER_ROW)
            )
          );
        }
      } else if (!layout.useButtons && items.length > 0) {
        const select = new StringSelectMenuBuilder()
          .setCustomId(`${customId}:s`)
          .setPlaceholder(
            layout.pageCount > 1
              ? `Page ${p + 1}/${layout.pageCount} — Choose…`
              : "Choose…"
          )
          .addOptions(
            items.map((c, idx) => ({
              value: String(start + idx),
              label: c.label.slice(0, 100),
              ...(c.description
                ? { description: c.description.slice(0, 100) }
                : {}),
            }))
          );
        rows.push(
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
        );
      }

      const nav: ButtonBuilder[] = [];
      if (layout.pageCount > 1) {
        nav.push(
          new ButtonBuilder()
            .setCustomId(`${customId}:prev`)
            .setLabel("◀ Prev")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(p === 0),
          new ButtonBuilder()
            .setCustomId(`${customId}:page`)
            .setLabel(`${p + 1} / ${layout.pageCount}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
          new ButtonBuilder()
            .setCustomId(`${customId}:next`)
            .setLabel("Next ▶")
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(p >= layout.pageCount - 1)
        );
      }
      if (opts.allowCustom) {
        nav.push(
          new ButtonBuilder()
            .setCustomId(`${customId}:custom`)
            .setLabel((opts.allowCustom.buttonLabel ?? "Custom…").slice(0, 80))
            .setStyle(ButtonStyle.Primary)
        );
      }
      if (nav.length > 0) {
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(nav));
      }
      return rows;
    };

    const successPayload = (
      chosen: { value: string; label: string },
      username: string
    ) => {
      if (opts.successPanel) {
        return {
          content: opts.prompt,
          embeds: [DiscordAdapter.buildEmbed(opts.successPanel(chosen, username))],
          components: [],
        };
      }
      if (opts.panel) {
        const successEmbed = DiscordAdapter.buildEmbed(opts.panel).setColor(0x57f287);
        const newDesc = opts.panel.description
          ? `${opts.panel.description}\n\n✅ **${chosen.label}** (${username})`
          : `✅ **${chosen.label}** (${username})`;
        successEmbed.setDescription(newDesc.slice(0, 4096));
        return { content: opts.prompt, embeds: [successEmbed], components: [] };
      }
      return {
        content: `${opts.prompt ?? ""}\n✅ **${chosen.label}** (${username})`,
        embeds: [],
        components: [],
      };
    };

    const msg = await ch.send({
      content: opts.prompt,
      embeds: buildEmbeds(0),
      components: buildComponents(0),
    });

    const filter = (i: MessageComponentInteraction) => {
      if (opts.authorizedUserIds && !opts.authorizedUserIds.has(i.user.id)) {
        i.reply({
          content: "This bot is not available to you.",
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return false;
      }
      return true;
    };

    const rejectPick = async (
      interaction: { reply: (opts: object) => Promise<unknown> },
      reason: string
    ) => {
      await interaction
        .reply({
          content: `❌ ${reason}`,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    };

    let page = 0;
    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("timeout");
        const interaction = await msg.awaitMessageComponent({
          filter,
          time: remaining,
        });
        const cid = interaction.customId;

        if (cid === `${customId}:prev`) {
          page = Math.max(0, page - 1);
          await interaction.update({
            embeds: buildEmbeds(page),
            components: buildComponents(page),
          });
          continue;
        }
        if (cid === `${customId}:next`) {
          page = Math.min(layout.pageCount - 1, page + 1);
          await interaction.update({
            embeds: buildEmbeds(page),
            components: buildComponents(page),
          });
          continue;
        }
        if (cid === `${customId}:page`) {
          await interaction.deferUpdate().catch(() => {});
          continue;
        }

        if (cid === `${customId}:custom` && opts.allowCustom) {
          const modal = new ModalBuilder()
            .setCustomId(`${customId}:modal`)
            .setTitle((opts.allowCustom.modalTitle ?? "Custom value").slice(0, 45))
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                  .setCustomId(`${customId}:input`)
                  .setLabel((opts.allowCustom.inputLabel ?? "Value").slice(0, 45))
                  .setStyle(TextInputStyle.Short)
                  .setRequired(true)
                  .setMaxLength(400)
                  .setPlaceholder(
                    (opts.allowCustom.placeholder ?? "Type a value").slice(0, 100)
                  )
              )
            );
          await interaction.showModal(modal);
          const modalMs = Math.min(
            Math.max(1_000, deadline - Date.now()),
            5 * 60 * 1000
          );
          const submitted = await interaction
            .awaitModalSubmit({
              filter: (m) =>
                m.customId === `${customId}:modal` &&
                m.user.id === interaction.user.id,
              time: modalMs,
            })
            .catch(() => null);
          if (!submitted) continue;
          const raw = submitted.fields
            .getTextInputValue(`${customId}:input`)
            .trim();
          if (!raw) {
            await rejectPick(submitted, "Value was empty — pick again or retype.");
            continue;
          }
          const err = await opts.validate?.(raw);
          if (err) {
            await rejectPick(submitted, err);
            continue;
          }
          await submitted.deferUpdate();
          await msg.edit(
            successPayload({ value: raw, label: raw }, submitted.user.username)
          );
          return { value: raw, userId: submitted.user.id };
        }

        let pickedIdx: number | undefined;
        if (interaction.componentType === ComponentType.Button) {
          const suffix = cid.split(":").pop() ?? "";
          pickedIdx = Number.parseInt(suffix, 10);
        } else if (interaction.componentType === ComponentType.StringSelect) {
          pickedIdx = Number.parseInt(interaction.values[0] ?? "", 10);
        }
        if (pickedIdx === undefined || Number.isNaN(pickedIdx)) {
          await interaction.deferUpdate().catch(() => {});
          continue;
        }
        const chosen = choices[pickedIdx];
        if (!chosen) {
          if (opts.panel) {
            const errEmbed = DiscordAdapter.buildEmbed(opts.panel).setColor(0xed4245);
            errEmbed.setDescription("_Invalid choice._");
            await interaction.update({
              content: opts.prompt,
              embeds: [errEmbed],
              components: [],
            });
          } else {
            await interaction.update({
              content: `${opts.prompt ?? ""}\n_Invalid choice._`,
              components: [],
            });
          }
          return null;
        }
        const err = await opts.validate?.(chosen.value);
        if (err) {
          await rejectPick(interaction, err);
          continue;
        }
        await interaction.update(
          successPayload(
            { value: chosen.value, label: chosen.label },
            interaction.user.username
          )
        );
        return { value: chosen.value, userId: interaction.user.id };
      }
    } catch {
      try {
        await msg.edit({
          content: `${opts.prompt ?? ""}\n⏱️ _Timed out._`,
          components: [],
        });
      } catch {
        /* ignore */
      }
      return null;
    }
  }

  async createThread(parent: ChannelRef, name: string): Promise<ChannelRef> {
    let ch = await this.client.channels.fetch(parent.id);
    if (!ch) throw new Error(`Channel ${parent.id} not found`);

    // If invoked from inside a thread, walk up to its parent.
    if (ch.isThread()) {
      const parentId = ch.parentId;
      if (!parentId) {
        throw new Error(`Thread ${parent.id} has no parent channel`);
      }
      const parentCh = await this.client.channels.fetch(parentId);
      if (!parentCh) {
        throw new Error(`Parent channel ${parentId} not found`);
      }
      ch = parentCh;
    }

    if (isObfuscatedChannel(ch)) {
      throw new Error(
        `Channel ${ch.id} is obfuscated (bot lacks VIEW_CHANNEL); cannot create a thread there`
      );
    }

    if (
      ch.type !== ChannelType.GuildText &&
      ch.type !== ChannelType.GuildAnnouncement
    ) {
      throw new Error(
        `Channel ${ch.id} (type ${ch.type}) does not support threads`
      );
    }

    const thread = await (ch as TextChannel).threads.create({
      name,
      autoArchiveDuration: 1440,
      type: ChannelType.PublicThread,
    });
    return {
      platform: PLATFORM,
      id: thread.id,
      parentId: ch.id,
    };
  }

  async renameThread(channel: ChannelRef, name: string): Promise<void> {
    try {
      const ch = await this.client.channels.fetch(channel.id);
      if (!ch?.isThread()) return;
      await (ch as ThreadChannel).edit({ name: name.slice(0, 100) });
    } catch (err) {
      this.logger.warn({ err, channelId: channel.id }, "renameThread failed");
    }
  }

  async getThreadName(channel: ChannelRef): Promise<string | undefined> {
    try {
      const ch = await this.client.channels.fetch(channel.id);
      if (!ch?.isThread()) return undefined;
      // #52: never surface Discord's obfuscation sentinel as a real name.
      return visibleDiscordChannelName(ch as ThreadChannel);
    } catch {
      return undefined;
    }
  }

  async fetchThreadMessages(
    channel: ChannelRef
  ): Promise<Array<{ authorIsBot: boolean; text: string; authorName?: string }>> {
    const ch = await this.fetchSendableChannel(channel.id);
    if (!ch.isThread()) throw new Error("Channel is not a thread.");
    
    const messages: Array<{ authorIsBot: boolean; text: string; authorName?: string }> = [];
    let lastId: string | undefined;

    while (true) {
      const options: { limit: number; before?: string } = { limit: 100 };
      if (lastId) options.before = lastId;

      const chunk = await ch.messages.fetch(options);
      if (chunk.size === 0) break;

      for (const msg of chunk.values()) {
        if (msg.type !== MessageType.Default && msg.type !== MessageType.Reply) continue;
        if (!msg.content?.trim() && msg.attachments.size === 0) continue;

        // Skip bot messages that are status cards / panels. These are embed-
        // only messages (or embed + minimal content) that show operational info
        // (model, context usage, timing) — useless noise for rebuild summaries.
        if (msg.author.bot && msg.embeds.length > 0 && !msg.content?.trim()) continue;

        let text = msg.content ?? "";
        if (msg.attachments.size > 0) {
          const names = msg.attachments.map((a: any) => a.name).join(", ");
          text += ` [Attachments: ${names}]`;
        }

        messages.push({
          authorIsBot: msg.author.bot,
          text: text.trim(),
          ...(msg.author.bot ? {} : { authorName: this.resolveAuthorName(msg) }),
        });
      }
      
      lastId = chunk.last()?.id;
    }
    
    return messages.reverse();
  }

  async getThreadLiveState(
    channel: ChannelRef
  ): Promise<{ locked: boolean; archived: boolean } | undefined> {
    try {
      const ch = await this.client.channels.fetch(channel.id);
      if (!ch) return undefined; // gone
      // Obfuscated = bot lacks VIEW_CHANNEL. Treat as locked (do not post);
      // do not treat as deleted (would drop schedules).
      if (isObfuscatedChannel(ch)) return { locked: true, archived: false };
      if (ch.isThread()) return { locked: ch.locked ?? false, archived: ch.archived ?? false };
      if (ch.isTextBased()) return { locked: false, archived: false }; // plain channel — always postable
      return undefined; // not a postable channel
    } catch (err) {
      // 10003 = Unknown Channel → confirmed deleted. Anything else is transient;
      // rethrow so the caller skips this run rather than dropping the schedule.
      if ((err as { code?: number })?.code === 10003) return undefined;
      throw err;
    }
  }

  async fetchThreadMessagesTimed(
    channel: ChannelRef,
    opts?: { fromTs?: number; toTs?: number }
  ): Promise<Array<{ ts: number; authorIsBot: boolean; text: string; authorName?: string }>> {
    const ch = await this.fetchSendableChannel(channel.id);
    if (!ch.isThread()) throw new Error("Channel is not a thread.");
    const from = opts?.fromTs ?? -Infinity;
    const to = opts?.toTs ?? Infinity;

    const messages: Array<{ ts: number; authorIsBot: boolean; text: string; authorName?: string }> = [];
    let lastId: string | undefined;

    while (true) {
      const options: { limit: number; before?: string } = { limit: 100 };
      if (lastId) options.before = lastId;

      const chunk = await ch.messages.fetch(options);
      if (chunk.size === 0) break;

      let allOlderThanFrom = true;
      for (const msg of chunk.values()) {
        const ts = msg.createdTimestamp;
        if (ts >= from) allOlderThanFrom = false;
        if (msg.type !== MessageType.Default && msg.type !== MessageType.Reply) continue;
        if (!msg.content?.trim() && msg.attachments.size === 0) continue;
        if (ts < from || ts > to) continue;

        let text = msg.content ?? "";
        if (msg.attachments.size > 0) {
          const names = msg.attachments.map((a: any) => a.name).join(", ");
          text += ` [Attachments: ${names}]`;
        }
        messages.push({
          ts,
          authorIsBot: msg.author.bot,
          text: text.trim(),
          ...(msg.author.bot ? {} : { authorName: this.resolveAuthorName(msg) }),
        });
      }

      // We page backwards (newest→oldest). Once an entire page is older than the
      // lower bound, everything further back is too — stop paginating.
      if (allOlderThanFrom) break;
      lastId = chunk.last()?.id;
    }

    return messages.sort((a, b) => a.ts - b.ts);
  }

  async sendPanel(
    channel: ChannelRef,
    panel: StructuredPanel
  ): Promise<MessageRef> {
    const ch = await this.fetchSendableChannel(channel.id);
    const embed = DiscordAdapter.buildEmbed(panel);
    const components = DiscordAdapter.buildActionRows(panel.actions);
    const files = (panel.files ?? []).map(
      (f) => new AttachmentBuilder(f.data, { name: f.filename })
    );
    const sent = await ch.send({
      embeds: [embed],
      ...(components.length > 0 ? { components } : {}),
      ...(files.length > 0 ? { files } : {}),
    });
    return { channel, id: sent.id };
  }

  async editPanel(
    message: MessageRef,
    panel: StructuredPanel
  ): Promise<void> {
    const ch = await this.fetchSendableChannel(message.channel.id);
    const msg = await ch.messages.fetch(message.id);
    const embed = DiscordAdapter.buildEmbed(panel);
    const payload: {
      content: string;
      embeds: EmbedBuilder[];
      components?: ReturnType<typeof DiscordAdapter.buildActionRows>;
      files?: AttachmentBuilder[];
      attachments?: [];
    } = {
      content: "",
      embeds: [embed],
    };
    if (panel.actions !== undefined) {
      payload.components = DiscordAdapter.buildActionRows(panel.actions);
    }
    if (panel.files !== undefined) {
      payload.files = panel.files.map((f) => new AttachmentBuilder(f.data, { name: f.filename }));
      payload.attachments = [];
    }
    await msg.edit(payload);
  }

  async sendLayout(
    channel: ChannelRef,
    layout: import("../../core/types.js").StructuredLayout
  ): Promise<MessageRef> {
    const ch = await this.fetchSendableChannel(channel.id);
    const sent = await ch.send({
      flags: MessageFlags.IsComponentsV2,
      components: [DiscordAdapter.buildContainer(layout)],
    });
    return { channel, id: sent.id };
  }

  async editLayout(
    message: MessageRef,
    layout: import("../../core/types.js").StructuredLayout
  ): Promise<void> {
    const ch = await this.fetchSendableChannel(message.channel.id);
    const msg = await ch.messages.fetch(message.id);
    await msg.edit({
      flags: MessageFlags.IsComponentsV2,
      components: [DiscordAdapter.buildContainer(layout)],
    });
  }

  async deleteMessage(message: MessageRef): Promise<void> {
    const ch = await this.fetchSendableChannel(message.channel.id);
    const msg = await ch.messages.fetch(message.id);
    await msg.delete();
  }

  async pinMessage(message: MessageRef): Promise<void> {
    const ch = await this.fetchSendableChannel(message.channel.id);
    const msg = await ch.messages.fetch(message.id);
    if (msg.pinned) return;
    await msg.pin();
    // Pin emits a system "pinned a message" notice; the status thread is
    // meant to hold only the card, so drop that extra message.
    try {
      const recent = await ch.messages.fetch({ limit: 5 });
      const notice = recent.find((m) => m.type === MessageType.ChannelPinnedMessage);
      if (notice) await notice.delete();
    } catch (err) {
      this.logger.warn({ err }, "failed to delete pin notice");
    }
  }

  private static buttonStyle(style: PanelButton["style"]): ButtonStyle {
    switch (style) {
      case "primary":
        return ButtonStyle.Primary;
      case "success":
        return ButtonStyle.Success;
      case "danger":
        return ButtonStyle.Danger;
      default:
        return ButtonStyle.Secondary;
    }
  }

  private static buildActionRows(
    actions: PanelButton[][] | undefined
  ): ActionRowBuilder<ButtonBuilder>[] {
    if (!actions || actions.length === 0) return [];
    return actions.slice(0, 5).map((row) => {
      const built = new ActionRowBuilder<ButtonBuilder>();
      for (const btn of row.slice(0, 5)) {
        const b = new ButtonBuilder()
          .setCustomId(btn.customId.slice(0, 100))
          .setLabel(btn.label.slice(0, 80))
          .setStyle(DiscordAdapter.buttonStyle(btn.style));
        if (btn.disabled) b.setDisabled(true);
        if (btn.emoji) b.setEmoji(btn.emoji);
        built.addComponents(b);
      }
      return built;
    });
  }

  private async handlePersistentComponent(
    interaction: ButtonInteraction | ModalSubmitInteraction
  ): Promise<void> {
    if (!this.componentHandler) return;
    const isButton = interaction.isButton();
    const isModal = interaction.isModalSubmit();

    const channelId = interaction.channelId ?? "";
    const ch = interaction.channel as { parentId?: string | null } | null;
    const parentId = ch?.parentId ?? undefined;
    const messageId = interaction.message?.id ?? "";

    const fields: Record<string, string> = {};
    if (isModal) {
      try {
        fields.rider = interaction.fields.getTextInputValue("rider");
      } catch {
        /* optional field */
      }
    }

    const evt: ComponentEvent = {
      customId: interaction.customId,
      userId: interaction.user.id,
      userName: interaction.user.displayName ?? interaction.user.username,
      channel: {
        platform: PLATFORM,
        id: channelId,
        ...(parentId ? { parentId } : {}),
      },
      messageId,
      kind: isModal ? "modal" : "button",
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
      replyEphemeral: async (text: string) => {
        await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
      },
      followUpEphemeral: async (text: string) => {
        await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
      },
      deferUpdate: async () => {
        await interaction.deferUpdate();
      },
      showModal: async (opts) => {
        if (!interaction.isButton()) {
          throw new Error("showModal is only valid on a button click");
        }
        const modal = new ModalBuilder()
          .setCustomId(opts.customId.slice(0, 100))
          .setTitle(opts.title.slice(0, 45));
        for (const input of opts.inputs.slice(0, 5)) {
          const ti = new TextInputBuilder()
            .setCustomId(input.id.slice(0, 100))
            .setLabel(input.label.slice(0, 45))
            .setStyle(input.style === "short" ? TextInputStyle.Short : TextInputStyle.Paragraph)
            .setRequired(input.required ?? false);
          if (input.maxLength) ti.setMaxLength(Math.min(input.maxLength, 4000));
          if (input.placeholder) ti.setPlaceholder(input.placeholder.slice(0, 100));
          if (input.value) ti.setValue(input.value.slice(0, input.maxLength ?? 4000));
          modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(ti));
        }
        await interaction.showModal(modal);
      },
    };
    await this.componentHandler(evt);
  }

  async sendChoiceCard(channel: ChannelRef, card: ChoiceCardPost): Promise<MessageRef> {
    const ch = await this.fetchSendableChannel(channel.id);
    const embed = DiscordAdapter.buildEmbed(card.panel);
    const components = DiscordAdapter.buildChoiceComponents(card);
    const sent = await ch.send({ embeds: [embed], components });
    return { channel, id: sent.id };
  }

  async editChoiceCard(message: MessageRef, card: ChoiceCardPost): Promise<void> {
    const ch = await this.fetchSendableChannel(message.channel.id);
    const msg = await ch.messages.fetch(message.id);
    const embed = DiscordAdapter.buildEmbed(card.panel);
    const components = DiscordAdapter.buildChoiceComponents(card);
    await msg.edit({ content: "", embeds: [embed], components });
  }

  private static buildChoiceComponents(
    card: ChoiceCardPost
  ): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
    return buildChoiceCardComponents(card);
  }

  private async handleChoiceInteraction(
    interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction
  ): Promise<void> {
    if (!this.choiceHandler) return;
    const channelId = interaction.channelId ?? "";
    const ch = interaction.channel as { parentId?: string | null } | null;
    const parentId = ch?.parentId ?? undefined;
    const messageId = interaction.message?.id ?? "";
    const kind: ChoiceInteraction["kind"] = interaction.isModalSubmit()
      ? "modal"
      : interaction.isStringSelectMenu()
        ? "select"
        : "button";
    const fields: Record<string, string> = {};
    if (interaction.isModalSubmit()) {
      try {
        fields.payload = interaction.fields.getTextInputValue("payload");
      } catch {
        /* empty */
      }
    }
    const values = interaction.isStringSelectMenu() ? [...interaction.values] : undefined;
    const evt: ChoiceInteraction = {
      customId: interaction.customId,
      userId: interaction.user.id,
      userName: interaction.user.displayName ?? interaction.user.username,
      channel: {
        platform: PLATFORM,
        id: channelId,
        ...(parentId ? { parentId } : {}),
      },
      messageId,
      kind,
      ...(values ? { values } : {}),
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
      replyEphemeral: async (text: string) => {
        await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
      },
      followUpEphemeral: async (text: string) => {
        await interaction.followUp({ content: text, flags: MessageFlags.Ephemeral });
      },
      deferUpdate: async () => {
        await interaction.deferUpdate();
      },
      showModal: async (opts) => {
        if (!interaction.isButton() && !interaction.isStringSelectMenu()) {
          throw new Error("showModal is only valid on a component click");
        }
        const modal = new ModalBuilder()
          .setCustomId(opts.customId.slice(0, 100))
          .setTitle(opts.title.slice(0, 45));
        const input = new TextInputBuilder()
          .setCustomId("payload")
          .setLabel(opts.label.slice(0, 45))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(Math.min(opts.maxLength ?? CHOICE_CUSTOM_TEXT_MAX, CHOICE_CUSTOM_TEXT_MAX));
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
        await interaction.showModal(modal);
      },
    };
    await this.choiceHandler(evt);
  }

  private static buildEmbed(
    panel: StructuredPanel
  ): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setColor(panel.color)
      .setTitle(panel.title);
    if (panel.author) {
      embed.setAuthor({ name: panel.author });
    }
    if (panel.description) {
      embed.setDescription(panel.description.slice(0, 4096));
    }
    for (const f of panel.fields) {
      embed.addFields({
        name: f.name.slice(0, 256),
        value: f.value.slice(0, 1024) || "\u200B",
        inline: f.inline ?? false,
      });
    }
    if (panel.footer) {
      embed.setFooter({ text: panel.footer.slice(0, 2048) });
    }
    return embed;
  }

  private static buildContainer(
    layout: import("../../core/types.js").StructuredLayout
  ): ContainerBuilder {
    const container = new ContainerBuilder();
    if (layout.color != null) container.setAccentColor(layout.color);
    for (const block of layout.blocks) {
      if (block.kind === "separator") {
        const spacing =
          block.spacing === "large" ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small;
        container.addSeparatorComponents(
          new SeparatorBuilder().setDivider(block.divider !== false).setSpacing(spacing)
        );
      } else {
        const content = block.content.trim() || "\u200B";
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content.slice(0, 4000)));
      }
    }
    return container;
  }

  // --- internals ---

  private wire(): void {
    this.client.on(Events.MessageCreate, (msg) => {
      this.handleMessage(msg).catch((err) => {
        this.logger.error({ err }, "message handler crashed");
      });
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      // Autocomplete is a parallel branch — checked first so it can never
      // fall through into chat-input / button / modal routing (#93).
      switch (classifyDiscordInteraction(interaction)) {
        case "autocomplete":
          this.handleAutocomplete(interaction as AutocompleteInteraction).catch((err) => {
            this.logger.error({ err }, "autocomplete handler crashed");
          });
          return;
        case "slash":
          this.handleSlash(interaction as ChatInputCommandInteraction).catch((err) => {
            this.logger.error({ err }, "slash handler crashed");
          });
          return;
        case "config-edit":
          this.handlePersistentComponent(
            interaction as ButtonInteraction | ModalSubmitInteraction
          ).catch((err) => {
            this.logger.error({ err }, "config-editor component handler crashed");
          });
          return;
        case "choice":
          this.handleChoiceInteraction(
            interaction as ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction
          ).catch((err) => {
            this.logger.error({ err }, "choice-card interaction handler crashed");
          });
          return;
        default:
          return;
      }
    });
    this.client.on(Events.ThreadDelete, (thread) => {
      void Promise.resolve(this.threadDeleteHandler?.(thread.id)).catch((err) => {
        this.logger.error({ err }, "thread-delete handler crashed");
      });
    });
  }

  /** Resolve a message author's display name for speaker identity (issue #57 D5). */
  private resolveAuthorName(msg: Message): string {
    return resolveDiscordSpeakerName(
      {
        userId: msg.author.id,
        nickname: msg.member?.displayName ?? null,
        globalName: msg.author.globalName ?? null,
        username: msg.author.username,
      },
      this.config.DISCORD_USER_NAMES
    );
  }

  private async handleMessage(msg: Message): Promise<void> {
    if (!this.messageHandler) return;
    if (msg.author.bot) return;
    if (msg.type !== MessageType.Default && msg.type !== MessageType.Reply) return;
    if (!this.config.DISCORD_ALLOWED_USER_IDS.has(msg.author.id)) return;
    if (!msg.channel.isThread()) return;

    const thread = msg.channel as ThreadChannel;
    // #52: Gateway still delivers channels the bot cannot view, with name
    // `___hidden___` and CHANNEL_OBFUSCATED. Do not bind a session on those.
    if (isObfuscatedChannel(thread)) return;
    if (thread.parent && isObfuscatedChannel(thread.parent)) return;

    // If parent isn't accessible / not text, ignore.
    const parentId = thread.parentId ?? undefined;

    // Channel gate: the static env allowlist OR a DB-backed activation row (#22).
    // The env path is unchanged; an enabled active_projects row (keyed on the
    // parent channel) makes a channel respond at runtime without a redeploy.
    const allowedChannels = this.config.DISCORD_ALLOWED_CHANNEL_IDS;
    const envAllows = !allowedChannels || (!!parentId && allowedChannels.has(parentId));
    const dbAllows = !!parentId && (this.activeChannelCheck?.(parentId) ?? false);
    if (!envAllows && !dbAllows) return;

    // #80: detached threads stay in a seam-enabled channel but do not bind a
    // session and do not reply. Gate HERE — after allowlist/parent checks,
    // BEFORE IncomingMessage / messageHandler — because handleIncomingMessage
    // already ensureSessionRecords on the abort-in-flight path.
    //
    // v1 is a MESSAGE GATE only: inbound schedules / wakes / watches /
    // handoffs / steer synthesize an IncomingMessage and still fire. Do not
    // treat detach as a full mute.
    if (isThreadDetached(this.config, thread.id)) {
      this.logger.debug({ threadId: thread.id }, "skipping message in detached thread");
      return;
    }

    const text = (msg.content ?? "").trim();
    const attachments: MessageAttachment[] = msg.attachments.map((a) => ({
      url: a.url,
      filename: a.name ?? "attachment",
      contentType: a.contentType ?? null,
      size: a.size ?? 0,
    }));
    if (!text && attachments.length === 0) return;

    const channel: ChannelRef = {
      platform: PLATFORM,
      id: thread.id,
      ...(parentId ? { parentId } : {}),
    };

    const incoming: IncomingMessage = {
      channel,
      authorId: msg.author.id,
      authorName: this.resolveAuthorName(msg),
      authorIsBot: false,
      text,
      ...(attachments.length > 0 ? { attachments } : {}),
      raw: msg,
    };

    await this.messageHandler(incoming);
  }

  private async handleSlash(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (!this.config.DISCORD_ALLOWED_USER_IDS.has(interaction.user.id)) {
      await interaction.reply({
        content: "This bot is not available to you.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await this.slashHandler(interaction);
  }

  /**
   * Autocomplete MUST respond (even with `[]`) and MUST NOT throw — Discord
   * otherwise leaves the focused option broken. Allowlist misses and missing
   * handlers still `respond([])`.
   */
  private async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    try {
      if (!this.config.DISCORD_ALLOWED_USER_IDS.has(interaction.user.id)) {
        await interaction.respond([]);
        return;
      }
      if (!this.autocompleteHandler) {
        await interaction.respond([]);
        return;
      }
      await this.autocompleteHandler(interaction);
    } catch (err) {
      this.logger.warn({ err }, "autocomplete handler failed");
      if (!interaction.responded) {
        try {
          await interaction.respond([]);
        } catch {
          /* Discord will time the field out */
        }
      }
    }
  }

  /** Push the PNG avatar. Resolves with true on success, false if file not found. */
  async pushAvatar(): Promise<boolean> {
    const avatarPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../assets/seam-acp-avatar.png"
    );
    if (!fs.existsSync(avatarPath)) {
      this.logger.warn({ avatarPath }, "avatar file not found; skipping");
      return false;
    }
    await this.client.user!.setAvatar(avatarPath);
    this.logger.info("bot avatar updated");
    return true;
  }

  /** Push the PNG banner. Resolves with true on success, false if file not found. */
  async pushBanner(): Promise<boolean> {
    const bannerPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../assets/seam-acp-banner.png"
    );
    if (!fs.existsSync(bannerPath)) {
      this.logger.warn({ bannerPath }, "banner file not found; skipping");
      return false;
    }
    await this.client.user!.setBanner(bannerPath);
    this.logger.info("bot banner updated");
    return true;
  }

  private async applyAvatarIfNeeded(): Promise<void> {
    if (this.client.user?.avatar) return; // already has one
    try {
      await this.pushAvatar();
      await this.pushBanner();
    } catch (err) {
      this.logger.warn({ err }, "failed to set bot avatar/banner (rate-limited or missing file)");
    }
  }

  /**
   * Post an approval prompt with one button per ACP option and wait for a
   * click. Defaults to "cancelled" on timeout. Only an allowed user can
   * answer.
   */
  async requestApproval(
    channel: ChannelRef,
    req: RequestPermissionRequest,
    opts: { timeoutMs?: number } = {}
  ): Promise<RequestPermissionResponse> {
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    const ch = await this.fetchSendableChannel(channel.id);

    const tool = req.toolCall;
    const title = tool?.title ?? `Tool: ${tool?.kind ?? tool?.toolCallId ?? "unknown"}`;
    const embed = new EmbedBuilder()
      .setTitle("🔐 Permission requested")
      .setDescription(`The agent wants to run **${title}**.`)
      .setColor(0xfaa61a)
      .setFooter({
        text: `Auto-denies in ${Math.round(timeoutMs / 1000)}s.`,
      });

    if (tool?.kind) embed.addFields({ name: "Tool kind", value: tool.kind, inline: true });
    if (tool?.toolCallId)
      embed.addFields({ name: "Call ID", value: `\`${tool.toolCallId}\``, inline: true });

    // Discord allows up to 5 buttons per row. Most agents send 2–4 options.
    const buttons = req.options.slice(0, 5).map((opt, idx) =>
      new ButtonBuilder()
        .setCustomId(`seam-perm:${idx}:${opt.optionId.slice(0, 80)}`)
        .setLabel(opt.name.slice(0, 80))
        .setStyle(buttonStyleForKind(opt.kind))
        .setEmoji(buttonEmojiForKind(opt.kind))
    );
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

    const msg = await ch.send({ embeds: [embed], components: [row] });

    try {
      const interaction = await msg.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i) => {
          if (!this.config.DISCORD_ALLOWED_USER_IDS.has(i.user.id)) {
            i.reply({
              content: "This bot is not available to you.",
              flags: MessageFlags.Ephemeral,
            }).catch(() => {});
            return false;
          }
          return true;
        },
        time: timeoutMs,
      });

      const idxStr = interaction.customId.split(":")[1] ?? "";
      const idx = Number.parseInt(idxStr, 10);
      const chosen = req.options[idx];
      if (!chosen) {
        await msg.edit({ embeds: [embed.setFooter({ text: "❓ Invalid choice." })], components: [] });
        return { outcome: { outcome: "cancelled" } };
      }

      await msg.edit({
        embeds: [
          embed.setFooter({
            text: `${decisionEmoji(chosen.kind)} ${interaction.user.username} chose: ${chosen.name}`,
          }),
        ],
        components: [],
      });
      try {
        await interaction.deferUpdate();
      } catch {
        /* ignore */
      }
      return { outcome: { outcome: "selected", optionId: chosen.optionId } };
    } catch {
      // timeout / collector ended
      try {
        await msg.edit({
          embeds: [embed.setFooter({ text: "⏱️ Timed out — auto-denied." })],
          components: [],
        });
      } catch {
        /* ignore */
      }
      return { outcome: { outcome: "cancelled" } };
    }
  }

  /**
   * Post a propose-then-confirm card (#58 D5) and resolve when a human clicks
   * Apply / Reject. The card message is sent BEFORE this returns; the returned
   * `decision` promise settles later so the MCP tool can ack "card posted"
   * immediately and the change is applied only on a real human confirmation.
   * Only an allowed user can act on it, and the click carries that user's id —
   * the audit actor (the #57 trust anchor).
   */
  async postConfirmation(
    channel: ChannelRef,
    card: ConfirmationCard,
    opts: { timeoutMs?: number; authorizedUserIds?: ReadonlySet<string> } = {}
  ): Promise<{ decision: Promise<ConfirmationDecision> }> {
    const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
    // #74: the DISCORD_ALLOWED_USER_IDS fallback must still exclude restricted
    // participants (admin-set unset). mayConfigureUserIds returns the same
    // DISCORD_ALLOWED_USER_IDS reference when the participant set is unset.
    const allowed = opts.authorizedUserIds ?? mayConfigureUserIds(this.config);
    const ch = await this.fetchSendableChannel(channel.id);

    const embed = new EmbedBuilder()
      .setTitle(`🧩 ${card.title}`)
      .setColor(0x5865f2)
      .setFooter({ text: `Nothing changes until you click Apply · expires in ${Math.round(timeoutMs / 60000)}m.` });
    if (card.description) embed.setDescription(card.description);
    for (const f of card.fields.slice(0, 20)) {
      embed.addFields({ name: f.label, value: `\`${f.before}\` → \`${f.after}\``.slice(0, 1024) });
    }
    if (card.warnings && card.warnings.length > 0) {
      embed.addFields({ name: "⚠ Notes", value: card.warnings.map((w) => `• ${w}`).join("\n").slice(0, 1024) });
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("seam-cfg:apply").setLabel("Apply").setStyle(ButtonStyle.Success).setEmoji("✅"),
      new ButtonBuilder().setCustomId("seam-cfg:reject").setLabel("Reject").setStyle(ButtonStyle.Secondary).setEmoji("✖️")
    );

    const msg = await ch.send({ embeds: [embed], components: [row] });

    const decision: Promise<ConfirmationDecision> = (async () => {
      try {
        const interaction = await msg.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: (i) => {
            if (!allowed.has(i.user.id)) {
              i.reply({ content: "This confirmation is not available to you.", flags: MessageFlags.Ephemeral }).catch(
                () => {}
              );
              return false;
            }
            return true;
          },
          time: timeoutMs,
        });
        const confirmed = interaction.customId === "seam-cfg:apply";
        await msg
          .edit({
            embeds: [
              embed.setFooter({
                text: `${confirmed ? "✅ Applied" : "✖️ Rejected"} by ${interaction.user.username}.`,
              }),
            ],
            components: [],
          })
          .catch(() => {});
        try {
          await interaction.deferUpdate();
        } catch {
          /* ignore */
        }
        return { confirmed, userId: interaction.user.id, userName: interaction.user.username };
      } catch {
        await msg
          .edit({ embeds: [embed.setFooter({ text: "⏱️ Timed out — not applied." })], components: [] })
          .catch(() => {});
        return { confirmed: false };
      }
    })();

    return { decision };
  }

  private async fetchSendableChannel(
    channelId: string
  ): Promise<TextChannel | ThreadChannel> {
    const ch = await this.client.channels.fetch(channelId);
    if (!ch) throw new Error(`Channel ${channelId} not found`);
    if (isObfuscatedChannel(ch)) {
      throw new Error(`Channel ${channelId} is obfuscated (bot lacks VIEW_CHANNEL)`);
    }
    if (
      ch.type === ChannelType.GuildText ||
      ch.type === ChannelType.GuildAnnouncement ||
      ch.type === ChannelType.PublicThread ||
      ch.type === ChannelType.PrivateThread ||
      ch.type === ChannelType.AnnouncementThread
    ) {
      return ch as TextChannel | ThreadChannel;
    }
    throw new Error(`Channel ${channelId} is not text/thread (${ch.type})`);
  }

  private async registerSlashCommands(): Promise<void> {
    const appId = this.client.user?.id;
    if (!appId) {
      this.logger.warn("no client user id; skipping slash registration");
      return;
    }
    const rest = new REST({ version: "10" }).setToken(
      this.config.DISCORD_BOT_TOKEN
    );
    const body = [buildSeamCommand().toJSON()];
    const guildIds = this.config.DISCORD_DEV_GUILD_ID;
    if (guildIds.length > 0) {
      // Register to each listed guild — instant, and scoped to servers we
      // explicitly opt in (vs global, which exposes /seam in every server the
      // bot is in and takes ~1h to propagate).
      for (const guildId of guildIds) {
        // Per-guild try/catch: a guild the bot hasn't been invited to (or lost
        // access to) returns Missing Access / Unknown Guild. Skip it with a
        // clear warning so it can't abort registration for the other guilds or
        // disrupt boot — important now that the list is multi-guild.
        try {
          await rest.put(
            Routes.applicationGuildCommands(appId, guildId),
            { body }
          );
          this.logger.info({ guildId }, "registered guild slash commands");
        } catch (err) {
          this.logger.warn(
            { err, guildId },
            "failed to register guild slash commands — is the bot a member of this guild? skipping; other guilds unaffected"
          );
        }
      }
    } else {
      await rest.put(Routes.applicationCommands(appId), { body });
      this.logger.info("registered global slash commands");
    }
  }
}

function buttonStyleForKind(kind: string): ButtonStyle {
  switch (kind) {
    case "allow_always":
      return ButtonStyle.Success;
    case "allow_once":
      return ButtonStyle.Primary;
    case "reject_always":
      return ButtonStyle.Danger;
    case "reject_once":
    default:
      return ButtonStyle.Secondary;
  }
}

function buttonEmojiForKind(kind: string): string {
  switch (kind) {
    case "allow_always":
      return "✅";
    case "allow_once":
      return "👍";
    case "reject_always":
      return "🛑";
    case "reject_once":
    default:
      return "✋";
  }
}

function decisionEmoji(kind: string): string {
  return kind.startsWith("allow_") ? "✅" : "🚫";
}
