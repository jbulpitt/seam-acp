import { ApplicationCommandOptionType, type RESTPostAPIChatInputApplicationCommandsJSONBody, type APIApplicationCommandSubcommandOption, type APIApplicationCommandOption } from "discord.js";
import type { Logger } from "../lib/logger.js";
import type { AutocompleteContext, AutocompleteResponder, AutocompleteRoundTripPolicy } from "../platforms/discord/autocomplete.js";
import { projectRoundTripChoices } from "../platforms/discord/autocomplete.js";
import type { PluginContext } from "./types.js";
import type { BrowserReply } from "../core/session-browser.js";
import type { InteractionResponseMode } from "../platforms/interaction-response.js";

export interface SlashAccess {
  kind: "read-only" | "mutating";
  participantAllowed?: boolean;
  lockExempt?: boolean;
}

export interface SlashInvocation {
  threadId: string;
  parentId?: string;
  /** Scoped reply capability for internal persistent cards. */
  cardReply?: BrowserReply;
  actor: Readonly<{ id: string; name: string }>;
  string(name: string): string | null;
  boolean(name: string): boolean | null;
  reply(view: string | { content?: string; embeds?: unknown[]; components?: unknown[] }): Promise<void>;
}

export interface SlashDispatchInvocation extends SlashInvocation {
  acknowledge(mode: InteractionResponseMode): Promise<void>;
}

export interface SlashContribution {
  command: "seam" | "seamadmin";
  group?: Readonly<{ name: string; description: string }>;
  leaf: APIApplicationCommandSubcommandOption;
  access: SlashAccess | ((option: (name: string) => string | null | undefined) => SlashAccess);
  authorization: "user" | "config-admin";
  acknowledgement: InteractionResponseMode;
  help: string;
  autocomplete?: readonly { option: string; policy: AutocompleteRoundTripPolicy; respond: AutocompleteResponder }[];
  handle(invocation: SlashInvocation, context: PluginContext): Promise<void>;
}

type Entry = { plugin: string; contribution: SlashContribution; context: PluginContext };
export function slashPath(command: string, group: string | null | undefined, leaf: string): string {
  return [command, group, leaf].filter(Boolean).join("/");
}

/** Validate the same JSON Discord receives, including the kernel's leaves. */
export function validateSlashCommands(commands: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[]): void {
  for (const command of commands) {
    let budget = command.name.length + command.description.length;
    const walk = (siblings: readonly APIApplicationCommandOption[], path: string): void => {
      if (siblings.length > 25) throw new Error(`${path} exceeds 25 slots`);
      const names = new Set<string>();
      let optional = false;
      for (const option of siblings) {
        if (names.has(option.name)) throw new Error(`duplicate slash path ${path}/${option.name}`);
        names.add(option.name);
        if (!/^[a-z0-9_-]{1,32}$/.test(option.name) || !option.description || option.description.length > 100) {
          throw new Error(`invalid slash name or description ${path}/${option.name}`);
        }
        budget += option.name.length + option.description.length;
        if (option.type !== ApplicationCommandOptionType.Subcommand && option.type !== ApplicationCommandOptionType.SubcommandGroup) {
          if (optional && "required" in option && option.required) throw new Error(`required option follows optional at ${path}/${option.name}`);
          if (!("required" in option) || !option.required) optional = true;
        }
        if ("options" in option && option.options) walk(option.options, `${path}/${option.name}`);
        if ("choices" in option && option.choices) {
          if (option.choices.length > 25) throw new Error(`${path}/${option.name} exceeds 25 choices`);
          for (const choice of option.choices) {
            if (!choice.name || choice.name.length > 100 || (typeof choice.value === "string" && choice.value.length > 100)) {
              throw new Error(`invalid slash choice at ${path}/${option.name}`);
            }
            budget += choice.name.length + String(choice.value).length;
          }
        }
      }
    };
    walk(command.options ?? [], command.name);
    if (budget > 8000) throw new Error(`${command.name} exceeds 8000 characters (${budget})`);
  }
}

export class SlashRegistry {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly logger: Logger) {}

  validate(contributions: readonly SlashContribution[]): void {
    const paths = new Set(this.entries.keys());
    for (const contribution of contributions) {
      const key = slashPath(contribution.command, contribution.group?.name, contribution.leaf.name);
      if (paths.has(key)) throw new Error(`duplicate slash path ${key}`);
      paths.add(key);
      const options = new Set<string>();
      for (const responder of contribution.autocomplete ?? []) {
        if (options.has(responder.option)) throw new Error(`duplicate autocomplete ${key}/${responder.option}`);
        options.add(responder.option);
        if (!contribution.leaf.options?.some(option => option.name === responder.option && "autocomplete" in option && option.autocomplete)) {
          throw new Error(`autocomplete has no registered option ${key}/${responder.option}`);
        }
      }
    }
  }

  register(plugin: string, contributions: readonly SlashContribution[], context: PluginContext): void {
    this.validate(contributions);
    for (const contribution of contributions) this.entries.set(slashPath(contribution.command, contribution.group?.name, contribution.leaf.name), { plugin, contribution, context });
  }

  assemble(base: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[], extra: readonly SlashContribution[] = []): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
    const commands = structuredClone([...base]);
    for (const contribution of [...this.entries.values()].map(entry => entry.contribution).concat(extra)) {
      const command = commands.find(candidate => candidate.name === contribution.command);
      if (!command) throw new Error(`unknown slash parent ${contribution.command}`);
      command.options ??= [];
      let siblings: APIApplicationCommandOption[] = command.options;
      if (contribution.group) {
        let group = command.options.find(option => option.name === contribution.group!.name);
        if (group && group.type !== ApplicationCommandOptionType.SubcommandGroup) throw new Error(`slash group collides with leaf ${contribution.command}/${group.name}`);
        if (!group) {
          group = { type: ApplicationCommandOptionType.SubcommandGroup, ...contribution.group, options: [] };
          command.options.push(group);
        }
        if (group.description !== contribution.group.description) throw new Error(`conflicting slash group description ${group.name}`);
        if (group.type === ApplicationCommandOptionType.SubcommandGroup) siblings = group.options ??= [];
      }
      siblings.push(structuredClone(contribution.leaf));
    }
    validateSlashCommands(commands);
    return commands;
  }

  get(command: string, group: string | null, leaf: string): SlashContribution | undefined {
    return this.entries.get(slashPath(command, group, leaf))?.contribution;
  }
  help(): string[] { return [...this.entries.values()].map(entry => entry.contribution.help); }
  autocomplete(command: string, ctx: AutocompleteContext): AutocompleteResponder | undefined {
    const entry = ctx.subcommand ? this.entries.get(slashPath(command, ctx.group, ctx.subcommand)) : undefined;
    const responder = entry?.contribution.autocomplete?.find(item => item.option === ctx.optionName);
    if (!responder) return undefined;
    return async invocation => {
      try { return projectRoundTripChoices(await responder.respond(invocation), responder.policy); }
      catch (err) {
        this.logger.error({ err, plugin: entry!.plugin, option: ctx.optionName }, "plugin autocomplete failed");
        throw err;
      }
    };
  }
  async dispatch(command: string, group: string | null, leaf: string, invocation: SlashDispatchInvocation): Promise<boolean> {
    const entry = this.entries.get(slashPath(command, group, leaf));
    if (!entry) return false;
    try {
      await invocation.acknowledge(entry.contribution.acknowledgement);
      await entry.contribution.handle(invocation, entry.context);
    }
    catch (err) {
      this.logger.error({ err, plugin: entry.plugin, path: slashPath(command, group, leaf) }, "plugin slash handler failed");
      throw err;
    }
    return true;
  }
  remove(plugin: string): void { for (const [name, entry] of this.entries) if (entry.plugin === plugin) this.entries.delete(name); }
  clear(): void { this.entries.clear(); }
}
