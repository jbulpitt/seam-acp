/**
 * `/seamadmin bridge` slash group (PR3 / #86). Pairing UX lives here so
 * orchestrator.ts only has a thin switch.
 */
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { hashBridgeToken, mintBridgeToken } from "../../core/bridge-pairing.js";
import type { ConfigMutationService, MutationActor } from "../../core/config-mutation.js";
import type { BridgeHub } from "../../core/bridge-hub.js";
import type { Logger } from "../../lib/logger.js";
import type { Config } from "../../config.js";

export interface BridgeSlashDeps {
  config: Config;
  mutation: ConfigMutationService;
  hub?: BridgeHub;
  logger: Logger;
  publicWsUrl: string;
}

function actorOf(i: ChatInputCommandInteraction): MutationActor {
  return { id: i.user.id, name: i.user.displayName ?? i.user.username };
}

function resolveBridgeId(deps: BridgeSlashDeps, name: string): string | undefined {
  const slug = name.trim();
  if (deps.config.bridgePresets.has(slug)) return slug;
  for (const [id, b] of deps.config.bridgePresets) {
    if (b.shortName === slug) return id;
  }
  return undefined;
}

function bootstrapLine(url: string, bridgeId: string, token: string): string {
  return `seam-bridge connect --server ${url} --id ${bridgeId} --token ${token}`;
}

export async function handleBridgeSlash(
  interaction: ChatInputCommandInteraction,
  deps: BridgeSlashDeps
): Promise<void> {
  const sub = interaction.options.getSubcommand(true);
  switch (sub) {
    case "add":
      return cmdAdd(interaction, deps);
    case "rotate":
      return cmdRotate(interaction, deps);
    case "list":
      return cmdList(interaction, deps);
    case "remove":
      return cmdRemove(interaction, deps);
    default:
      await interaction.reply({
        content: `Unknown /seamadmin bridge subcommand: ${sub}`,
        flags: MessageFlags.Ephemeral,
      });
  }
}

async function cmdAdd(
  i: ChatInputCommandInteraction,
  deps: BridgeSlashDeps
): Promise<void> {
  const name = i.options.getString("name", true);
  const emoji = i.options.getString("emoji") ?? undefined;
  const shortName = i.options.getString("short-name") ?? undefined;
  const workspaceRoot = i.options.getString("workspace-root") ?? undefined;
  const url = i.options.getString("url") ?? undefined;
  const token = mintBridgeToken();
  const result = deps.mutation.applyBridgePair({
    name,
    tokenHash: hashBridgeToken(token),
    emoji,
    shortName,
    workspaceRoot,
    url,
    actor: actorOf(i),
  });
  if (!result.ok) {
    await i.reply({ content: result.error, flags: MessageFlags.Ephemeral });
    return;
  }
  const wsUrl = url ?? deps.publicWsUrl;
  const line = bootstrapLine(wsUrl, result.bridgeId, token);
  await i.reply({
    content:
      `Paired **${result.bridgeId}**. Token is shown once and is not stored in plaintext.\n\n` +
      `Mac one-liner (installs git/node if needed, clones, starts pm2 — paste the connect line when asked):\n` +
      `\`\`\`\ncurl -fsSL https://raw.githubusercontent.com/jbulpitt/seam-acp/main/scripts/install-macos-bridge.sh | bash\n\`\`\`\n` +
      `Connect line:\n\`\`\`\n${line}\n\`\`\``,
    flags: MessageFlags.Ephemeral,
  });
}

async function cmdRotate(
  i: ChatInputCommandInteraction,
  deps: BridgeSlashDeps
): Promise<void> {
  const name = i.options.getString("name", true);
  const bridgeId = resolveBridgeId(deps, name);
  if (!bridgeId) {
    await i.reply({ content: `No paired bridge named "${name}".`, flags: MessageFlags.Ephemeral });
    return;
  }
  const token = mintBridgeToken();
  const result = deps.mutation.applyBridgeRotate({
    bridgeId,
    tokenHash: hashBridgeToken(token),
    actor: actorOf(i),
  });
  if (!result.ok) {
    await i.reply({ content: result.error, flags: MessageFlags.Ephemeral });
    return;
  }
  const host = deps.config.bridgePresets.get(bridgeId);
  const wsUrl = host?.url ?? deps.publicWsUrl;
  const line = bootstrapLine(wsUrl, bridgeId, token);
  await i.reply({
    content:
      `Rotated token for **${bridgeId}**. Re-bootstrap the host. Mac (skip clone/build, paste this when asked):\n` +
      `\`\`\`\ncurl -fsSL https://raw.githubusercontent.com/jbulpitt/seam-acp/main/scripts/install-macos-bridge.sh | bash -s -- --skip-deps\n\`\`\`\n` +
      `Connect line:\n\`\`\`\n${line}\n\`\`\``,
    flags: MessageFlags.Ephemeral,
  });
}

async function cmdList(
  i: ChatInputCommandInteraction,
  deps: BridgeSlashDeps
): Promise<void> {
  const paired = [...deps.config.bridgePresets.values()];
  if (paired.length === 0) {
    await i.reply({
      content: "No bridges paired. Use `/seamadmin bridge add` (admin).",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const lines = paired.map((b) => {
    const live = deps.hub?.get(b.id);
    const emoji = b.emoji ?? "🖥️";
    const short = b.shortName ?? b.id;
    const conn = live
      ? `connected (${[...live.agents.values()].filter((a) => a.ready).length}/${live.agents.size} ready${live.devMode ? ", dev" : ""})`
      : "offline";
    return `${emoji} **${short}** \`${b.id}\` — ${conn}`;
  });
  await i.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
}

async function cmdRemove(
  i: ChatInputCommandInteraction,
  deps: BridgeSlashDeps
): Promise<void> {
  const name = i.options.getString("name", true);
  const bridgeId = resolveBridgeId(deps, name);
  if (!bridgeId) {
    await i.reply({ content: `No paired bridge named "${name}".`, flags: MessageFlags.Ephemeral });
    return;
  }
  const result = deps.mutation.applyBridgeRemove({ bridgeId, actor: actorOf(i) });
  if (!result.ok) {
    await i.reply({ content: result.error, flags: MessageFlags.Ephemeral });
    return;
  }
  await i.reply({
    content: `Unpaired **${bridgeId}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Adapter `install()` over the bus: recipe only, Discord confirm required,
 * never arbitrary commands from the control plane.
 */
export async function confirmAndInstall(opts: {
  hub: BridgeHub;
  bridgeId: string;
  agentId: string;
  confirmed: boolean;
}): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    const result = await opts.hub.rpc(
      opts.bridgeId,
      "install",
      { confirmed: opts.confirmed },
      opts.agentId
    );
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
