/**
 * Discord media transport for Thread Voice.
 *
 * This module deliberately owns no durable/session policy and writes no audio
 * to disk. Package D adapts these capture callbacks to Package A/B in
 * `thread-voice-host.ts`.
 */
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type AudioPlayer,
  type DiscordGatewayAdapterCreator,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Client, VoiceBasedChannel, VoiceState } from "discord.js";
import type { TtsPcm } from "../../core/audio/gemini-tts.js";
import type { Logger } from "../../lib/logger.js";

const require = createRequire(import.meta.url);
const { OpusEncoder } = require("@discordjs/opus") as {
  OpusEncoder: new (rate: number, channels: number) => OpusCodec;
};

const PCM_16K_BYTES_PER_SECOND = 16_000 * 2;
const PCM_24K_MONO_FRAME_BYTES = 24_000 * 2 * 0.02;
const DEFAULT_MIN_CAPTURE_BYTES = PCM_16K_BYTES_PER_SECOND * 0.25;
const DEFAULT_MAX_CAPTURE_PART_BYTES = PCM_16K_BYTES_PER_SECOND * 60 * 5;
const DEFAULT_MAX_CAPTURE_PART_MS = 5 * 60 * 1_000;
const DEFAULT_RECONNECT_GRACE_MS = 30_000;
const OPUS_FRAME_MS = 20;

/** Canonical Discord Opus comfort/silence frame. */
export const THREAD_VOICE_OPUS_SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

type OpusCodec = {
  decode(packet: Buffer): Buffer;
  encode(pcm: Buffer): Buffer;
};

export type ThreadVoiceTransportState =
  | "ready"
  | "capturing"
  | "reconnecting"
  | "playback-started"
  | "playback-idle"
  | "ended";

export type ThreadVoiceCaptureRef = {
  sequence: number;
  part: number;
};

export type ThreadVoicePcmChunk = ThreadVoiceCaptureRef & {
  pcm16kMono: Buffer;
  durationMs: number;
};

export type ThreadVoiceCaptureEnd = ThreadVoiceCaptureRef & {
  pcm16kMono: Buffer;
  durationMs: number;
  reason: "mute" | "limit" | "disconnect" | "stop";
  continuation: boolean;
  usable: boolean;
};

export type ThreadVoiceCaptureCallbacks = {
  onCaptureStart: (capture: ThreadVoiceCaptureRef) => void;
  onPcm: (chunk: ThreadVoicePcmChunk) => void;
  onCaptureEnd: (capture: ThreadVoiceCaptureEnd) => void;
  /** PCM made available to Package B; not proof that Google accepted bytes. */
  onForwardablePcm?: (durationMs: number) => void;
};

/**
 * Pure owner/mute gate used by the Discord receiver.
 *
 * Sequence is assigned on the authoritative owner unmute edge. Five-minute
 * parts retain that sequence and increment `part`, so a transcription layer can
 * concatenate continuation finals without relying on API completion order.
 */
export class ThreadVoiceCaptureGate {
  private readonly ownerUserId: string;
  private readonly callbacks: ThreadVoiceCaptureCallbacks;
  private readonly minCaptureBytes: number;
  private readonly maxCapturePartBytes: number;
  private readonly allocateSequence: () => number;
  private localSequence = 0;
  private logicalSequence: number | undefined;
  private active: ThreadVoiceCaptureRef | undefined;
  private logicalUtterance = false;
  private chunks: Buffer[] = [];
  private bytes = 0;
  private stopped = false;

  constructor(opts: {
    ownerUserId: string;
    callbacks: ThreadVoiceCaptureCallbacks;
    allocateSequence?: () => number;
    minCaptureBytes?: number;
    maxCapturePartBytes?: number;
  }) {
    this.ownerUserId = opts.ownerUserId;
    this.callbacks = opts.callbacks;
    this.allocateSequence =
      opts.allocateSequence ??
      (() => {
        this.localSequence += 1;
        return this.localSequence;
      });
    this.minCaptureBytes = evenPositive(
      opts.minCaptureBytes,
      DEFAULT_MIN_CAPTURE_BYTES
    );
    this.maxCapturePartBytes = Math.max(
      this.minCaptureBytes,
      evenPositive(opts.maxCapturePartBytes, DEFAULT_MAX_CAPTURE_PART_BYTES)
    );
  }

  get capturing(): boolean {
    return this.logicalUtterance && !this.stopped;
  }

  get currentSequence(): number | undefined {
    return this.logicalUtterance ? this.logicalSequence : undefined;
  }

  setSelfMuted(userId: string, selfMuted: boolean): void {
    if (this.stopped || userId !== this.ownerUserId) return;
    if (!selfMuted) {
      if (this.logicalUtterance) return;
      const sequence = this.allocateSequence();
      if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new Error("Thread Voice sequence allocator must return a positive safe integer");
      }
      this.logicalSequence = sequence;
      this.logicalUtterance = true;
      this.startPart(0);
      return;
    }
    if (!this.logicalUtterance) return;
    this.finishPart("mute", false);
    this.logicalUtterance = false;
    this.logicalSequence = undefined;
  }

  pushPcm(userId: string, pcm16kMono: Buffer): boolean {
    if (
      this.stopped ||
      userId !== this.ownerUserId ||
      !this.logicalUtterance ||
      pcm16kMono.byteLength < 2
    ) {
      return false;
    }
    let offset = 0;
    const usableLength = pcm16kMono.byteLength - (pcm16kMono.byteLength % 2);
    while (offset < usableLength) {
      if (!this.active) this.startPart((this.activePartNumber() ?? -1) + 1);
      const capacity = this.maxCapturePartBytes - this.bytes;
      const take = Math.min(capacity, usableLength - offset);
      const pcm = Buffer.from(pcm16kMono.subarray(offset, offset + take));
      this.chunks.push(pcm);
      this.bytes += pcm.byteLength;
      const ref = this.active!;
      const durationMs = pcmBytesToMs(pcm.byteLength);
      this.callbacks.onPcm({ ...ref, pcm16kMono: pcm, durationMs });
      this.callbacks.onForwardablePcm?.(durationMs);
      offset += take;
      if (this.bytes >= this.maxCapturePartBytes) {
        const part = ref.part;
        this.finishPart("limit", true);
        // Start the successor even when this push ended exactly on the part
        // boundary. A following mute must still emit a terminal
        // continuation:false marker for the logical utterance.
        this.startPart(part + 1);
      }
    }
    return true;
  }

  ownerDisconnected(): void {
    if (this.stopped || !this.logicalUtterance) return;
    this.finishPart("disconnect", false);
    this.logicalUtterance = false;
    this.logicalSequence = undefined;
  }

  /** Finalize one wall-clock-limited part and continue the same utterance. */
  rollover(): void {
    if (this.stopped || !this.logicalUtterance || !this.active) return;
    const nextPart = this.active.part + 1;
    this.finishPart("limit", true);
    this.startPart(nextPart);
  }

  stop(): void {
    if (this.stopped) return;
    if (this.logicalUtterance) {
      this.finishPart("stop", false, false);
      this.logicalUtterance = false;
      this.logicalSequence = undefined;
    }
    this.stopped = true;
    this.chunks = [];
    this.bytes = 0;
    this.active = undefined;
  }

  private lastPart = -1;

  private activePartNumber(): number | undefined {
    return this.active?.part ?? (this.lastPart >= 0 ? this.lastPart : undefined);
  }

  private startPart(part: number): void {
    if (this.logicalSequence === undefined) {
      throw new Error("Thread Voice cannot start a capture part without a sequence");
    }
    const ref = { sequence: this.logicalSequence, part };
    this.active = ref;
    this.lastPart = part;
    this.chunks = [];
    this.bytes = 0;
    this.callbacks.onCaptureStart(ref);
  }

  private finishPart(
    reason: ThreadVoiceCaptureEnd["reason"],
    continuation: boolean,
    allowUsable = true
  ): void {
    const ref = this.active;
    if (!ref) return;
    const pcm = Buffer.concat(this.chunks, this.bytes);
    this.callbacks.onCaptureEnd({
      ...ref,
      pcm16kMono: pcm,
      durationMs: pcmBytesToMs(this.bytes),
      reason,
      continuation,
      usable: allowUsable && this.bytes >= this.minCaptureBytes,
    });
    this.active = undefined;
    this.chunks = [];
    this.bytes = 0;
  }
}

export type ThreadVoiceCallOptions = {
  client: Client;
  guildId: string;
  voiceChannelId: string;
  ownerUserId: string;
  signal: AbortSignal;
  logger: Logger;
  callbacks: ThreadVoiceCaptureCallbacks & {
    onState?: (state: ThreadVoiceTransportState) => void;
  };
  reconnectGraceMs?: number;
  minCaptureBytes?: number;
  maxCapturePartBytes?: number;
  /** Production injects Package A's durable per-session allocator. */
  allocateSequence?: () => number;
  /** Test seam and temporary Package D integration boundary. */
  dependencies?: ThreadVoiceCallDependencies;
};

export type ThreadVoiceCallDependencies = {
  getExistingVoiceConnection: (guildId: string) => VoiceConnection | undefined;
  join: (options: Parameters<typeof joinVoiceChannel>[0]) => VoiceConnection;
  waitUntilReady: (connection: VoiceConnection, timeoutMs: number) => Promise<void>;
  playback?: PlaybackDependencies;
};

const DEFAULT_CALL_DEPENDENCIES: ThreadVoiceCallDependencies = {
  getExistingVoiceConnection: getVoiceConnection,
  join: joinVoiceChannel,
  waitUntilReady: async (connection, timeoutMs) => {
    await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
  },
};

export class DiscordThreadVoiceCall {
  readonly done: Promise<{ reason: string }>;

  private readonly opts: ThreadVoiceCallOptions;
  private readonly channel: VoiceBasedChannel;
  private readonly connection: VoiceConnection;
  private readonly capture: ThreadVoiceCaptureGate;
  private readonly decoder = new DiscordOpusDecoder();
  private readonly playback: ThreadVoicePlaybackQueue;
  private resolveDone!: (result: { reason: string }) => void;
  private receiveStream: ReturnType<VoiceConnection["receiver"]["subscribe"]> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private captureRolloverTimer: ReturnType<typeof setTimeout> | undefined;
  private awaitingMuteAfterReconnect = false;
  private destroyed = false;

  private constructor(
    opts: ThreadVoiceCallOptions,
    channel: VoiceBasedChannel,
    connection: VoiceConnection
  ) {
    this.opts = opts;
    this.channel = channel;
    this.connection = connection;
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    this.capture = new ThreadVoiceCaptureGate({
      ownerUserId: opts.ownerUserId,
      ...(opts.allocateSequence ? { allocateSequence: opts.allocateSequence } : {}),
      callbacks: {
        onCaptureStart: (capture) => {
          this.scheduleCaptureRollover();
          opts.callbacks.onState?.("capturing");
          opts.callbacks.onCaptureStart(capture);
        },
        onPcm: opts.callbacks.onPcm,
        onCaptureEnd: (capture) => {
          if (!capture.continuation) this.clearCaptureRollover();
          opts.callbacks.onCaptureEnd(capture);
          if (!capture.continuation && !this.destroyed) opts.callbacks.onState?.("ready");
        },
        ...(opts.callbacks.onForwardablePcm
          ? { onForwardablePcm: opts.callbacks.onForwardablePcm }
          : {}),
      },
      ...(opts.minCaptureBytes !== undefined
        ? { minCaptureBytes: opts.minCaptureBytes }
        : {}),
      ...(opts.maxCapturePartBytes !== undefined
        ? { maxCapturePartBytes: opts.maxCapturePartBytes }
        : {}),
    });
    this.playback = new ThreadVoicePlaybackQueue({
      connection,
      logger: opts.logger,
      onPlaybackStarted: () => opts.callbacks.onState?.("playback-started"),
      onPlaybackIdle: () => opts.callbacks.onState?.("playback-idle"),
      ...(opts.dependencies?.playback
        ? { dependencies: opts.dependencies.playback }
        : {}),
    });
  }

  static async connect(opts: ThreadVoiceCallOptions): Promise<DiscordThreadVoiceCall> {
    const dependencies = opts.dependencies ?? DEFAULT_CALL_DEPENDENCIES;
    if (opts.signal.aborted) throw new Error("Thread Voice start was cancelled");
    const fetched = await opts.client.channels.fetch(opts.voiceChannelId).catch(() => null);
    if (!fetched || !("isVoiceBased" in fetched) || !fetched.isVoiceBased()) {
      throw new Error("Thread Voice channel was not found or is not voice-based");
    }
    if (fetched.guild.id !== opts.guildId) {
      throw new Error("Thread Voice owner and voice channel must be in the same guild");
    }
    const ownerState = fetched.guild.voiceStates.cache.get(opts.ownerUserId);
    if (!ownerState || ownerState.channelId !== fetched.id) {
      throw new Error("Thread Voice owner is not in the target voice channel");
    }
    if (ownerState.selfMute !== true) {
      throw new Error("Thread Voice owner must self-mute before starting");
    }
    if (dependencies.getExistingVoiceConnection(opts.guildId)) {
      throw new Error("Discord already has a voice connection in this guild");
    }

    const channel = fetched as VoiceBasedChannel;
    const connection = dependencies.join({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    try {
      await dependencies.waitUntilReady(connection, 20_000);
      if (opts.signal.aborted) throw new Error("Thread Voice start was cancelled");
      const call = new DiscordThreadVoiceCall(opts, channel, connection);
      call.attach();
      return call;
    } catch (error) {
      try {
        connection.destroy();
      } catch {
        // Connection may already be destroyed by the voice library.
      }
      throw error;
    }
  }

  enqueueTtsPcm(pcm: TtsPcm): void {
    if (this.destroyed) throw new Error("Thread Voice call has ended");
    this.playback.enqueue(pcm);
  }

  waitForPlaybackIdle(): Promise<void> {
    return this.playback.waitForIdle();
  }

  stopPlayback(): void {
    this.playback.stopAndClear();
  }

  async destroy(reason = "ended"): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearCaptureRollover();
    this.opts.signal.removeEventListener("abort", this.onAbort);
    this.opts.client.off("voiceStateUpdate", this.onVoiceStateUpdate);
    this.connection.receiver.speaking.off("start", this.onSpeakingStart);
    this.connection.receiver.speaking.off("end", this.onSpeakingEnd);
    this.connection.off("stateChange", this.onConnectionStateChange);
    this.capture.stop();
    this.destroyReceiveStream();
    this.playback.destroy();
    try {
      this.connection.destroy();
    } catch {
      // Already destroyed/disconnected.
    }
    this.opts.callbacks.onState?.("ended");
    this.resolveDone({ reason });
  }

  private attach(): void {
    this.opts.signal.addEventListener("abort", this.onAbort, { once: true });
    this.opts.client.on("voiceStateUpdate", this.onVoiceStateUpdate);
    this.connection.receiver.speaking.on("start", this.onSpeakingStart);
    this.connection.receiver.speaking.on("end", this.onSpeakingEnd);
    this.connection.on("stateChange", this.onConnectionStateChange);
    this.opts.callbacks.onState?.("ready");
  }

  private readonly onAbort = (): void => {
    void this.destroy("cancelled");
  };

  private readonly onConnectionStateChange = (
    _oldState: { status: string },
    newState: { status: string }
  ): void => {
    if (!this.destroyed && newState.status === VoiceConnectionStatus.Destroyed) {
      void this.destroy("voice-connection-lost");
    }
  };

  private readonly onVoiceStateUpdate = (oldState: VoiceState, newState: VoiceState): void => {
    if (this.destroyed || newState.id !== this.opts.ownerUserId) return;
    const wasHere = oldState.channelId === this.channel.id;
    const isHere = newState.channelId === this.channel.id;

    if (wasHere && !isHere) {
      this.capture.ownerDisconnected();
      this.destroyReceiveStream();
      this.awaitingMuteAfterReconnect = true;
      this.opts.callbacks.onState?.("reconnecting");
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        void this.destroy("owner-reconnect-timeout");
      }, this.opts.reconnectGraceMs ?? DEFAULT_RECONNECT_GRACE_MS);
      return;
    }

    if (!wasHere && isHere) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
      }
      this.awaitingMuteAfterReconnect = newState.selfMute !== true;
      this.opts.callbacks.onState?.("ready");
      return;
    }

    if (!isHere || oldState.selfMute === newState.selfMute) return;
    if (newState.selfMute === true) {
      this.awaitingMuteAfterReconnect = false;
      this.capture.setSelfMuted(this.opts.ownerUserId, true);
      return;
    }
    if (newState.selfMute === false && !this.awaitingMuteAfterReconnect) {
      this.capture.setSelfMuted(this.opts.ownerUserId, false);
      if (this.connection.receiver.speaking.users.has(this.opts.ownerUserId)) {
        this.ensureOwnerSubscription();
      }
    }
  };

  private readonly onSpeakingStart = (userId: string): void => {
    if (this.destroyed || userId !== this.opts.ownerUserId || !this.capture.capturing) return;
    this.ensureOwnerSubscription();
  };

  private readonly onSpeakingEnd = (_userId: string): void => {
    // Discord speaking is audio availability only. Self-mute remains the sole
    // utterance boundary, so speaking.end intentionally does nothing.
  };

  private ensureOwnerSubscription(): void {
    if (this.receiveStream && !this.receiveStream.destroyed && !this.receiveStream.readableEnded) {
      return;
    }
    this.destroyReceiveStream();
    const stream = this.connection.receiver.subscribe(this.opts.ownerUserId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    this.receiveStream = stream;
    stream.on("data", (packet: Buffer) => this.receivePacket(packet));
    const clear = (): void => {
      if (this.receiveStream === stream) this.receiveStream = undefined;
      if (this.connection.receiver.subscriptions.get(this.opts.ownerUserId) === stream) {
        this.connection.receiver.subscriptions.delete(this.opts.ownerUserId);
      }
    };
    stream.once("error", (error: Error) => {
      this.opts.logger.warn(
        { error: error.message, ownerUserId: this.opts.ownerUserId },
        "thread-voice receive stream error"
      );
      clear();
    });
    stream.once("close", clear);
    stream.once("end", clear);
  }

  private receivePacket(packet: Buffer): void {
    if (
      this.destroyed ||
      !this.capture.capturing ||
      !Buffer.isBuffer(packet) ||
      packet.byteLength === 0
    ) {
      return;
    }
    if (packet.equals(THREAD_VOICE_OPUS_SILENCE_FRAME)) {
      this.decoder.decode(packet);
      return;
    }
    const decoded = this.decoder.decode(packet);
    if (!decoded) {
      this.opts.logger.warn(
        { ownerUserId: this.opts.ownerUserId, packetBytes: packet.byteLength },
        "thread-voice Opus decode failed"
      );
      return;
    }
    const pcm16 = pcm48kTo16kMono(decoded.pcm48k, decoded.channels);
    if (!hasNonZeroPcm(pcm16)) return;
    this.capture.pushPcm(this.opts.ownerUserId, pcm16);
  }

  private destroyReceiveStream(): void {
    const stream = this.receiveStream;
    this.receiveStream = undefined;
    if (!stream) return;
    try {
      stream.destroy();
    } catch {
      // Already ended.
    }
    this.connection.receiver.subscriptions.delete(this.opts.ownerUserId);
  }

  private scheduleCaptureRollover(): void {
    this.clearCaptureRollover();
    this.captureRolloverTimer = setTimeout(() => {
      this.captureRolloverTimer = undefined;
      this.capture.rollover();
    }, DEFAULT_MAX_CAPTURE_PART_MS);
  }

  private clearCaptureRollover(): void {
    if (!this.captureRolloverTimer) return;
    clearTimeout(this.captureRolloverTimer);
    this.captureRolloverTimer = undefined;
  }
}

export class DiscordOpusDecoder {
  private readonly decoders = new Map<1 | 2, OpusCodec>();

  decode(packet: Buffer): { pcm48k: Buffer; channels: 1 | 2 } | null {
    for (const channels of [2, 1] as const) {
      try {
        let decoder = this.decoders.get(channels);
        if (!decoder) {
          decoder = new OpusEncoder(48_000, channels);
          this.decoders.set(channels, decoder);
        }
        const pcm48k = decoder.decode(packet);
        if (pcm48k.byteLength > 0) return { pcm48k, channels };
      } catch {
        this.decoders.delete(channels);
      }
    }
    return null;
  }
}

export function pcm48kTo16kMono(pcm48k: Buffer, channels: 1 | 2): Buffer {
  const bytesPerInputFrame = channels * 2;
  const inputFrames = Math.floor(pcm48k.byteLength / bytesPerInputFrame);
  const outputFrames = Math.floor(inputFrames / 3);
  const out = Buffer.alloc(outputFrames * 2);
  for (let i = 0; i < outputFrames; i++) {
    const sourceOffset = i * 3 * bytesPerInputFrame;
    if (channels === 1) {
      out.writeInt16LE(pcm48k.readInt16LE(sourceOffset), i * 2);
    } else {
      const left = pcm48k.readInt16LE(sourceOffset);
      const right = pcm48k.readInt16LE(sourceOffset + 2);
      out.writeInt16LE(Math.trunc((left + right) / 2), i * 2);
    }
  }
  return out;
}

export function pcm24kMonoTo48kStereo(pcm24kMono: Buffer): Buffer {
  const samples = Math.floor(pcm24kMono.byteLength / 2);
  const out = Buffer.alloc(samples * 2 * 4);
  for (let i = 0; i < samples; i++) {
    const sample = pcm24kMono.readInt16LE(i * 2);
    for (let duplicate = 0; duplicate < 2; duplicate++) {
      const frameOffset = (i * 2 + duplicate) * 4;
      out.writeInt16LE(sample, frameOffset);
      out.writeInt16LE(sample, frameOffset + 2);
    }
  }
  return out;
}

export type PlaybackDependencies = {
  createPlayer: typeof createAudioPlayer;
  createResource: typeof createAudioResource;
  createEncoder: () => OpusCodec;
};

const DEFAULT_PLAYBACK_DEPENDENCIES: PlaybackDependencies = {
  createPlayer: createAudioPlayer,
  createResource: createAudioResource,
  createEncoder: () => new OpusEncoder(48_000, 2),
};

// Keepalive SSE bytes can reset the read-idle watchdog without carrying audio,
// so an audio-delta gap can last until the 180s overall provider deadline.
// Discord's default (5 missed 20ms frames) tears a resource down after ~100ms;
// 10,000 frames keeps the one persistent resource alive beyond that deadline.
const STREAMING_MAX_MISSED_FRAMES = 10_000;

/** Ordered 24 kHz mono PCM -> Discord Opus queue with a reusable player. */
export class ThreadVoicePlaybackQueue {
  private readonly player: AudioPlayer;
  private readonly encoder: OpusCodec;
  private readonly connection: Pick<VoiceConnection, "subscribe">;
  private subscription: ReturnType<VoiceConnection["subscribe"]>;
  private readonly logger: Logger;
  private readonly onPlaybackStarted?: () => void;
  private readonly onPlaybackIdle?: () => void;
  private readonly createResource: typeof createAudioResource;
  private readonly packets: Buffer[] = [];
  private pcmTail = Buffer.alloc(0);
  private stream: PassThrough | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cycleActive = false;
  private endingStream = false;
  private streamingProducerOpen = false;
  private destroyed = false;
  private lastPlaybackError: string | undefined;
  private consumedAudioMsTotal = 0;
  private idleWaiters: Array<() => void> = [];
  private capacityWaiters: Array<{ maxBufferedMs: number; resolve: () => void }> = [];

  constructor(opts: {
    connection: Pick<VoiceConnection, "subscribe">;
    logger: Logger;
    onPlaybackStarted?: () => void;
    onPlaybackIdle?: () => void;
    dependencies?: PlaybackDependencies;
  }) {
    const dependencies = opts.dependencies ?? DEFAULT_PLAYBACK_DEPENDENCIES;
    this.connection = opts.connection;
    this.logger = opts.logger;
    this.onPlaybackStarted = opts.onPlaybackStarted;
    this.onPlaybackIdle = opts.onPlaybackIdle;
    this.createResource = dependencies.createResource;
    this.encoder = dependencies.createEncoder();
    this.player = dependencies.createPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
        maxMissedFrames: STREAMING_MAX_MISSED_FRAMES,
      },
    });
    this.subscription = this.connection.subscribe(this.player);
    this.player.on("stateChange", (_oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Idle) this.finishCycle();
    });
    this.player.on("error", (error) => {
      this.logger.warn({ error: error.message }, "thread-voice playback error");
      this.lastPlaybackError ??= error.message;
      this.finishCycle();
    });
  }

  enqueue(pcm: TtsPcm): void {
    if (this.destroyed) throw new Error("Thread Voice playback queue has ended");
    if (pcm.sampleRate !== 24_000 || pcm.channels !== 1) {
      throw new Error("Thread Voice playback requires 24 kHz mono PCM");
    }
    const source = Buffer.from(pcm.pcm.buffer, pcm.pcm.byteOffset, pcm.pcm.byteLength);
    if (source.byteLength % 2 !== 0) {
      throw new Error("Thread Voice playback PCM must contain whole int16 samples");
    }
    if (this.isIdle()) this.lastPlaybackError = undefined;
    this.pcmTail = Buffer.concat([this.pcmTail, source]);
    this.encodeCompleteFrames();
    this.pump();
  }

  /** Keep one Discord resource open while network TTS deltas arrive. */
  beginStreaming(): void {
    if (this.destroyed) throw new Error("Thread Voice playback queue has ended");
    if (this.streamingProducerOpen) {
      throw new Error("Thread Voice playback already has a streaming producer");
    }
    if (!this.isIdle()) {
      throw new Error("Thread Voice playback must be idle before streaming begins");
    }
    this.lastPlaybackError = undefined;
    this.streamingProducerOpen = true;
  }

  /** Flush the final partial Opus frame and allow the resource to become idle. */
  endStreaming(): void {
    if (!this.streamingProducerOpen) return;
    this.streamingProducerOpen = false;
    this.flushPcmTail();
    this.pump();
    if (this.cycleActive && !this.timer) this.writeNextPacket();
    if (this.isIdle()) {
      this.onPlaybackIdle?.();
      this.resolveIdleWaiters();
    }
    this.resolveCapacityWaiters();
  }

  bufferedAudioMs(): number {
    return this.packets.length * OPUS_FRAME_MS +
      (this.pcmTail.byteLength / (24_000 * 2)) * 1_000;
  }

  consumedAudioMs(): number {
    return this.consumedAudioMsTotal;
  }

  waitForBufferedAudioBelow(maxBufferedMs: number): Promise<void> {
    if (this.destroyed || this.bufferedAudioMs() <= maxBufferedMs) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.capacityWaiters.push({ maxBufferedMs, resolve });
    });
  }

  waitForIdle(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    this.flushPcmTail();
    this.pump();
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Consume the most recent player error without changing V1 idle semantics. */
  takePlaybackError(): string | undefined {
    const error = this.lastPlaybackError;
    this.lastPlaybackError = undefined;
    return error;
  }

  /** Stop current/queued audio while keeping the player reusable for capture. */
  stopAndClear(): void {
    if (this.destroyed) return;
    this.streamingProducerOpen = false;
    this.packets.splice(0, this.packets.length);
    this.pcmTail = Buffer.alloc(0);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try { this.stream?.destroy(); } catch { /* already closed */ }
    this.stream = undefined;
    this.cycleActive = false;
    this.endingStream = false;
    this.lastPlaybackError = undefined;
    try { this.player.stop(true); } catch { /* already idle */ }
    this.onPlaybackIdle?.();
    this.resolveIdleWaiters();
    this.resolveCapacityWaiters(true);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.packets.splice(0, this.packets.length);
    this.pcmTail = Buffer.alloc(0);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      this.stream?.destroy();
    } catch {
      // Already closed.
    }
    this.stream = undefined;
    this.cycleActive = false;
    this.endingStream = false;
    this.streamingProducerOpen = false;
    this.lastPlaybackError = undefined;
    try {
      this.player.stop(true);
    } catch {
      // Already idle.
    }
    try {
      this.subscription?.unsubscribe();
    } catch {
      // Already unsubscribed with the connection.
    }
    this.subscription = undefined;
    this.resolveIdleWaiters();
    this.resolveCapacityWaiters(true);
  }

  private encodeCompleteFrames(): void {
    while (this.pcmTail.byteLength >= PCM_24K_MONO_FRAME_BYTES) {
      const frame = this.pcmTail.subarray(0, PCM_24K_MONO_FRAME_BYTES);
      this.pcmTail = this.pcmTail.subarray(PCM_24K_MONO_FRAME_BYTES);
      this.packets.push(this.encoder.encode(pcm24kMonoTo48kStereo(frame)));
    }
  }

  private flushPcmTail(): void {
    if (this.pcmTail.byteLength === 0) return;
    const padded = Buffer.alloc(PCM_24K_MONO_FRAME_BYTES);
    this.pcmTail.copy(padded);
    this.pcmTail = Buffer.alloc(0);
    this.packets.push(this.encoder.encode(pcm24kMonoTo48kStereo(padded)));
  }

  private pump(): void {
    if (this.destroyed) return;
    if (this.cycleActive) {
      if (!this.timer && !this.endingStream && this.packets.length > 0) {
        this.writeNextPacket();
      }
      return;
    }
    if (this.packets.length === 0) return;
    this.cycleActive = true;
    this.endingStream = false;
    const stream = new PassThrough({ objectMode: true });
    this.stream = stream;
    const resource = this.createResource(stream, { inputType: StreamType.Opus });
    this.player.play(resource);
    this.onPlaybackStarted?.();
    this.writeNextPacket();
  }

  private writeNextPacket(): void {
    if (this.destroyed || !this.cycleActive) return;
    const packet = this.packets.shift();
    if (packet) {
      if (!this.stream?.destroyed) {
        this.stream?.write(packet);
        this.consumedAudioMsTotal += OPUS_FRAME_MS;
      }
      this.resolveCapacityWaiters();
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.writeNextPacket();
      }, OPUS_FRAME_MS);
      return;
    }
    if (this.streamingProducerOpen) return;
    if (this.endingStream) return;
    this.endingStream = true;
    try {
      this.stream?.end();
    } catch {
      this.finishCycle();
    }
  }

  private finishCycle(): void {
    if (!this.cycleActive) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.cycleActive = false;
    this.endingStream = false;
    this.stream = undefined;
    if (this.packets.length > 0) {
      this.pump();
      return;
    }
    if (this.pcmTail.byteLength === 0 && !this.streamingProducerOpen) {
      this.onPlaybackIdle?.();
      this.resolveIdleWaiters();
    }
    this.resolveCapacityWaiters();
  }

  private isIdle(): boolean {
    return !this.streamingProducerOpen && !this.cycleActive &&
      this.packets.length === 0 && this.pcmTail.byteLength === 0;
  }

  private resolveIdleWaiters(): void {
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const resolve of waiters) resolve();
  }

  private resolveCapacityWaiters(force = false): void {
    const bufferedMs = this.bufferedAudioMs();
    const ready = this.capacityWaiters.filter(
      (waiter) => force || bufferedMs <= waiter.maxBufferedMs
    );
    this.capacityWaiters = this.capacityWaiters.filter(
      (waiter) => !ready.includes(waiter)
    );
    for (const waiter of ready) waiter.resolve();
  }
}

function pcmBytesToMs(bytes: number): number {
  return Math.round((bytes / PCM_16K_BYTES_PER_SECOND) * 1000);
}

function evenPositive(value: number | undefined, fallback: number): number {
  const resolved = Number.isFinite(value) && (value ?? 0) > 0 ? Math.floor(value!) : fallback;
  return resolved - (resolved % 2);
}

function hasNonZeroPcm(pcm: Buffer): boolean {
  for (let offset = 0; offset + 1 < pcm.byteLength; offset += 2) {
    if (pcm.readInt16LE(offset) !== 0) return true;
  }
  return false;
}
