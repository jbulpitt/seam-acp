import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  REST,
  Routes,
  MessageFlags,
  type Message,
  type TextChannel,
  type ThreadChannel,
  type ChatInputCommandInteraction,
  type MessageReaction,
  type PartialMessageReaction,
  type User,
  type PartialUser,
} from "discord.js";
import type { Logger } from "../../lib/logger.js";
import type { Config } from "../../config.js";
import type {
  ChatAdapter,
  ChannelRef,
  IncomingMessage,
  MessageRef,
  ReactionEvent,
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
  private reactionHandler?: (event: ReactionEvent) => void | Promise<void>;
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
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });
  }

  onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  onReaction(handler: (event: ReactionEvent) => void | Promise<void>): void {
    this.reactionHandler = handler;
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

  async addReactions(message: MessageRef, reactions: string[]): Promise<void> {
    const ch = await this.fetchSendableChannel(message.channel.id);
    const msg = await ch.messages.fetch(message.id);
    for (const r of reactions) {
      try {
        await msg.react(r);
      } catch (err) {
        this.logger.warn({ err, reaction: r }, "addReaction failed");
      }
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
    this.client.on(Events.MessageReactionAdd, (reaction, user) => {
      this.handleReaction(reaction, user).catch((err) => {
        this.logger.error({ err }, "reaction handler crashed");
      });
    });
  }

  private async handleReaction(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser
  ): Promise<void> {
    if (!this.reactionHandler) return;
    if (user.bot) return;
    if (user.id !== this.config.DISCORD_OWNER_USER_ID) return;

    // Resolve partials so we have name + message id reliably.
    let resolved: MessageReaction;
    try {
      resolved = reaction.partial ? await reaction.fetch() : reaction;
    } catch (err) {
      this.logger.warn({ err }, "failed to fetch partial reaction");
      return;
    }
    const name = resolved.emoji.name;
    if (!name) return;

    const msg = resolved.message;
    const channelId = msg.channelId ?? msg.channel?.id;
    if (!channelId) return;

    const event: ReactionEvent = {
      message: {
        channel: { platform: PLATFORM, id: channelId },
        id: msg.id,
      },
      reaction: name,
      userId: user.id,
      userIsBot: !!user.bot,
    };
    await this.reactionHandler(event);
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
        flags: MessageFlags.Ephemeral,
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
