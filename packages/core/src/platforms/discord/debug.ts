/**
 * `/seamadmin debug` slash group (PR3 / D7 / #83). Admin-only even when the
 * bridge process has `--dev` / `SEAM_BRIDGE_DEV=1`.
 */
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { ConfigMutationService, MutationActor } from "../../core/config-mutation.js";
import type { BridgeHub } from "../../core/bridge-hub.js";
import type { Logger } from "../../lib/logger.js";

export interface DebugSlashDeps {
  mutation: ConfigMutationService;
  hub?: BridgeHub;
  logger: Logger;
  /** Live-help spike: join test VC, play ogg, leave. Host-side, not a bridge RPC. */
  playSpikeOgg?: () => Promise<string>;
  /** Live-help spike: capture the invoker's Discord Opus → 16 kHz PCM. */
  playSpikeCapture?: (
    userId: string,
    hooks?: { onListening?: () => void | Promise<void> }
  ) => Promise<{ text: string; ogg?: Buffer }>;
  playSpikeLiveRoundTrip?: (
    userId: string,
    hooks?: {
      onListening?: () => void | Promise<void>;
      onCaptured?: (info: { durationMs: number }) => void | Promise<void>;
    }
  ) => Promise<{ text: string; ogg?: Buffer }>;
}

function actorOf(i: ChatInputCommandInteraction): MutationActor {
  return { id: i.user.id, name: i.user.displayName ?? i.user.username };
}

export async function handleDebugSlash(
  interaction: ChatInputCommandInteraction,
  deps: DebugSlashDeps
): Promise<void> {
  const sub = interaction.options.getSubcommand(true);
  switch (sub) {
    case "status":
      return cmdStatus(interaction, deps);
    case "tail":
      return cmdTail(interaction, deps);
    case "exec":
      return cmdExec(interaction, deps);
    case "voice-ping":
      return cmdVoicePing(interaction, deps);
    case "voice-capture":
      return cmdVoiceCapture(interaction, deps);
    case "voice-live":
      return cmdVoiceLive(interaction, deps);
    default:
      await interaction.reply({
        content: `Unknown /seamadmin debug subcommand: ${sub}`,
        flags: MessageFlags.Ephemeral,
      });
  }
}

async function cmdStatus(
  i: ChatInputCommandInteraction,
  deps: DebugSlashDeps
): Promise<void> {
  const wanted = i.options.getString("bridge") ?? undefined;
  const connected = deps.hub?.listConnected() ?? [];
  const rows = wanted ? connected.filter((c) => c.bridgeId === wanted) : connected;
  if (rows.length === 0) {
    await i.reply({
      content: wanted ? `Bridge **${wanted}** is not connected.` : "No bridges connected.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const lines = rows.map((c) => {
    const agents = [...c.agents.entries()]
      .map(([id, s]) => `${id}${s.ready ? " ready" : s.installed ? " installed" : " missing"}`)
      .join(", ");
    return `**${c.bridgeId}** ${c.host.os}/${c.host.arch} dev=${c.devMode ? "on" : "off"} — ${agents || "no agents"}`;
  });
  await i.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
}

async function cmdTail(
  i: ChatInputCommandInteraction,
  deps: DebugSlashDeps
): Promise<void> {
  const bridgeId = i.options.getString("bridge", true);
  const conn = deps.hub?.get(bridgeId);
  if (!conn) {
    await i.reply({ content: `Bridge **${bridgeId}** is not connected.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!conn.devMode) {
    await i.reply({
      content: `Bridge **${bridgeId}** is not in dev mode (\`--dev\` / \`SEAM_BRIDGE_DEV=1\`).`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const logPath = i.options.getString("path") ?? ".";
  const lines = i.options.getInteger("lines") ?? 80;
  deps.mutation.recordBridgeAudit({
    bridgeId,
    action: "debug.tail",
    actor: actorOf(i),
    extra: { path: logPath },
  });
  try {
    const result = (await deps.hub!.rpc(bridgeId, "tailLog", { path: logPath, lines })) as {
      text?: string;
    };
    const body = (result.text ?? "").slice(0, 1800) || "(empty)";
    await i.reply({ content: `\`\`\`\n${body}\n\`\`\``, flags: MessageFlags.Ephemeral });
  } catch (err) {
    await i.reply({
      content: `tail failed: ${(err as Error).message}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function cmdExec(
  i: ChatInputCommandInteraction,
  deps: DebugSlashDeps
): Promise<void> {
  const bridgeId = i.options.getString("bridge", true);
  const command = i.options.getString("command", true);
  const conn = deps.hub?.get(bridgeId);
  if (!conn) {
    await i.reply({ content: `Bridge **${bridgeId}** is not connected.`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!conn.devMode) {
    await i.reply({
      content: `Bridge **${bridgeId}** is not in dev mode (\`--dev\` / \`SEAM_BRIDGE_DEV=1\`). \`SEAM_BRIDGE_DEV=1\` on the control plane does not open this tunnel.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  deps.mutation.recordBridgeAudit({
    bridgeId,
    action: "debug.exec",
    actor: actorOf(i),
    extra: { command: command.slice(0, 200) },
  });
  try {
    const result = (await deps.hub!.rpc(bridgeId, "shell", { command })) as {
      stdout?: string;
      stderr?: string;
    };
    const text = `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`.slice(0, 1800);
    await i.reply({
      content: text.trim() ? `\`\`\`\n${text}\n\`\`\`` : "(no output)",
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    await i.reply({
      content: `exec failed: ${(err as Error).message}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function cmdVoicePing(
  i: ChatInputCommandInteraction,
  deps: DebugSlashDeps
): Promise<void> {
  if (!deps.playSpikeOgg) {
    await i.reply({
      content: "Voice spike is not wired on this adapter.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  deps.logger.info({ userId: i.user.id }, "debug.voice-ping");
  try {
    const text = await deps.playSpikeOgg();
    await i.editReply({ content: text });
  } catch (err) {
    await i.editReply({ content: `voice-ping failed: ${(err as Error).message}` });
  }
}

async function cmdVoiceCapture(
  i: ChatInputCommandInteraction,
  deps: DebugSlashDeps
): Promise<void> {
  if (!deps.playSpikeCapture) {
    await i.reply({
      content: "Voice capture is not wired on this adapter.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  deps.logger.info({ userId: i.user.id }, "debug.voice-capture");
  try {
    const result = await deps.playSpikeCapture(i.user.id, {
      onListening: async () => {
        await i.editReply({
          content: "Listening in **General** — unmute and say something (45s to start, ~15s max clip).",
        });
      },
    });
    await i.editReply({
      content: result.text,
      ...(result.ogg
        ? { files: [{ attachment: result.ogg, name: "capture.ogg" }] }
        : {}),
    });
  } catch (err) {
    await i.editReply({ content: `voice-capture failed: ${(err as Error).message}` });
  }
}

async function cmdVoiceLive(
  i: ChatInputCommandInteraction,
  deps: DebugSlashDeps
): Promise<void> {
  if (!deps.playSpikeLiveRoundTrip) {
    await i.reply({
      content: "Voice live round-trip is not wired on this adapter.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  deps.logger.info({ userId: i.user.id }, "debug.voice-live");
  try {
    const result = await deps.playSpikeLiveRoundTrip(i.user.id, {
      onListening: async () => {
        await i.editReply({
          content: "Listening in **General** — unmute and say something. Gemini will answer in the VC.",
        });
      },
      onCaptured: async (info) => {
        await i.editReply({
          content: `Captured ${info.durationMs}ms. Sending to Gemini Live… stay in **General**.`,
        });
      },
    });
    await i.editReply({
      content: result.text,
      ...(result.ogg ? { files: [{ attachment: result.ogg, name: "live-reply.ogg" }] } : {}),
    });
  } catch (err) {
    await i.editReply({ content: `voice-live failed: ${(err as Error).message}` });
  }
}
