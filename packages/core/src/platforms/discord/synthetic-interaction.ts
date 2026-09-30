/**
 * A stand-in Discord interaction for a test deployment, injected into the
 * client's own interactionCreate stream so every route sees it the way it sees
 * a real click or slash command: persistent components, choice cards, and the
 * awaitMessageComponent waits on pickers and approvals.
 *
 * It keeps Discord's rules: a 3 s acknowledgement deadline (10062 after it),
 * one acknowledgement only (40060), and a 15 min follow-up window (50027).
 * Ephemeral replies are posted for real in the channel with a visible marker,
 * since a bot cannot show another bot a private message.
 */
import {
  ApplicationCommandOptionType,
  ComponentType,
  Events,
  InteractionType,
  SnowflakeUtil,
  type APIApplicationCommandOption,
  type Client,
  type GuildMember,
  type Message,
  type RESTPostAPIApplicationCommandsJSONBody,
  type TextBasedChannel,
  type User,
} from "discord.js";

const ACK_DEADLINE_MS = 3_000;
const TOKEN_LIFETIME_MS = 15 * 60_000;
const EPHEMERAL_FLAG = 64;
const EPHEMERAL_MARKER = "👁️ *ephemeral — only the tester would see this*";

export type TestInteractionSpec =
  | { kind: "button"; channelId: string; messageId: string; customId: string }
  | { kind: "select"; channelId: string; messageId: string; customId: string; values: string[] }
  | { kind: "modal"; channelId: string; messageId?: string; customId: string; fields: Record<string, string> }
  | {
      kind: "slash" | "autocomplete";
      channelId: string;
      command: string;
      subcommandGroup?: string;
      subcommand?: string;
      options?: Record<string, string | number | boolean>;
      focused?: string;
    };

export interface TranscriptEntry {
  choices?: Array<{ name: string; value: string | number }>;
  op: string;
  atMs: number;
  ephemeral?: boolean;
  content?: string;
  embeds?: string[];
  components?: string[];
  messageId?: string;
  modal?: { customId: string; title: string; inputs: Array<{ id: string; label: string }> };
  error?: { code: number | string; message: string };
}

/** Discord's API errors, with the codes the handlers check. */
export function discordError(code: number | string, message: string): Error & { code: number | string; status?: number } {
  const err = new Error(message) as Error & { code: number | string; status?: number };
  err.name = typeof code === "number" ? `DiscordAPIError[${code}]` : `DiscordjsError [${code}]`;
  err.code = code;
  if (typeof code === "number") err.status = code === 10062 || code === 10015 ? 404 : 400;
  return err;
}

type ReplyOptions = string | {
  content?: string;
  embeds?: unknown[];
  components?: unknown[];
  files?: unknown[];
  flags?: number | number[];
  ephemeral?: boolean;
  fetchReply?: boolean;
  withResponse?: boolean;
};

function isEphemeral(opts: ReplyOptions): boolean {
  if (typeof opts === "string") return false;
  const flags = Array.isArray(opts.flags) ? opts.flags.reduce((a, b) => a | b, 0) : (opts.flags ?? 0);
  return opts.ephemeral === true || (flags & EPHEMERAL_FLAG) !== 0;
}

function summarize(opts: ReplyOptions): Pick<TranscriptEntry, "content" | "embeds" | "components"> {
  if (typeof opts === "string") return { content: opts };
  const json = (x: unknown) => (x && typeof (x as { toJSON?: () => unknown }).toJSON === "function"
    ? (x as { toJSON: () => unknown }).toJSON() : x) as Record<string, unknown>;
  const embeds = (opts.embeds ?? []).map((e) => {
    const j = json(e) as { title?: string; description?: string };
    return [j.title, j.description].filter(Boolean).join(" — ").slice(0, 300);
  });
  const components = (opts.components ?? []).flatMap((row) => {
    const r = json(row) as { components?: Array<{ custom_id?: string; label?: string; options?: Array<{ value: string }> }> };
    return (r.components ?? []).map((c) => `${c.label ?? ""} [${c.custom_id ?? ""}]${c.options ? ` {${c.options.map((o) => o.value).join(",")}}` : ""}`);
  });
  return {
    ...(opts.content ? { content: opts.content } : {}),
    ...(embeds.length ? { embeds } : {}),
    ...(components.length ? { components } : {}),
  };
}

function sendable(opts: ReplyOptions, ephemeral: boolean): Record<string, unknown> {
  const base = typeof opts === "string" ? { content: opts } : { ...opts };
  delete (base as Record<string, unknown>).ephemeral;
  delete (base as Record<string, unknown>).fetchReply;
  delete (base as Record<string, unknown>).withResponse;
  delete (base as Record<string, unknown>).flags;
  if (ephemeral) base.content = `${EPHEMERAL_MARKER}\n${(base as { content?: string }).content ?? ""}`.trim();
  return base;
}

/** A discord.js-shaped option resolver checked against the registered command. */
class SyntheticOptions {
  readonly data: Array<{ name: string; type: number; value?: unknown; options?: unknown[] }>;
  constructor(
    private readonly group: string | null,
    private readonly sub: string | null,
    private readonly values: Record<string, string | number | boolean>,
    private readonly types: Map<string, number>,
    private readonly focused?: string,
  ) {
    const leaf = Object.entries(values).map(([name, value]) => ({ name, type: types.get(name) ?? 3, value }));
    if (sub && group) this.data = [{ name: group, type: 2, options: [{ name: sub, type: 1, options: leaf }] }];
    else if (sub) this.data = [{ name: sub, type: 1, options: leaf }];
    else this.data = leaf;
  }
  getSubcommandGroup(required = false): string | null {
    if (required && !this.group) throw discordError("CommandInteractionOptionNoSubcommandGroup", "No subcommand group specified for interaction.");
    return this.group;
  }
  getFocused(withName = false): unknown {
    const name = this.focused ?? "";
    const value = this.values[name] ?? "";
    return withName ? { name, value, type: this.types.get(name) ?? 3 } : value;
  }
  getSubcommand(required = true): string | null {
    if (required && !this.sub) throw discordError("CommandInteractionOptionNoSubcommand", "No subcommand specified for interaction.");
    return this.sub;
  }
  private get(name: string, required: boolean): unknown {
    const v = this.values[name];
    if (v === undefined) {
      if (required) throw discordError("CommandInteractionOptionNotFound", `Required option "${name}" not found.`);
      return null;
    }
    return v;
  }
  getString(name: string, required = false): string | null { const v = this.get(name, required); return v === null ? null : String(v); }
  getBoolean(name: string, required = false): boolean | null { const v = this.get(name, required); return v === null ? null : Boolean(v); }
  getInteger(name: string, required = false): number | null { const v = this.get(name, required); return v === null ? null : Math.trunc(Number(v)); }
  getNumber(name: string, required = false): number | null { const v = this.get(name, required); return v === null ? null : Number(v); }
  getAttachment(name: string, required = false): unknown {
    const v = this.get(name, required);
    return v === null ? null : { url: String(v), name: String(v).split("/").pop() ?? "file", size: 0, contentType: null };
  }
}

/**
 * Check a slash spec against the registered command: the command, group and
 * subcommand exist, every option is declared, required options are present,
 * and values fit their type and choices. Returns the option type map.
 */
export function validateSlashSpec(
  spec: Extract<TestInteractionSpec, { command: string }>,
  commands: RESTPostAPIApplicationCommandsJSONBody[],
): Map<string, number> {
  const command = commands.find((c) => c.name === spec.command);
  if (!command) throw new Error(`unknown command /${spec.command}`);
  let level = (command.options ?? []) as APIApplicationCommandOption[];
  if (spec.subcommandGroup) {
    const group = level.find((o) => o.name === spec.subcommandGroup && o.type === ApplicationCommandOptionType.SubcommandGroup);
    if (!group || !("options" in group)) throw new Error(`/${spec.command} has no subcommand group "${spec.subcommandGroup}"`);
    level = (group.options ?? []) as APIApplicationCommandOption[];
  }
  if (spec.subcommand) {
    const sub = level.find((o) => o.name === spec.subcommand && o.type === ApplicationCommandOptionType.Subcommand);
    if (!sub || !("options" in sub)) throw new Error(`/${spec.command}${spec.subcommandGroup ? ` ${spec.subcommandGroup}` : ""} has no subcommand "${spec.subcommand}"`);
    level = (sub.options ?? []) as APIApplicationCommandOption[];
  } else if (level.some((o) => o.type === ApplicationCommandOptionType.Subcommand || o.type === ApplicationCommandOptionType.SubcommandGroup)) {
    throw new Error(`/${spec.command} needs a subcommand`);
  }
  const types = new Map<string, number>();
  const given = spec.options ?? {};
  for (const name of Object.keys(given)) {
    const opt = level.find((o) => o.name === name);
    if (!opt) throw new Error(`option "${name}" is not declared on this command`);
    types.set(name, opt.type);
    const value = given[name];
    const bad = (want: string) => new Error(`option "${name}" must be ${want}`);
    switch (opt.type) {
      case ApplicationCommandOptionType.String: if (typeof value !== "string") throw bad("a string"); break;
      case ApplicationCommandOptionType.Integer: if (!Number.isInteger(value)) throw bad("an integer"); break;
      case ApplicationCommandOptionType.Number: if (typeof value !== "number") throw bad("a number"); break;
      case ApplicationCommandOptionType.Boolean: if (typeof value !== "boolean") throw bad("a boolean"); break;
      default: break;
    }
    const choices = "choices" in opt ? (opt.choices as Array<{ value: unknown }> | undefined) : undefined;
    if (choices?.length && !choices.some((c) => c.value === value)) {
      throw new Error(`option "${name}" must be one of ${choices.map((c) => JSON.stringify(c.value)).join(", ")}`);
    }
  }
  for (const opt of level) {
    if (spec.kind !== "autocomplete" && "required" in opt && opt.required && !(opt.name in given)) throw new Error(`required option "${opt.name}" is missing`);
  }
  if (spec.kind === "autocomplete" && !level.some((opt) => opt.name === spec.focused && "autocomplete" in opt && opt.autocomplete)) {
    throw new Error(`option "${spec.focused}" does not support autocomplete`);
  }
  return types;
}

export interface SyntheticContext {
  client: Client;
  channel: TextBasedChannel & { id: string; guildId?: string | null; send: (o: unknown) => Promise<Message> };
  user: User;
  member: GuildMember | null;
  message?: Message;
  now?: () => number;
}

export class SyntheticInteraction {
  readonly id = SnowflakeUtil.generate().toString();
  readonly createdTimestamp: number;
  readonly transcript: TranscriptEntry[] = [];
  replied = false;
  deferred = false;
  ephemeral: boolean | null = null;
  private replyMessage?: Message;
  private readonly now: () => number;

  readonly type: InteractionType;
  readonly componentType?: ComponentType;
  readonly customId?: string;
  readonly values?: string[];
  readonly fields?: { getTextInputValue: (id: string) => string; fields: Map<string, { value: string }> };
  readonly commandName?: string;
  readonly options?: SyntheticOptions;
  readonly client: Client;
  readonly channel: SyntheticContext["channel"];
  readonly channelId: string;
  readonly guildId: string | null;
  readonly user: User;
  readonly member: GuildMember | null;
  readonly message?: Message;

  constructor(spec: TestInteractionSpec, ctx: SyntheticContext, slashTypes?: Map<string, number>) {
    this.now = ctx.now ?? Date.now;
    this.createdTimestamp = this.now();
    this.client = ctx.client;
    this.channel = ctx.channel;
    this.channelId = ctx.channel.id;
    this.guildId = ctx.channel.guildId ?? null;
    this.user = ctx.user;
    this.member = ctx.member;
    if (ctx.message) this.message = ctx.message;
    switch (spec.kind) {
      case "button":
        this.type = InteractionType.MessageComponent; this.componentType = ComponentType.Button; this.customId = spec.customId; break;
      case "select":
        this.type = InteractionType.MessageComponent; this.componentType = ComponentType.StringSelect; this.customId = spec.customId; this.values = spec.values; break;
      case "modal": {
        this.type = InteractionType.ModalSubmit; this.customId = spec.customId;
        const map = new Map(Object.entries(spec.fields).map(([k, v]) => [k, { value: v }]));
        this.fields = {
          fields: map,
          getTextInputValue: (id: string) => {
            const f = map.get(id);
            if (!f) throw discordError("ModalSubmitInteractionFieldNotFound", `Required field with custom id "${id}" not found.`);
            return f.value;
          },
        };
        break;
      }
      case "autocomplete":
      case "slash":
        this.type = spec.kind === "autocomplete" ? InteractionType.ApplicationCommandAutocomplete : InteractionType.ApplicationCommand;
        this.commandName = spec.command;
        this.options = new SyntheticOptions(spec.subcommandGroup ?? null, spec.subcommand ?? null, spec.options ?? {}, slashTypes ?? new Map(), spec.focused);
        break;
    }
  }

  get createdAt(): Date { return new Date(this.createdTimestamp); }
  inGuild(): boolean { return this.guildId !== null; }
  isRepliable(): boolean { return true; }
  isAutocomplete(): boolean { return this.type === InteractionType.ApplicationCommandAutocomplete; }
  isChatInputCommand(): boolean { return this.type === InteractionType.ApplicationCommand; }
  isCommand(): boolean { return this.isChatInputCommand(); }
  isButton(): boolean { return this.componentType === ComponentType.Button; }
  isStringSelectMenu(): boolean { return this.componentType === ComponentType.StringSelect; }
  isAnySelectMenu(): boolean { return this.isStringSelectMenu(); }
  isMessageComponent(): boolean { return this.type === InteractionType.MessageComponent; }
  isModalSubmit(): boolean { return this.type === InteractionType.ModalSubmit; }

  private record(entry: Omit<TranscriptEntry, "atMs">): void {
    this.transcript.push({ ...entry, atMs: this.now() - this.createdTimestamp });
  }

  private fail(op: string, err: Error & { code: number | string }): never {
    this.record({ op, error: { code: err.code, message: err.message } });
    throw err;
  }

  /** First acknowledgement: within 3 s, and only once. */
  private acknowledge(op: string): void {
    if (this.replied || this.deferred) this.fail(op, discordError(40060, "Interaction has already been acknowledged."));
    if (this.now() - this.createdTimestamp > ACK_DEADLINE_MS) this.fail(op, discordError(10062, "Unknown interaction"));
  }

  /** Webhook-token calls after the first acknowledgement, within 15 min. */
  private followOn(op: string): void {
    if (!this.replied && !this.deferred) this.fail(op, discordError("InteractionNotReplied", "The reply to this interaction has not been sent or deferred."));
    if (this.now() - this.createdTimestamp > TOKEN_LIFETIME_MS) this.fail(op, discordError(50027, "Invalid Webhook Token"));
  }

  private async post(op: string, opts: ReplyOptions, ephemeral: boolean): Promise<Message> {
    const message = await this.channel.send(sendable(opts, ephemeral));
    this.record({ op, ephemeral, ...summarize(opts), messageId: message.id });
    return message;
  }

  private response(message: Message | undefined, opts: ReplyOptions): unknown {
    if (typeof opts !== "string" && opts.fetchReply) return message;
    if (typeof opts !== "string" && opts.withResponse) return { resource: { message } };
    return { id: message?.id ?? this.id, interaction: this, fetch: async () => message };
  }

  async reply(opts: ReplyOptions): Promise<unknown> {
    this.acknowledge("reply");
    const ephemeral = isEphemeral(opts);
    this.replied = true;
    this.ephemeral = ephemeral;
    this.replyMessage = await this.post("reply", opts, ephemeral);
    return this.response(this.replyMessage, opts);
  }

  async deferReply(opts: ReplyOptions = {}): Promise<unknown> {
    this.acknowledge("deferReply");
    this.deferred = true;
    this.ephemeral = isEphemeral(opts);
    this.record({ op: "deferReply", ephemeral: this.ephemeral });
    return this.response(undefined, opts);
  }

  async editReply(opts: ReplyOptions): Promise<Message> {
    this.followOn("editReply");
    const ephemeral = this.ephemeral === true;
    if (this.replyMessage) {
      const message = await this.replyMessage.edit(sendable(opts, ephemeral) as never);
      this.record({ op: "editReply", ephemeral, ...summarize(opts), messageId: message.id });
      return message;
    }
    this.replyMessage = await this.post("editReply", opts, ephemeral);
    return this.replyMessage;
  }

  async followUp(opts: ReplyOptions): Promise<Message> {
    this.followOn("followUp");
    return this.post("followUp", opts, isEphemeral(opts));
  }

  async fetchReply(): Promise<Message> {
    this.followOn("fetchReply");
    if (!this.replyMessage) this.fail("fetchReply", discordError(10008, "Unknown Message"));
    return this.replyMessage!;
  }

  async deleteReply(): Promise<void> {
    this.followOn("deleteReply");
    if (this.replyMessage) await this.replyMessage.delete().catch(() => {});
    this.record({ op: "deleteReply" });
  }

  async update(opts: ReplyOptions): Promise<unknown> {
    this.acknowledge("update");
    this.replied = true;
    if (!this.message) this.fail("update", discordError(10008, "Unknown Message"));
    const edited = await this.message!.edit(sendable(opts, false) as never);
    this.replyMessage = edited;
    this.record({ op: "update", ...summarize(opts), messageId: edited.id });
    return this.response(edited, opts);
  }

  async deferUpdate(): Promise<unknown> {
    this.acknowledge("deferUpdate");
    this.deferred = true;
    if (this.message) this.replyMessage = this.message;
    this.record({ op: "deferUpdate" });
    return { id: this.id, interaction: this };
  }

  async showModal(modal: unknown): Promise<void> {
    this.acknowledge("showModal");
    this.replied = true;
    const j = (modal && typeof (modal as { toJSON?: () => unknown }).toJSON === "function"
      ? (modal as { toJSON: () => unknown }).toJSON() : modal) as {
        custom_id?: string; title?: string;
        components?: Array<{ components?: Array<{ custom_id?: string; label?: string }>; component?: { custom_id?: string }; label?: string }>;
      };
    const inputs = (j.components ?? []).flatMap((row) => {
      if (row.components) return row.components.map((c) => ({ id: c.custom_id ?? "", label: c.label ?? "" }));
      if (row.component) return [{ id: row.component.custom_id ?? "", label: row.label ?? "" }];
      return [];
    });
    this.record({ op: "showModal", modal: { customId: j.custom_id ?? "", title: j.title ?? "", inputs } });
  }

  async awaitModalSubmit(opts: {
    filter?: (interaction: SyntheticInteraction) => boolean;
    time?: number;
  }): Promise<SyntheticInteraction> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        this.client.off(Events.InteractionCreate, onInteraction as never);
        if (timer) clearTimeout(timer);
      };
      const onInteraction = (interaction: unknown) => {
        const candidate = interaction as SyntheticInteraction;
        if (!candidate.isModalSubmit?.() || (opts.filter && !opts.filter(candidate))) return;
        cleanup();
        resolve(candidate);
      };
      this.client.on(Events.InteractionCreate, onInteraction as never);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Modal submit timed out"));
      }, opts.time ?? 15 * 60_000);
    });
  }

  async respond(choices: Array<{ name: string; value: string | number }>): Promise<void> {
    this.acknowledge("respond");
    this.replied = true;
    this.record({ op: "respond", choices });
  }
}
