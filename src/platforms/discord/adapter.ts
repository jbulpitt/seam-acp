import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  REST,
  Routes,
  type Message,
  type TextChannel,
  type ThreadChannel,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { Logger } from "../../lib/logger.js";
import type { Config } from "../../config.js";
import type {
  ChatAdapter,
  ChannelRef,
  IncomingMessage,
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
      partials: [Partials.Channel],
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
    const sent = await ch.send({ content: text });
    return { channel, id: sent.id };
  }

  async editMessage(message: MessageRef, text: string): Promise<void> {
    const ch = await this.fetchSendableChannel(message.channel.id);
    const msg = await ch.messages.fetch(message.id);
    await msg.edit({ content: text });
  }

  async createThread(parent: ChannelRef, name: string): Promise<ChannelRef> {
    const ch = await this.client.channels.fetch(parent.id);
    if (!ch || ch.type !== ChannelType.GuildText) {
      throw new Error(`Parent channel ${parent.id} is not a text channel`);
    }
    const thread = await (ch as TextChannel).threads.create({
      name,
      autoArchiveDuration: 1440,
      type: ChannelType.PublicThread,
    });
    return {
      platform: PLATFORM,
      id: thread.id,
      parentId: parent.id,
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
    if (msg.author.id !== this.config.DISCORD_OWNER_USER_ID) return;
    if (!msg.channel.isThread()) return;

    const thread = msg.channel as ThreadChannel;

    // If parent isn't accessible / not text, ignore.
    const parentId = thread.parentId ?? undefined;

    const text = (msg.content ?? "").trim();
    if (!text) return;

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
      raw: msg,
    };

    await this.messageHandler(incoming);
  }

  private async handleSlash(
    interaction: ChatInputCommandInteraction
  ): Promise<void> {
    if (interaction.user.id !== this.config.DISCORD_OWNER_USER_ID) {
      await interaction.reply({
        content: "This bot is not available to you.",
        ephemeral: true,
      });
      return;
    }
    await this.slashHandler(interaction);
  }

  private async fetchSendableChannel(
    channelId: string
  ): Promise<TextChannel | ThreadChannel> {
    const ch = await this.client.channels.fetch(channelId);
    if (!ch) throw new Error(`Channel ${channelId} not found`);
    if (
      ch.type === ChannelType.GuildText ||
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
