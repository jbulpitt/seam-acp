import { ApplicationCommandOptionType as Option } from "discord.js";
import { z } from "zod";
import type { Plugin } from "../types.js";
import type { SlashContribution, SlashInvocation } from "../slash-registry.js";
import type { ConfigKeyContribution } from "../config-key-registry.js";
import type { StatusCardStyle } from "../../core/types.js";
import { brandIconUrl, resolveAgentBrand } from "./agent-brand.js";
import { CardGifCatalog, DEFAULT_GIF_REFRESH_MS } from "./card-gifs.js";
import type { ChannelRef } from "../../platforms/chat-adapter.js";
import { configTarget, formatOverrideCounts, type OverrideCounts } from "../../core/config-target.js";

export const CARD_VISUAL_KEYS = [
  { key: "statusCardStyle", schema: z.enum(["full", "simple"]), defaultValue: "full", description: "Status-card layout (full or simple)." },
  { key: "simpleCardGif", schema: z.preprocess(value => value === "on" || value === "true" ? true : value === "off" || value === "false" ? false : value, z.boolean()), defaultValue: false, description: "Curated GIF beside a simple status card." },
] as const satisfies readonly ConfigKeyContribution[];

type Key = typeof CARD_VISUAL_KEYS[number]["key"];
type Scope = "session" | "thread" | "channel";
export interface CardVisualsPort {
  read(channel: ChannelRef, scope?: string | null): { style: { value: StatusCardStyle; source: string }; gif: { value: boolean; source: string } };
  write(channel: ChannelRef, scope: Scope, key: Key, value: unknown, actor: SlashInvocation["actor"]): { ok: true } | { ok: false; error: string };
  overrides(channelId: string): OverrideCounts;
  offer(channel: ChannelRef, actor: SlashInvocation["actor"], key: Key): Promise<void>;
}

const schema = z.object({ SIMPLE_CARD_GIF_MANIFEST_URL: z.string().url().optional(), BRAND_ICON_BASE_URL: z.string().url().optional() });
const group = { name: "config", description: "Session and bot configuration" };
const scopeOption = { type: Option.String as const, name: "scope", description: "This thread or channel default; parent commands use channel default",
  choices: [{ name: "This thread", value: "thread" }, { name: "Channel default", value: "channel" }] };

/** Built-in-only config facade. It never receives sessions or the router. */
export function createCardVisualsPlugin(port: CardVisualsPort): Plugin {
  let catalog: CardGifCatalog | undefined;
  let baseUrl: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
  const command = (kind: "card" | "gif"): SlashContribution => {
    const key: Key = kind === "card" ? "statusCardStyle" : "simpleCardGif";
    const option = kind === "card" ? "style" : "state";
    const choices = kind === "card" ? ["full", "simple", "default"] : ["on", "off", "default"];
    return {
      command: "seam", group,
      acknowledgement: "ephemeral", leaf: { type: Option.Subcommand, name: kind, description: kind === "card" ? "Get or set the status-card layout (full or simple)" : "Random GIF thumbnail on the simple status card (on or off)",
        options: [{ type: Option.String, name: option, description: kind === "card" ? "full (default) | simple (compact, brand icon)" : "on | off", choices: choices.map(value => ({ name: value, value })) }, scopeOption] },
      access: get => ({ kind: get(option) != null ? "mutating" : "read-only" }), authorization: "user",
      help: `/seam config ${kind} [${option}] [scope] — ${CARD_VISUAL_KEYS.find(entry => entry.key === key)!.description}`,
      handle: async invocation => {
        const channel: ChannelRef = { platform: "discord", id: invocation.threadId, ...(invocation.parentId ? { parentId: invocation.parentId } : {}) };
        const target = configTarget(channel, invocation.string("scope"));
        const scope = target.kind;
        const current = port.read(channel, scope);
        const value = invocation.string(option);
        const resolved = kind === "card" ? current.style : current.gif;
        const label = kind === "card" ? "Status card" : "Simple-card GIF";
        const display = (v: unknown) => typeof v === "boolean" ? v ? "on" : "off" : String(v);
        if (value == null) return invocation.reply(`${label}: \`${display(resolved.value)}\` (from ${resolved.source}). Set with \`/seam config ${kind} ${option}:${choices.join("|")} [scope:thread|channel]\`.`);
        if (!choices.includes(value)) return invocation.reply(kind === "card" ? "Style must be `full` or `simple`." : "State must be `on` or `off`.");
        const written = port.write(channel, scope, key, value === "default" ? null : kind === "card" ? value : value === "on", invocation.actor);
        if (!written.ok) return invocation.reply(written.error);
        const effective = port.read(channel, scope);
        const after = kind === "card" ? effective.style : effective.gif;
        await invocation.reply(`${scope === "channel" ? "Channel default" : "Thread"} ${label.toLowerCase()}: \`${display(after.value)}\` (from ${after.source}). Applies on the next turn.` +
          (scope === "channel" ? ` Thread overrides: ${formatOverrideCounts(port.overrides(target.id))}.` : ""));
        if (scope === "channel") await port.offer(channel, invocation.actor, key);
      },
    };
  };
  return {
    id: "card-visuals", apiVersion: 1, builtin: true, internal: true,
    validateConfig: config => schema.parse(config),
    activate: context => {
      const config = schema.parse(context.config);
      baseUrl = config.BRAND_ICON_BASE_URL;
      if (config.SIMPLE_CARD_GIF_MANIFEST_URL) catalog = new CardGifCatalog({ url: config.SIMPLE_CARD_GIF_MANIFEST_URL, logger: context.logger });
    },
    dispose: async () => { stop(); await pending; },
    contributions: {
      configKeys: CARD_VISUAL_KEYS,
      slash: [command("card"), command("gif")],
      statusCards: [{ name: "visuals", decorate: facts => ({
        style: facts.style,
        ...(baseUrl ? { icon: brandIconUrl(resolveAgentBrand(facts.agentId, facts.profileBrand), baseUrl) } : {}),
        ...(facts.style === "simple" && facts.gifOn ? { thumbnail: catalog?.randomGif() ?? undefined } : {}),
      }) }],
      jobs: [{ name: "gif-manifest", phase: "after-admission", intervalMs: DEFAULT_GIF_REFRESH_MS,
        start: ({ signal, intervalMs }) => {
          if (!catalog) return;
          const gifs = catalog;
          const refresh = () => pending ??= gifs.refresh(signal).finally(() => { pending = undefined; });
          void refresh();
          timer = setInterval(() => void refresh(), intervalMs);
          timer.unref?.();
        }, stop, drain: async () => { await pending; } }],
    },
  };
}
