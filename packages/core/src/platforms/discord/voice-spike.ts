/**
 * Live-help spike (docs/agent-guides/live-help.md).
 * Hard-allowlists Jesse's General VC in this guild. Never school channels.
 */
import { spawn } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { OpusEncoder } = require("@discordjs/opus") as {
  OpusEncoder: new (
    rate: number,
    channels: number
  ) => { decode(buf: Buffer): Buffer; encode(buf: Buffer): Buffer };
};
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import { ChannelType, type Client } from "discord.js";
import { liveAudioRoundTrip } from "../../core/audio/gemini-live-spike.js";
import { encodePcmToOggOpus } from "../../core/audio/pcm-to-opus.js";
import { isObfuscatedChannel, visibleDiscordChannelName } from "./channel-visibility.js";

/** Family-guild General voice. Confirmed GUILD_VOICE, parent "Voice Channels". */
export const LIVE_HELP_SPIKE_VOICE_CHANNEL_ID = "1487095870188027987";

export const SPIKE_OGG_RELATIVE = "data/tts-voice-samples/Kore.ogg";

/** Discord's 20ms Opus silence frame. */
export const OPUS_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

const SCHOOL_NAME_RE = /school/i;
const SPEAK_WAIT_MS = 45_000;
const CAPTURE_MAX_MS = 15_000;
const AFTER_SILENCE_MS = 1_200;

export type SpikeVoiceCheck =
  | { ok: true; channelId: string }
  | { ok: false; reason: string };

export function checkSpikeVoiceChannel(input: {
  id: string;
  name?: string | null;
  type?: number | null;
  parentName?: string | null;
  obfuscated?: boolean;
}): SpikeVoiceCheck {
  if (input.id !== LIVE_HELP_SPIKE_VOICE_CHANNEL_ID) {
    return { ok: false, reason: `refused: ${input.id} is not the live-help spike test VC` };
  }
  if (input.obfuscated) {
    return { ok: false, reason: "refused: obfuscated channel" };
  }
  if (input.type != null && input.type !== ChannelType.GuildVoice) {
    return { ok: false, reason: "refused: not a guild voice channel" };
  }
  if (input.name && SCHOOL_NAME_RE.test(input.name)) {
    return { ok: false, reason: "refused: school-named voice channel" };
  }
  if (input.parentName && SCHOOL_NAME_RE.test(input.parentName)) {
    return { ok: false, reason: "refused: school-named parent" };
  }
  return { ok: true, channelId: input.id };
}

export function spikeOggPath(cwd = process.cwd()): string {
  return path.join(cwd, SPIKE_OGG_RELATIVE);
}

export function pcmPeakRatio(pcm: Buffer): number {
  let max = 0;
  for (let i = 0; i + 1 < pcm.byteLength; i += 2) {
    const a = Math.abs(pcm.readInt16LE(i));
    if (a > max) max = a;
  }
  return max / 32768;
}

type SpikeJoin =
  | { ok: true; connection: VoiceConnection; channelName: string }
  | { ok: false; reason: string };

async function joinSpikeVoice(
  client: Client,
  opts: { selfDeaf: boolean; selfMute: boolean }
): Promise<SpikeJoin> {
  const channelId = LIVE_HELP_SPIKE_VOICE_CHANNEL_ID;
  const pre = checkSpikeVoiceChannel({ id: channelId });
  if (!pre.ok) return pre;

  const ch = await client.channels.fetch(channelId);
  if (!ch || !("isVoiceBased" in ch) || !ch.isVoiceBased()) {
    return { ok: false, reason: "channel not found or not voice" };
  }
  if (isObfuscatedChannel(ch)) {
    return { ok: false, reason: "refused: obfuscated channel" };
  }
  const name = visibleDiscordChannelName(ch);
  let parentName: string | undefined;
  if (ch.parentId) {
    const parent = await client.channels.fetch(ch.parentId).catch(() => null);
    parentName = visibleDiscordChannelName(parent);
  }
  const check = checkSpikeVoiceChannel({
    id: ch.id,
    name,
    type: ch.type,
    parentName,
    obfuscated: isObfuscatedChannel(ch),
  });
  if (!check.ok) return check;

  const connection = joinVoiceChannel({
    channelId: ch.id,
    guildId: ch.guild.id,
    adapterCreator: ch.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
    selfDeaf: opts.selfDeaf,
    selfMute: opts.selfMute,
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    try {
      connection.destroy();
    } catch {
      /* already down */
    }
    return { ok: false, reason: (err as Error).message };
  }
  return { ok: true, connection, channelName: name ?? ch.id };
}

export async function spikePlayOgg(opts: {
  client: Client;
  channelId?: string;
  oggPath?: string;
}): Promise<
  | { ok: true; playedMs: number; channelName: string }
  | { ok: false; reason: string }
> {
  const channelId = opts.channelId ?? LIVE_HELP_SPIKE_VOICE_CHANNEL_ID;
  const oggPath = opts.oggPath ?? spikeOggPath();
  if (!existsSync(oggPath)) {
    return { ok: false, reason: `ogg missing: ${oggPath}` };
  }
  const pre = checkSpikeVoiceChannel({ id: channelId });
  if (!pre.ok) return pre;

  const joined = await joinSpikeVoice(opts.client, { selfDeaf: true, selfMute: false });
  if (!joined.ok) return joined;
  const started = Date.now();
  try {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    const resource = createAudioResource(oggPath);
    joined.connection.subscribe(player);
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Playing, 5_000);
    await entersState(player, AudioPlayerStatus.Idle, 30_000);
    return {
      ok: true,
      playedMs: Date.now() - started,
      channelName: joined.channelName,
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    try {
      joined.connection.destroy();
    } catch {
      /* already torn down */
    }
  }
}

export type SpikeCaptureOk = {
  ok: true;
  userId: string;
  channelName: string;
  pcmBytes: number;
  durationMs: number;
  peakPct: number;
  ogg: Buffer;
};

type CapturedPcm =
  | { ok: true; userId: string; pcm16: Buffer; durationMs: number; peakPct: number }
  | { ok: false; reason: string };

async function captureFromConnection(
  client: Client,
  connection: VoiceConnection,
  preferUserId: string
): Promise<CapturedPcm> {
  const botId = client.user?.id;
  const userId = await waitForSpeaker(connection, {
    botId,
    preferUserId,
    timeoutMs: SPEAK_WAIT_MS,
  });
  const packets = await collectOpusPackets(connection, userId, CAPTURE_MAX_MS);
  const decoded = decodeOpusPackets(packets);
  if (!decoded.ok) return decoded;
  const pcm16 = await resamplePcm({
    pcm: decoded.pcm,
    inRate: 48_000,
    inChannels: decoded.channels,
    outRate: 16_000,
    outChannels: 1,
  });
  if (!pcm16.ok) return pcm16;

  const tmp = path.join(os.tmpdir(), `seam-live-spike-16k-${Date.now()}.pcm`);
  writeFileSync(tmp, pcm16.pcm);
  try {
    unlinkSync(tmp);
  } catch {
    /* still return the bytes */
  }
  const durationMs = Math.round((pcm16.pcm.byteLength / (16_000 * 2)) * 1000);
  const peakPct = Math.round(pcmPeakRatio(pcm16.pcm) * 100);
  return { ok: true, userId, pcm16: pcm16.pcm, durationMs, peakPct };
}

export async function spikeCapturePcm(opts: {
  client: Client;
  preferUserId: string;
  onListening?: () => void | Promise<void>;
}): Promise<SpikeCaptureOk | { ok: false; reason: string }> {
  const joined = await joinSpikeVoice(opts.client, { selfDeaf: false, selfMute: true });
  if (!joined.ok) return joined;
  const { connection, channelName } = joined;
  try {
    await opts.onListening?.();
    const captured = await captureFromConnection(opts.client, connection, opts.preferUserId);
    if (!captured.ok) return captured;
    const ogg = await encodePcmToOggOpus({
      pcm: captured.pcm16,
      sampleRate: 16_000,
      channels: 1,
    });
    if (!ogg.ok) return { ok: false, reason: `captured pcm but ogg encode failed: ${ogg.error}` };
    return {
      ok: true,
      userId: captured.userId,
      channelName,
      pcmBytes: captured.pcm16.byteLength,
      durationMs: captured.durationMs,
      peakPct: captured.peakPct,
      ogg: Buffer.from(ogg.ogg),
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    try {
      connection.destroy();
    } catch {
      /* already torn down */
    }
  }
}

export type SpikeLiveOk = {
  ok: true;
  userId: string;
  channelName: string;
  captureMs: number;
  capturePeakPct: number;
  replyMs: number;
  playedMs: number;
  inputTranscript: string;
  outputTranscript: string;
  ogg: Buffer;
};

async function playOggBuffer(
  connection: VoiceConnection,
  ogg: Buffer
): Promise<{ ok: true; playedMs: number } | { ok: false; reason: string }> {
  const tmp = path.join(os.tmpdir(), `seam-live-spike-out-${Date.now()}.ogg`);
  writeFileSync(tmp, ogg);
  const started = Date.now();
  try {
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    const resource = createAudioResource(tmp);
    connection.subscribe(player);
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Playing, 5_000);
    await entersState(player, AudioPlayerStatus.Idle, 45_000);
    return { ok: true, playedMs: Date.now() - started };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

export async function spikeLiveRoundTrip(opts: {
  client: Client;
  preferUserId: string;
  apiKey: string;
  onListening?: () => void | Promise<void>;
  onCaptured?: (info: { durationMs: number }) => void | Promise<void>;
}): Promise<SpikeLiveOk | { ok: false; reason: string }> {
  if (!opts.apiKey.trim()) return { ok: false, reason: "no SEAM_GEMINI_API_KEY" };
  const joined = await joinSpikeVoice(opts.client, { selfDeaf: false, selfMute: false });
  if (!joined.ok) return joined;
  const { connection, channelName } = joined;
  try {
    await opts.onListening?.();
    const captured = await captureFromConnection(opts.client, connection, opts.preferUserId);
    if (!captured.ok) return captured;
    await opts.onCaptured?.({ durationMs: captured.durationMs });
    const live = await liveAudioRoundTrip({ apiKey: opts.apiKey, pcm16k: captured.pcm16 });
    if (!live.ok) return live;
    const ogg = await encodePcmToOggOpus({
      pcm: live.pcm24k,
      sampleRate: 24_000,
      channels: 1,
    });
    if (!ogg.ok) return { ok: false, reason: `live pcm but ogg encode failed: ${ogg.error}` };
    const oggBuf = Buffer.from(ogg.ogg);
    const played = await playOggBuffer(connection, oggBuf);
    if (!played.ok) return played;
    const replyMs = Math.round((live.pcm24k.byteLength / (24_000 * 2)) * 1000);
    return {
      ok: true,
      userId: captured.userId,
      channelName,
      captureMs: captured.durationMs,
      capturePeakPct: captured.peakPct,
      replyMs,
      playedMs: played.playedMs,
      inputTranscript: live.inputTranscript,
      outputTranscript: live.outputTranscript,
      ogg: oggBuf,
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  } finally {
    try {
      connection.destroy();
    } catch {
      /* already torn down */
    }
  }
}

function waitForSpeaker(
  connection: VoiceConnection,
  opts: { botId?: string; preferUserId: string; timeoutMs: number }
): Promise<string> {
  const speaking = connection.receiver.speaking;
  if (speaking.users.has(opts.preferUserId)) return Promise.resolve(opts.preferUserId);
  return new Promise((resolve, reject) => {
    const onStart = (id: string): void => {
      if (opts.botId && id === opts.botId) return;
      if (id !== opts.preferUserId) return;
      cleanup();
      resolve(id);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("nobody spoke within 45s — unmute and say something in General"));
    }, opts.timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      speaking.off("start", onStart);
    };
    speaking.on("start", onStart);
  });
}

function collectOpusPackets(
  connection: VoiceConnection,
  userId: string,
  maxMs: number
): Promise<Buffer[]> {
  const stream = connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: AFTER_SILENCE_MS },
  });
  const packets: Buffer[] = [];
  return new Promise((resolve, reject) => {
    const cap = setTimeout(() => {
      try {
        stream.push(null);
      } catch {
        stream.destroy();
      }
    }, maxMs);
    stream.on("data", (p: Buffer) => {
      if (Buffer.isBuffer(p) && p.byteLength > 0) packets.push(p);
    });
    stream.once("end", () => {
      clearTimeout(cap);
      resolve(packets);
    });
    stream.once("close", () => {
      clearTimeout(cap);
      resolve(packets);
    });
    stream.once("error", (err) => {
      clearTimeout(cap);
      reject(err);
    });
  });
}

export function decodeOpusPackets(
  packets: Buffer[]
): { ok: true; pcm: Buffer; channels: 1 | 2 } | { ok: false; reason: string } {
  const voiced = packets.filter((p) => p.compare(OPUS_SILENCE_FRAME) !== 0);
  if (voiced.length === 0) {
    return { ok: false, reason: "no voiced opus packets (only silence)" };
  }
  for (const channels of [2, 1] as const) {
    try {
      const decoder = new OpusEncoder(48_000, channels);
      const chunks: Buffer[] = [];
      for (const pkt of voiced) {
        chunks.push(decoder.decode(pkt));
      }
      const pcm = Buffer.concat(chunks);
      if (pcm.byteLength === 0) continue;
      return { ok: true, pcm, channels };
    } catch {
      /* try the other channel count */
    }
  }
  return { ok: false, reason: "opus decode failed (stereo and mono)" };
}

async function resamplePcm(opts: {
  pcm: Buffer;
  inRate: number;
  inChannels: number;
  outRate: number;
  outChannels: number;
}): Promise<{ ok: true; pcm: Buffer } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        String(opts.inRate),
        "-ac",
        String(opts.inChannels),
        "-i",
        "pipe:0",
        "-f",
        "s16le",
        "-ar",
        String(opts.outRate),
        "-ac",
        String(opts.outChannels),
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", (err) => {
      resolve({ ok: false, reason: err.message || "ffmpeg failed to start" });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf8").trim();
        resolve({ ok: false, reason: stderr || `ffmpeg exited ${code ?? "unknown"}` });
        return;
      }
      const pcm = Buffer.concat(chunks);
      if (pcm.byteLength === 0) {
        resolve({ ok: false, reason: "ffmpeg produced no pcm" });
        return;
      }
      resolve({ ok: true, pcm });
    });
    child.stdin.on("error", () => {
      /* EPIPE */
    });
    child.stdin.end(opts.pcm);
  });
}
