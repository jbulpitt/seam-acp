import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  REST,
  Routes,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  StringSelectMenuBuilder,
  type Message,
  type TextChannel,
  type ThreadChannel,
  type ChatInputCommandInteraction,
} from "discord.js";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../../lib/logger.js";
import type { Config } from "../../config.js";
import type {
  ChatAdapter,
  ChannelRef,
  IncomingMessage,
  MessageAttachment,
  MessageRef,
} from "../chat-adapter.js";
import { buildSeamCommand } from "./commands.js";

const PLATFORM = "discord";

export type SlashHandler = (
  interaction: ChatInputCommandInteraction
) => Promise<void>;

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

  private messageHandler?: (msg: IncomingMessage) => void | Promise<void>;
  private botUserId?: string;

  constructor(opts: {
    config: Config;
    logger: Logger;
    slashHandler: SlashHandler;
  }) {
    this.config = opts.config;
    this.logger = opts.logger.child({ adapter: PLATFORM });
    this.slashHandler = opts.slashHandler;
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
    });
    return { channel, id: sent.id };
  }

  async editMessage(message: MessageRef, text: string): Promise<void> {
    const ch = await this.fetchSendableChannel(message.channel.id);
    const msg = await ch.messages.fetch(message.id);
    await msg.edit({ content: text, flags: MessageFlags.SuppressEmbeds });
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
   * Show an interactive picker. Uses a button row when the choice count
   * fits Discord's 5-button limit; otherwise falls back to a string-select
   * menu (capped at the platform's 25-option limit). Returns null on
   * timeout or unauthorized interaction.
   */
  async sendChoicePicker(
    channel: ChannelRef,
    opts: {
      prompt: string;
      choices: ReadonlyArray<{ value: string; label: string; description?: string }>;
      timeoutMs?: number;
      authorizedUserIds?: ReadonlySet<string>;
    }
  ): Promise<{ value: string; userId: string } | null> {
    const ch = await this.fetchSendableChannel(channel.id);
    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

    const choices = opts.choices.slice(0, 25);
    if (choices.length === 0) return null;

    // Discord allows 5 buttons per row × 5 rows = 25 buttons total.
    // We cap at 15 (3 rows) so the picker stays visually manageable;
    // anything bigger drops to a single dropdown.
    const BUTTON_LIMIT = 15;
    const BUTTONS_PER_ROW = 5;
    const useButtons = choices.length <= BUTTON_LIMIT;
    const customId = `seam-pick:${Date.now()}`;

    const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
    if (useButtons) {
      const buttons = choices.map((c, idx) =>
        new ButtonBuilder()
          .setCustomId(`${customId}:${idx}`)
          .setLabel(c.label.slice(0, 80))
          .setStyle(ButtonStyle.Secondary)
      );
      for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
        components.push(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            buttons.slice(i, i + BUTTONS_PER_ROW)
          )
        );
      }
    } else {
      const select = new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder("Choose…")
        .addOptions(
          choices.map((c, idx) => ({
            value: String(idx),
            label: c.label.slice(0, 100),
            ...(c.description ? { description: c.description.slice(0, 100) } : {}),
          }))
        );
      components.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)
      );
    }

    const msg = await ch.send({
      content: opts.prompt,
      components,
    });

    try {
      const interaction = await msg.awaitMessageComponent({
        filter: (i) => {
          if (
            opts.authorizedUserIds &&
            !opts.authorizedUserIds.has(i.user.id)
          ) {
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

      let pickedIdx: number;
      if (interaction.componentType === ComponentType.Button) {
        pickedIdx = Number.parseInt(
          interaction.customId.split(":").pop() ?? "",
          10
        );
      } else if (interaction.componentType === ComponentType.StringSelect) {
        pickedIdx = Number.parseInt(interaction.values[0] ?? "", 10);
      } else {
        return null;
      }

      const chosen = choices[pickedIdx];
      if (!chosen) {
        await msg.edit({ content: `${opts.prompt}\n_Invalid choice._`, components: [] });
        return null;
      }

      await msg.edit({
        content: `${opts.prompt}\n✅ **${chosen.label}** (${interaction.user.username})`,
        components: [],
      });
      try {
        await interaction.deferUpdate();
      } catch {
        /* ignore */
      }
      return { value: chosen.value, userId: interaction.user.id };
    } catch {
      try {
        await msg.edit({
          content: `${opts.prompt}\n⏱️ _Timed out._`,
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

  // --- internals ---

  private wire(): void {
    this.client.on(Events.MessageCreate, (msg) => {
      this.handleMessage(msg).catch((err) => {
        this.logger.error({ err }, "message handler crashed");
      });
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "seam") return;
      this.handleSlash(interaction).catch((err) => {
        this.logger.error({ err }, "slash handler crashed");
      });
    });
  }

  private async handleMessage(msg: Message): Promise<void> {
    if (!this.messageHandler) return;
    if (msg.author.bot) return;
    if (!this.config.DISCORD_ALLOWED_USER_IDS.has(msg.author.id)) return;
    if (!msg.channel.isThread()) return;

    const thread = msg.channel as ThreadChannel;

    // If parent isn't accessible / not text, ignore.
    const parentId = thread.parentId ?? undefined;

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

  private async fetchSendableChannel(
    channelId: string
  ): Promise<TextChannel | ThreadChannel> {
    const ch = await this.client.channels.fetch(channelId);
    if (!ch) throw new Error(`Channel ${channelId} not found`);
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
    if (this.config.DISCORD_DEV_GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(
          appId,
          this.config.DISCORD_DEV_GUILD_ID
        ),
        { body }
      );
      this.logger.info(
        { guildId: this.config.DISCORD_DEV_GUILD_ID },
        "registered guild slash commands"
      );
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
