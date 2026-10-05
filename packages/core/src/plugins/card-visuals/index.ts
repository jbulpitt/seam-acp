import { ApplicationCommandOptionType as Option } from "discord.js";
import { z } from "zod";
import type { Plugin } from "../types.js";
import type { SlashContribution, SlashInvocation } from "../slash-registry.js";
import type { ConfigKeyContribution } from "../config-key-registry.js";
import type { StatusCardStyle } from "../../core/types.js";
import { brandIconUrl, resolveAgentBrand } from "./agent-brand.js";
import { CardGifCatalog, DEFAULT_GIF_REFRESH_MS } from "./card-gifs.js";

export const CARD_VISUAL_KEYS = [
  { key: "statusCardStyle", schema: z.enum(["full", "simple"]), defaultValue: "full", description: "Status-card layout (full or simple)." },
  { key: "simpleCardGif", schema: z.preprocess(value => value === "on" || value === "true" ? true : value === "off" || value === "false" ? false : value, z.boolean()), defaultValue: false, description: "Curated GIF beside a simple status card." },
] as const satisfies readonly ConfigKeyContribution[];

type Key = typeof CARD_VISUAL_KEYS[number]["key"];
type Scope = "session" | "thread" | "channel";
export interface CardVisualsPort {
  read(threadId: string): { parentId?: string; style: { value: StatusCardStyle; source: string }; gif: { value: boolean; source: string } } | undefined;
  write(threadId: string, scope: Scope, key: Key, value: unknown, actor: SlashInvocation["actor"]): { ok: true } | { ok: false; error: string };
}

const schema = z.object({ SIMPLE_CARD_GIF_MANIFEST_URL: z.string().url(), BRAND_ICON_BASE_URL: z.string().url() });
const group = { name: "config", description: "Session and bot configuration" };
const scopeOption = { type: Option.String as const, name: "scope", description: "session (this thread, default) | thread preset | channel (all threads)",
  choices: [{ name: "session (this thread override)", value: "session" }, { name: "thread preset", value: "thread" }, { name: "channel (all threads inherit)", value: "channel" }] };

/** Built-in-only config facade. It never receives sessions or the router. */
export function createCardVisualsPlugin(port: CardVisualsPort): Plugin {
  let catalog: CardGifCatalog;
  let baseUrl: string;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: Promise<void> | undefined;
  const stop = () => { if (timer) clearInterval(timer); timer = undefined; };
  const command = (kind: "card" | "gif"): SlashContribution => {
    const key: Key = kind === "card" ? "statusCardStyle" : "simpleCardGif";
    const option = kind === "card" ? "style" : "state";
    const choices = kind === "card" ? ["full", "simple"] : ["on", "off"];
    return {
      command: "seam", group,
      acknowledgement: "ephemeral", leaf: { type: Option.Subcommand, name: kind, description: kind === "card" ? "Get or set the status-card layout (full or simple)" : "Random GIF thumbnail on the simple status card (on or off)",
        options: [{ type: Option.String, name: option, description: kind === "card" ? "full (default) | simple (compact, brand icon)" : "on | off", choices: choices.map(value => ({ name: value, value })) }, scopeOption] },
      access: get => ({ kind: get(option) != null ? "mutating" : "read-only" }), authorization: "user",
      help: `/seam config ${kind} [${option}] [scope] — ${CARD_VISUAL_KEYS.find(entry => entry.key === key)!.description}`,
      handle: async invocation => {
        const current = port.read(invocation.threadId);
        if (!current) return invocation.reply("Use inside a thread.");
        const value = invocation.string(option);
        const resolved = kind === "card" ? current.style : current.gif;
        const label = kind === "card" ? "Status card" : "Simple-card GIF";
        const display = (v: unknown) => typeof v === "boolean" ? v ? "on" : "off" : String(v);
        if (value == null) return invocation.reply(`${label}: \`${display(resolved.value)}\` (from ${resolved.source}). Set with \`/seam config ${kind} ${option}:${choices.join("|")} [scope:session|thread|channel]\`.`);
        if (!choices.includes(value)) return invocation.reply(kind === "card" ? "Style must be `full` or `simple`." : "State must be `on` or `off`.");
        const scope = invocation.string("scope") ?? "session";
        if (scope !== "session" && scope !== "thread" && scope !== "channel") return invocation.reply("Scope must be session, thread or channel.");
        if (scope === "channel" && !current.parentId) return invocation.reply("This thread has no parent channel to configure.");
        const written = port.write(invocation.threadId, scope, key, kind === "card" ? value : value === "on", invocation.actor);
        if (!written.ok) return invocation.reply(written.error);
        return invocation.reply(`${scope === "channel" ? "Channel" : scope === "thread" ? "Thread-preset" : "Session"} ${label.toLowerCase()} set to \`${value}\`. Applies on the next turn.`);
      },
    };
  };
  return {
    id: "card-visuals", apiVersion: 1, builtin: true, internal: true,
    validateConfig: config => schema.parse(config),
    activate: context => {
      const config = schema.parse(context.config);
      baseUrl = config.BRAND_ICON_BASE_URL;
      catalog = new CardGifCatalog({ url: config.SIMPLE_CARD_GIF_MANIFEST_URL, logger: context.logger });
    },
    dispose: async () => { stop(); await pending; },
    contributions: {
      configKeys: CARD_VISUAL_KEYS,
      slash: [command("card"), command("gif")],
      statusCards: [{ name: "visuals", decorate: facts => ({
        style: facts.style,
        icon: brandIconUrl(resolveAgentBrand(facts.agentId, facts.profileBrand), baseUrl),
        ...(facts.style === "simple" && facts.gifOn ? { thumbnail: catalog.randomGif() ?? undefined } : {}),
      }) }],
      jobs: [{ name: "gif-manifest", phase: "after-admission", intervalMs: DEFAULT_GIF_REFRESH_MS,
        start: ({ signal, intervalMs }) => {
          const refresh = () => pending ??= catalog.refresh(signal).finally(() => { pending = undefined; });
          void refresh();
          timer = setInterval(() => void refresh(), intervalMs);
          timer.unref?.();
        }, stop, drain: async () => { await pending; } }],
    },
  };
}
