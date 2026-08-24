/**
 * Production live-help duplex: Discord VC ↔ Gemini Live.
 * No wav/pcm on disk. Existing Client only.
 */
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
const require = createRequire(import.meta.url);
const { OpusEncoder } = require("@discordjs/opus") as {
  OpusEncoder: new (
    rate: number,
    channels: number
  ) => { decode(buf: Buffer): Buffer; encode(buf: Buffer): Buffer };
};
import {
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import { ChannelType, type Client, type VoiceBasedChannel } from "discord.js";
import { GeminiLiveSession } from "../../core/audio/gemini-live.js";
import {
  LIVE_HELP_EMPTY_VC_IDLE_MS,
  LIVE_HELP_MAX_MS,
  LIVE_HELP_WAIT_JOIN_MS,
  type LiveHelpSession,
} from "../../core/live-help/types.js";
import { checkLiveHelpVoiceChannel } from "../../core/live-help/voice-policy.js";
import type { Logger } from "../../lib/logger.js";
import { isObfuscatedChannel, visibleDiscordChannelName } from "./channel-visibility.js";
import { OPUS_SILENCE_FRAME } from "./voice-spike.js";

/** Hangover after Discord speaking.end before we tell Gemini the utterance finished. */
const ACTIVITY_END_MS = 1_200;

export function pcm48kStereoTo16kMono(pcm: Buffer): Buffer {
  const stereoFrames = Math.floor(pcm.byteLength / 4);
  const outFrames = Math.floor(stereoFrames / 3);
  const out = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    const src = i * 3;
    const l = pcm.readInt16LE(src * 4);
    const r = pcm.readInt16LE(src * 4 + 2);
    out.writeInt16LE(((l + r) / 2) | 0, i * 2);
  }
  return out;
}

export function pcm24kMonoTo48kStereo(frame960: Buffer): Buffer {
  const samples = Math.floor(frame960.byteLength / 2);
  const out = Buffer.alloc(samples * 2 * 2 * 2);
  for (let i = 0; i < samples; i++) {
    const s = frame960.readInt16LE(i * 2);
    for (const k of [0, 1]) {
      const frame = i * 2 + k;
      out.writeInt16LE(s, frame * 4);
      out.writeInt16LE(s, frame * 4 + 2);
    }
  }
  return out;
}

export function mixMono16(chunks: Buffer[]): Buffer {
  if (chunks.length === 0) return Buffer.alloc(0);
  if (chunks.length === 1) return chunks[0]!;
  const len = Math.max(...chunks.map((c) => c.length));
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i += 2) {
    let sum = 0;
    for (const c of chunks) {
      if (i + 1 < c.length) sum += c.readInt16LE(i);
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), i);
  }
  return out;
}

export async function inspectLiveHelpVoiceChannel(
  client: Client,
  voiceChannelId: string
): Promise<
  | {
      ok: true;
      guildId: string;
      channelName: string;
      type: number;
      parentName?: string;
      obfuscated: boolean;
    }
  | { ok: false; reason: string }
> {
  const pre = checkLiveHelpVoiceChannel({ id: voiceChannelId });
  if (!pre.ok) return pre;
  const ch = await client.channels.fetch(voiceChannelId).catch(() => null);
  if (!ch || !("isVoiceBased" in ch) || !ch.isVoiceBased()) {
    return { ok: false, reason: "channel not found or not voice" };
  }
  const obfuscated = isObfuscatedChannel(ch);
  const name = visibleDiscordChannelName(ch) ?? "";
  let parentName: string | undefined;
  if (ch.parentId) {
    const parent = await client.channels.fetch(ch.parentId).catch(() => null);
    parentName = visibleDiscordChannelName(parent);
  }
  const policy = checkLiveHelpVoiceChannel({
    id: ch.id,
    name,
    type: ch.type,
    parentName,
    obfuscated,
  });
  if (!policy.ok) return policy;
  if (ch.type !== ChannelType.GuildVoice) {
    return { ok: false, reason: "refused: not a guild voice channel" };
  }
  return {
    ok: true,
    guildId: ch.guild.id,
    channelName: name || ch.id,
    type: ch.type,
    ...(parentName ? { parentName } : {}),
    obfuscated,
  };
}

export async function runLiveHelpCall(opts: {
  client: Client;
  apiKey: string;
  row: LiveHelpSession;
  signal: AbortSignal;
  logger: Logger;
  onLive: () => void;
  onTranscript: (side: "input" | "output", text: string) => void;
}): Promise<{ reason: string }> {
  const inspected = await inspectLiveHelpVoiceChannel(opts.client, opts.row.voiceChannelId);
  if (!inspected.ok) return { reason: inspected.reason };

  const existing = getVoiceConnection(inspected.guildId);
  if (existing) {
    return { reason: "bot is already in a voice channel in this guild" };
  }

  const ch = (await opts.client.channels.fetch(opts.row.voiceChannelId)) as VoiceBasedChannel;
  const connection = joinVoiceChannel({
    channelId: ch.id,
    guildId: ch.guild.id,
    adapterCreator: ch.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  let live: GeminiLiveSession | undefined;
  let reason = "ended";
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });
  const encoder = new OpusEncoder(48_000, 2);
  const decoderCache = new Map<number, InstanceType<typeof OpusEncoder>>();
  let playQueue: Buffer[] = [];
  let pcmTail = Buffer.alloc(0);
  let playing = false;
  let playTimer: ReturnType<typeof setInterval> | undefined;
  let playStream: PassThrough | undefined;
  let lastHumanAt = Date.now();
  const subscribed = new Set<string>();
  const pendingMix: Buffer[] = [];

  const interruptPlay = (): void => {
    playQueue = [];
    pcmTail = Buffer.alloc(0);
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = undefined;
    }
    try {
      playStream?.end();
    } catch {
      /* ignore */
    }
    playStream = undefined;
    playing = false;
    try {
      player.stop(true);
    } catch {
      /* ignore */
    }
  };

  const pumpPlay = (): void => {
    if (playing || playQueue.length === 0) return;
    playing = true;
    const stream = new PassThrough({ objectMode: true });
    playStream = stream;
    const resource = createAudioResource(stream, { inputType: StreamType.Opus });
    connection.subscribe(player);
    player.play(resource);
    playTimer = setInterval(() => {
      const pkt = playQueue.shift();
      if (!pkt) {
        if (playTimer) clearInterval(playTimer);
        playTimer = undefined;
        try {
          stream.end();
        } catch {
          /* ignore */
        }
        playing = false;
        playStream = undefined;
        return;
      }
      if (!stream.destroyed) stream.write(pkt);
    }, 20);
  };

  const pushGeminiPcm = (pcm24k: Buffer): void => {
    pcmTail = Buffer.concat([pcmTail, pcm24k]);
    while (pcmTail.byteLength >= 960) {
      const frame = pcmTail.subarray(0, 960);
      pcmTail = pcmTail.subarray(960);
      try {
        playQueue.push(encoder.encode(pcm24kMonoTo48kStereo(frame)));
      } catch {
        /* drop bad frame */
      }
    }
    pumpPlay();
  };

  const decodePacket = (pkt: Buffer): Buffer | null => {
    for (const channels of [2, 1] as const) {
      try {
        let dec = decoderCache.get(channels);
        if (!dec) {
          dec = new OpusEncoder(48_000, channels);
          decoderCache.set(channels, dec);
        }
        const pcm = dec.decode(pkt);
        if (channels === 1) {
          const stereo = Buffer.alloc(pcm.byteLength * 2);
          for (let i = 0; i < pcm.byteLength; i += 2) {
            const s = pcm.readInt16LE(i);
            stereo.writeInt16LE(s, i * 2);
            stereo.writeInt16LE(s, i * 2 + 2);
          }
          return stereo;
        }
        return pcm;
      } catch {
        decoderCache.delete(channels);
      }
    }
    return null;
  };

  let loggedFirstUp = false;
  let loggedFirstDown = false;
  let inActivity = false;
  let activityEndTimer: ReturnType<typeof setTimeout> | undefined;
  let pktCount = 0;
  let voicedCount = 0;
  let silenceCount = 0;
  let decodeFailCount = 0;
  let bytesUp = 0;
  let utteranceBytesUp = 0;

  const beginActivity = (): void => {
    if (activityEndTimer) {
      clearTimeout(activityEndTimer);
      activityEndTimer = undefined;
    }
    if (inActivity) return;
    inActivity = true;
    utteranceBytesUp = 0;
    interruptPlay();
    live?.sendActivityStart();
    opts.logger.info({ liveId: opts.row.id }, "live-help activity start");
  };

  const finishActivity = (): void => {
    activityEndTimer = undefined;
    flushMix();
    if (!inActivity) return;
    live?.sendActivityEnd();
    inActivity = false;
    opts.logger.info(
      {
        liveId: opts.row.id,
        utteranceBytesUp,
        bytesUp,
        pktCount,
        voicedCount,
        silenceCount,
        decodeFailCount,
      },
      "live-help activity end"
    );
  };

  const scheduleActivityEnd = (): void => {
    if (activityEndTimer) clearTimeout(activityEndTimer);
    activityEndTimer = setTimeout(finishActivity, ACTIVITY_END_MS);
  };

  const flushMix = (): void => {
    if (pendingMix.length === 0) return;
    const mixed = mixMono16(pendingMix.splice(0, pendingMix.length));
    if (mixed.byteLength === 0) return;
    beginActivity();
    bytesUp += mixed.byteLength;
    utteranceBytesUp += mixed.byteLength;
    if (!loggedFirstUp) {
      loggedFirstUp = true;
      opts.logger.info(
        { bytes: mixed.byteLength, liveId: opts.row.id },
        "live-help first pcm up to Gemini"
      );
    }
    live?.sendPcm16k(mixed);
  };

  const onStreamGone = (userId: string): void => {
    subscribed.delete(userId);
    if (connection.receiver.speaking.users.has(userId)) {
      subscribeUser(userId);
    }
  };

  const subscribeUser = (userId: string): void => {
    if (userId === opts.client.user?.id) return;
    const existing = connection.receiver.subscriptions.get(userId);
    if (existing && !existing.destroyed && !existing.readableEnded) {
      subscribed.add(userId);
      return;
    }
    if (existing) {
      try {
        existing.destroy();
      } catch {
        /* ignore */
      }
      connection.receiver.subscriptions.delete(userId);
    }
    subscribed.add(userId);
    const stream = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    opts.logger.info({ userId, liveId: opts.row.id }, "live-help subscribed speaker");
    let streamGone = false;
    const goneOnce = (): void => {
      if (streamGone) return;
      streamGone = true;
      onStreamGone(userId);
    };
    stream.on("data", (p: Buffer) => {
      pktCount += 1;
      if (!Buffer.isBuffer(p) || p.byteLength === 0) return;
      if (p.compare(OPUS_SILENCE_FRAME) === 0) {
        silenceCount += 1;
        decodePacket(p);
        return;
      }
      const pcm48 = decodePacket(p);
      if (!pcm48) {
        decodeFailCount += 1;
        if (decodeFailCount === 1 || decodeFailCount % 50 === 0) {
          opts.logger.warn(
            { userId, liveId: opts.row.id, pktLen: p.byteLength, decodeFailCount },
            "live-help opus decode failed"
          );
        }
        return;
      }
      voicedCount += 1;
      lastHumanAt = Date.now();
      pendingMix.push(pcm48kStereoTo16kMono(pcm48));
    });
    stream.once("end", goneOnce);
    stream.once("close", goneOnce);
    stream.once("error", (err: Error) => {
      opts.logger.warn(
        { userId, liveId: opts.row.id, err: err.message },
        "live-help receive stream error"
      );
      goneOnce();
    });
  };

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    if (opts.signal.aborted) {
      reason = "cancelled";
      return { reason };
    }

    const joined = await waitForHumanInVc({
      ch,
      botId: opts.client.user?.id,
      signal: opts.signal,
      timeoutMs: LIVE_HELP_WAIT_JOIN_MS,
    });
    if (opts.signal.aborted) {
      reason = "cancelled";
      return { reason };
    }
    if (!joined) {
      reason = "wait-join-timeout";
      return { reason };
    }
    lastHumanAt = Date.now();

    live = await GeminiLiveSession.connect({
      apiKey: opts.apiKey,
      system: opts.row.system,
      ...(opts.row.historySummary ? { historySummary: opts.row.historySummary } : {}),
      handlers: {
        onAudio: (pcm) => {
          if (!loggedFirstDown) {
            loggedFirstDown = true;
            opts.logger.info(
              { bytes: pcm.byteLength, liveId: opts.row.id },
              "live-help first pcm down from Gemini"
            );
          }
          pushGeminiPcm(pcm);
        },
        onTranscript: (side, text) => {
          opts.logger.info(
            { side, chars: text.length, liveId: opts.row.id },
            "live-help transcript"
          );
          opts.onTranscript(side, text);
        },
        onInterrupted: interruptPlay,
        onGoAway: () => {
          reason = "goaway";
        },
        onClose: (code, closeReason) => {
          opts.logger.warn(
            { code, closeReason, liveId: opts.row.id },
            "live-help gemini ws closed"
          );
        },
      },
    });
    opts.onLive();

    const botId = opts.client.user?.id;
    connection.receiver.speaking.on("start", (userId: string) => {
      if (userId === botId) return;
      subscribeUser(userId);
      beginActivity();
    });
    connection.receiver.speaking.on("end", (userId: string) => {
      if (userId === botId) return;
      opts.logger.info({ userId, liveId: opts.row.id }, "live-help speaking end");
      scheduleActivityEnd();
    });
    for (const id of connection.receiver.speaking.users.keys()) {
      if (id === botId) continue;
      subscribeUser(id);
      beginActivity();
    }

    const mixTimer = setInterval(flushMix, 20);
    const started = Date.now();
    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        reason = "cancelled";
        resolve();
      };
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
      const iv = setInterval(() => {
        if (opts.signal.aborted) {
          reason = "cancelled";
          cleanup();
          resolve();
          return;
        }
        if (Date.now() - started > LIVE_HELP_MAX_MS) {
          reason = "max-duration";
          cleanup();
          resolve();
          return;
        }
        const humans = countHumans(ch, opts.client.user?.id);
        if (humans > 0) lastHumanAt = Date.now();
        if (Date.now() - lastHumanAt > LIVE_HELP_EMPTY_VC_IDLE_MS) {
          reason = "empty-vc";
          cleanup();
          resolve();
          return;
        }
        if (reason === "goaway") {
          cleanup();
          resolve();
        }
      }, 1000);
      const cleanup = (): void => {
        clearInterval(iv);
        opts.signal.removeEventListener("abort", onAbort);
      };
    });
    clearInterval(mixTimer);
    if (activityEndTimer) {
      clearTimeout(activityEndTimer);
      activityEndTimer = undefined;
    }
    finishActivity();
  } catch (err) {
    reason = (err as Error).message || "error";
  } finally {
    if (activityEndTimer) {
      clearTimeout(activityEndTimer);
      activityEndTimer = undefined;
    }
    interruptPlay();
    try {
      player.stop(true);
    } catch {
      /* ignore */
    }
    live?.close();
    try {
      connection.destroy();
    } catch {
      /* already down */
    }
    const leftover = getVoiceConnection(inspected.guildId);
    if (leftover) {
      try {
        leftover.destroy();
      } catch {
        /* ignore */
      }
    }
  }
  return { reason };
}

function countHumans(ch: VoiceBasedChannel, botId?: string): number {
  try {
    const inMembers = ch.members.filter((m) => !m.user.bot && m.id !== botId).size;
    if (inMembers > 0) return inMembers;
    return ch.guild.voiceStates.cache.filter(
      (vs) => vs.channelId === ch.id && vs.id !== botId && !vs.member?.user.bot
    ).size;
  } catch {
    return 0;
  }
}

async function waitForHumanInVc(opts: {
  ch: VoiceBasedChannel;
  botId?: string;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<boolean> {
  if (countHumans(opts.ch, opts.botId) > 0) return true;
  const deadline = Date.now() + opts.timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      if (opts.signal.aborted || countHumans(opts.ch, opts.botId) > 0) {
        cleanup();
        resolve(!opts.signal.aborted);
        return;
      }
      if (Date.now() >= deadline) {
        cleanup();
        resolve(false);
      }
    };
    const iv = setInterval(tick, 400);
    const onAbort = (): void => {
      cleanup();
      resolve(false);
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = (): void => {
      clearInterval(iv);
      opts.signal.removeEventListener("abort", onAbort);
    };
  });
}

export function liveHelpConnectionReady(connection: VoiceConnection): boolean {
  return connection.state.status === VoiceConnectionStatus.Ready;
}
