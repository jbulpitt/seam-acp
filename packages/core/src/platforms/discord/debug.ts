/**
 * `/seamadmin debug` slash group (PR3 / D7 / #83). Admin-only.
 */
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import type { BridgeHub } from "../../core/bridge-hub.js";
import type { Logger } from "../../lib/logger.js";

export interface DebugSlashDeps {
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

export async function handleDebugSlash(
  interaction: ChatInputCommandInteraction,
  deps: DebugSlashDeps
): Promise<void> {
  const sub = interaction.options.getSubcommand(true);
  switch (sub) {
    case "status":
      return cmdStatus(interaction, deps);
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
      .map(([id, s]) => {
        const state = s.ready ? "ready" : s.installed ? "installed" : "missing";
        const provenance = s.runtime
          ? ` ${s.runtime.provenance.version}@${s.runtime.provenance.commit?.slice(0, 8) ?? "release"}`
          : "";
        return `${id} ${state}${provenance}`;
      })
      .join(", ");
    return `**${c.bridgeId}** ${c.host.os}/${c.host.arch} — ${agents || "no agents"}`;
  });
  await i.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
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
