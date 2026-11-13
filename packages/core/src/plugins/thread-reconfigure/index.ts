import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { SlashCommandSubcommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { Plugin } from "../types.js";
import type { Actor, BulkPlan, BulkPorts, BulkRequest, BulkRow } from "./ports.js";

interface SavedPlan extends BulkPlan { result?: BulkRow[]; applying?: boolean }
const ns = "seam-thread-reconfigure:";
const fields = ["scope", "scope-id", "target-model", "target-agent", "agent", "model", "preset", "preset-scope", "role", "name"] as const;
const keys = ["scope", "scopeId", "targetModel", "targetAgent", "agent", "model", "preset", "presetScope", "role", "name"] as const;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export function createThreadReconfigurePlugin(ports: BulkPorts): Plugin {
  let file: string | undefined;
  const plans = new Map<string, SavedPlan>();
  const persist = () => { if (file) { fs.writeFileSync(`${file}.tmp`, JSON.stringify([...plans.values()])); fs.renameSync(`${file}.tmp`, file); } };
  const actorRequired = (actor: Actor | undefined): Actor => { if (!actor) throw new Error("The current speaker could not be resolved."); return actor; };
  const get = (id: string, actor: Actor, origin: string) => {
    const plan = plans.get(id);
    if (!plan || plan.actor.id !== actor.id || plan.origin !== origin) throw new Error("This preview belongs to another caller or is unavailable.");
    return plan;
  };
  const preview = async (actor: Actor, origin: string, request: BulkRequest) => {
    const projected = await ports.preview(actor, request);
    const plan: SavedPlan = { id: randomUUID(), actor, origin, request: structuredClone(request), ...projected };
    plans.set(plan.id, plan); persist(); return plan;
  };
  const apply = async (plan: SavedPlan, actor: Actor) => {
    if (plan.result) return plan;
    if (plan.applying) throw new Error("This application has started. Inspect its audit/results before preparing another preview.");
    plan.applying = true; persist();
    try { plan.result = await ports.apply(actor, plan); }
    finally { persist(); }
    return plan;
  };
  const pages = (plan: SavedPlan) => {
    const rows = plan.result ?? plan.rows;
    const unconfirmed = !plan.result && plan.applying;
    const count = (status: string) => rows.filter(r => r.status === status).length;
    const observation = (r: BulkRow) => {
      if (!r.runtimeSelection) return "";
      const fast = r.runtimeSelection.fastMode;
      return `\nACP-selected model: ${r.runtimeSelection.model ?? "UNKNOWN"} (not API served-model verification). Fast: ${fast ? `requested ${fast.requested}; applied ${fast.applied ?? "UNKNOWN"}${fast.error ? `; ${fast.error}` : ""}` : "UNKNOWN"}`;
    };
    const lines = [`${unconfirmed ? "Started/unconfirmed" : plan.result ? "Result" : "Preview"} ${plan.id}: ${rows.length} matches; ${unconfirmed ? "PLANNED only — rows may have committed; saved/runtime outcomes UNKNOWN." : `${count("eligible")} eligible, ${count("changed")} changed, ${count("unchanged")} unchanged, ${count("skipped")} skipped, ${count("failed")} failed.`}`,
      ...plan.notes, ...rows.map(r => `${r.before.id} · ${r.before.name} · guild ${r.before.guildId} / channel ${r.before.parentId}\n${unconfirmed ? "PLANNED only" : "Configuration (before → requested)"}: ${JSON.stringify(r.before.identity)} → ${JSON.stringify(r.after ?? r.before.identity)}\nPreset: ${r.before.preset ? `${r.before.preset.name} (${r.before.preset.id}, scope ${r.before.preset.projectRef ?? "global"})` : "UNKNOWN"}\n${r.status}: ${r.reason ?? r.consequence ?? "no change"}${r.consequence === "reset" ? " — context resets" : ""}; verification ${r.verification ?? "not evaluated"}; saved ${unconfirmed ? "UNKNOWN" : plan.result ? r.saved === undefined ? "unknown" : r.saved : "not attempted"}; runtime ${unconfirmed ? "UNKNOWN" : r.runtime ?? (plan.result ? "unverified" : "not applied")}${observation(r)}${r.warnings?.length ? `\n${r.warnings.join("\n")}` : ""}`)];
    const out: string[] = []; let text = "";
    for (const line of lines) {
      for (let offset = 0; offset < line.length; offset += 1700) {
        const part = line.slice(offset, offset + 1700);
        if (text.length + part.length > 1750) { out.push(text); text = ""; }
        text += `${text ? "\n\n" : ""}${part}`;
      }
    }
    if (text) out.push(text); return out;
  };
  const page = (plan: SavedPlan, requested = 0) => {
    const content = pages(plan); const index = Math.max(0, Math.min(content.length - 1, requested));
    const button = (action: string, label: string, style = ButtonStyle.Secondary) => new ButtonBuilder()
      .setCustomId(`${ns}${action}:${plan.id}:${index}`).setLabel(label).setStyle(style);
    return { embeds: [{ description: `${content[index]}\n\nPage ${index + 1}/${content.length}` }], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      button("prev", "Previous").setDisabled(index === 0), button("next", "Next").setDisabled(index === content.length - 1),
      button("apply", "Apply", ButtonStyle.Primary).setDisabled(Boolean(plan.result || plan.applying)))] };
  };
  const requestFrom = (read: (name: string) => string | null) => Object.fromEntries(fields.flatMap((field, i) => {
    const value = read(field); return value === null ? [] : [[keys[i], value]];
  })) as unknown as BulkRequest;
  const group = { name: "threads", description: "Preview and apply thread selections" };
  const previewLeaf = new SlashCommandSubcommandBuilder().setName("preview").setDescription("Preview a bulk thread change")
    .addStringOption(o => o.setName("scope").setDescription("Scope").setRequired(true).addChoices({ name: "All managed guilds", value: "all" }, { name: "Guild", value: "guild" }, { name: "Channel", value: "channel" }))
    .addStringOption(o => o.setName("target-model").setDescription("New model").setRequired(true));
  for (const field of fields.filter(f => f !== "scope" && f !== "target-model")) previewLeaf.addStringOption(o => o.setName(field).setDescription(field === "preset" ? "Last applied preset ID" : field === "preset-scope" ? "Preset project ID (omit for global)" : field));
  const idLeaf = (name: string) => new SlashCommandSubcommandBuilder().setName(name).setDescription(name === "apply" ? "Apply an exact preview" : "Read the complete preview/result")
    .addStringOption(o => o.setName("id").setDescription("Preview ID").setRequired(true));
  const pageLeaf = idLeaf("page").addStringOption(o => o.setName("page").setDescription("Page number (starts at 1)"));
  const properties = Object.fromEntries(keys.map(k => [k, { type: "string" }]));
  const result = (plan: SavedPlan, index = 0) => ({ content: [{ type: "text" as const, text: `${pages(plan)[index] ?? "No such page"}\nPreview ID ${plan.id}; ${pages(plan).length} pages. Use thread_reconfiguration_page for every page.` }], structuredContent: { id: plan.id, pages: pages(plan).length, page: index + 1 } });
  return { id: "thread-reconfigure", apiVersion: 1, builtin: true, internal: true,
    activate: context => { file = context.storage?.path("previews.json"); if (file && fs.existsSync(file)) for (const plan of JSON.parse(fs.readFileSync(file, "utf8")) as SavedPlan[]) plans.set(plan.id, plan); },
    contributions: {
      slash: [
        { command: "seamadmin", group, leaf: previewLeaf.toJSON(), access: { kind: "read-only" }, authorization: "config-admin", acknowledgement: "ephemeral", help: "`/seamadmin threads preview` — preview exact bulk thread changes", handle: async i => i.reply(page(await preview(i.actor, i.threadId, requestFrom(i.string)))) },
        { command: "seamadmin", group, leaf: idLeaf("apply").toJSON(), access: { kind: "mutating" }, authorization: "config-admin", acknowledgement: "ephemeral", help: "`/seamadmin threads apply id:` — apply the preview, skipping busy or changed targets", handle: async i => i.reply(page(await apply(get(i.string("id")!, i.actor, i.threadId), i.actor))) },
        { command: "seamadmin", group, leaf: pageLeaf.toJSON(), access: { kind: "read-only" }, authorization: "config-admin", acknowledgement: "ephemeral", help: "`/seamadmin threads page id: page:` — read every preview/result row", handle: async i => i.reply(page(get(i.string("id")!, i.actor, i.threadId), Number(i.string("page") ?? 1) - 1)) },
      ],
      mcp: [
        { descriptor: { name: "preview_thread_reconfiguration", description: "Preview exact thread changes across managed guilds, a guild or a channel. Read every page before applying. Busy threads are skipped; agent changes reset context. Preset filters mean last explicit application, not subscriptions.", inputSchema: { type: "object", properties, required: ["scope", "targetModel"] } }, access: "read-only", authorization: "config-admin", available: () => true, instruction: "- preview_thread_reconfiguration: read-only bulk model/agent preview; read every page before apply.", handle: async i => result(await preview(actorRequired(i.actor), i.threadId, i.args as unknown as BulkRequest)) },
        { descriptor: { name: "thread_reconfiguration_page", description: "Read one complete preview/result page.", inputSchema: { type: "object", properties: { id: { type: "string" }, page: { type: "integer", minimum: 1 } }, required: ["id"] } }, access: "read-only", authorization: "config-admin", available: () => true, instruction: "- thread_reconfiguration_page(id,page): inspect all matches, changes, skips and results.", handle: async i => result(get(String(i.args.id), actorRequired(i.actor), i.threadId), Number(i.args.page ?? 1) - 1) },
        { descriptor: { name: "apply_thread_reconfiguration", description: "Apply only an exact previously previewed thread set. Preserves busy work and reports per-thread results. Does not change defaults or named presets.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }, access: "mutating", authorization: "config-admin", available: () => true, instruction: "- apply_thread_reconfiguration(id): apply the frozen preview and inspect result pages; no automatic context migration.", handle: async i => result(await apply(get(String(i.args.id), actorRequired(i.actor), i.threadId), actorRequired(i.actor))) },
      ],
      components: [{ namespace: ns, types: ["button"], lifetime: "persistent", authorization: "config-admin", access: id => id.startsWith(`${ns}apply:`) ? "mutating" : "read-only", acknowledgement: "update", handle: async e => {
        const [, action, id, encoded] = e.customId.split(":");
        const actor = { id: e.userId, name: e.userId }; const plan = get(id!, actor, e.channel.id);
        try { const view = page(action === "apply" ? await apply(plan, actor) : plan, Number(encoded) + (action === "prev" ? -1 : action === "next" ? 1 : 0));
          await e.updateEphemeralView(view); }
        catch (error) { await e.replyEphemeral(errorText(error)); }
      } }],
    } };
}
