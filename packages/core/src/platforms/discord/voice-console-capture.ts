/**
 * Discord receiver host for the Shared Voice Console.
 *
 * One shared Discord receiver is partitioned into user-id keyed runtimes. Each
 * authorized runtime owns one subscription, Opus decoder, continuation gate,
 * and lazy Gemini client. Durable routing remains in capture-router.ts.
 */
import type { Readable } from "node:stream";
import { EndBehaviorType, type VoiceConnection } from "@discordjs/voice";
import type { Client, VoiceState } from "discord.js";
import type { Logger } from "../../lib/logger.js";
import type { GeminiLiveTranscribeResult } from "../../core/audio/gemini-live-transcribe.js";
import {
  VoiceConsoleCaptureRouter,
  type VoiceConsoleArmedCapture,
  type VoiceConsoleCaptureDropReason,
  type VoiceConsoleCapturePersistencePort,
  type VoiceConsoleCaptureRouterCallbacks,
  type VoiceConsoleCaptureSettlement,
} from "../../core/voice-console/capture-router.js";
import {
  ThreadVoiceCaptureCoordinator,
  type ThreadVoiceTranscribePort,
} from "./thread-voice-host.js";
import {
  DiscordOpusDecoder,
  THREAD_VOICE_OPUS_SILENCE_FRAME,
  ThreadVoiceCaptureGate,
  pcm48kTo16kMono,
  type ThreadVoiceCaptureEnd,
  type ThreadVoiceCaptureRef,
} from "./thread-voice-call.js";

const DEFAULT_MAX_CAPTURE_PART_MS = 5 * 60_000;

type Receiver = VoiceConnection["receiver"];
type ReceiveStream = ReturnType<Receiver["subscribe"]>;

export interface VoiceConsoleTranscribePort extends ThreadVoiceTranscribePort {
  close(): void;
}

export interface VoiceConsoleTranscriberHandlers {
  onInterim: (text: string) => void;
  onForwardedBytes: (bytes: number) => void;
}

export type VoiceConsoleTranscriberFactory = (input: {
  speakerId: string;
  handlers: VoiceConsoleTranscriberHandlers;
}) => Promise<VoiceConsoleTranscribePort>;

export interface VoiceConsoleInitialSpeaker {
  userId: string;
  speakerName: string;
  selfMuted: boolean;
  sessionId?: string | null;
}

export interface VoiceConsoleCaptureHostDependencies {
  createDecoder: (userId: string) => {
    decode(packet: Buffer): { pcm48k: Buffer; channels: 1 | 2 } | null;
  };
}

export interface DiscordVoiceConsoleCaptureHostOptions {
  client: Pick<Client, "on" | "off">;
  /** Package E owns this one shared receive/playback connection. */
  connection: VoiceConnection;
  voiceChannelId: string;
  initialSpeakers?: ReadonlyArray<VoiceConsoleInitialSpeaker>;
  persistence: VoiceConsoleCapturePersistencePort;
  isAllowedUser: (userId: string) => boolean;
  createTranscriber: VoiceConsoleTranscriberFactory;
  logger: Logger;
  inputActive?: boolean;
  callbacks?: Pick<
    VoiceConsoleCaptureRouterCallbacks,
    "onInterim" | "onForwardedBytes" | "onSettled" | "onError"
  >;
  minCaptureBytes?: number;
  maxCapturePartBytes?: number;
  maxCapturePartMs?: number;
  now?: () => string;
  dependencies?: VoiceConsoleCaptureHostDependencies;
}

type Presence = VoiceConsoleInitialSpeaker & { sessionId: string | null };

type SpeakerRuntime = {
  userId: string;
  gate: ThreadVoiceCaptureGate;
  coordinator: ThreadVoiceCaptureCoordinator;
  transcriber: LazySpeakerTranscriber;
  decoder: ReturnType<VoiceConsoleCaptureHostDependencies["createDecoder"]>;
  capturesBySequence: Map<number, string>;
  sourcesBySequence: Map<number, "live" | "unary">;
  nextSequence: number;
  pendingCapture?: VoiceConsoleArmedCapture;
  activeCaptureId?: string;
  subscription?: ReceiveStream;
  rolloverTimer?: ReturnType<typeof setTimeout>;
  retired: boolean;
};

class LazySpeakerTranscriber implements VoiceConsoleTranscribePort {
  private readonly create: () => Promise<VoiceConsoleTranscribePort>;
  private instance?: VoiceConsoleTranscribePort;
  private pending?: Promise<VoiceConsoleTranscribePort>;
  private closed = false;

  constructor(create: () => Promise<VoiceConsoleTranscribePort>) {
    this.create = create;
  }

  async startUtterance(): Promise<void> {
    const instance = await this.get();
    await instance.startUtterance();
  }

  sendPcm16k(pcm: Uint8Array): void {
    if (this.closed || !this.instance) return;
    this.instance.sendPcm16k(pcm);
  }

  async finalizeUtterance(pcm: Uint8Array): Promise<GeminiLiveTranscribeResult> {
    const instance = await this.get();
    return instance.finalizeUtterance(pcm);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.instance?.close();
    void this.pending?.then((instance) => instance.close(), () => undefined);
  }

  private async get(): Promise<VoiceConsoleTranscribePort> {
    if (this.closed) throw new Error("voice-console speaker transcriber is closed");
    if (this.instance) return this.instance;
    if (!this.pending) {
      const pending = this.create();
      this.pending = pending;
      void pending.catch(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    }
    const instance = await this.pending;
    if (this.closed) {
      instance.close();
      throw new Error("voice-console speaker transcriber is closed");
    }
    this.instance = instance;
    this.pending = undefined;
    return instance;
  }
}

export class DiscordVoiceConsoleCaptureHost {
  readonly router: VoiceConsoleCaptureRouter;
  /**
   * Borrowed console transport. Package E passes this exact reference to the
   * playback package; this capture host removes listeners but never destroys it.
   */
  readonly sharedConnection: VoiceConnection;

  private readonly opts: DiscordVoiceConsoleCaptureHostOptions;
  private readonly logger: Logger;
  private readonly dependencies: VoiceConsoleCaptureHostDependencies;
  private readonly presence = new Map<string, Presence>();
  private readonly runtimes = new Map<string, SpeakerRuntime>();
  private readonly userSerial = new Map<string, Promise<void>>();
  private readonly settlementPromises = new Set<Promise<VoiceConsoleCaptureSettlement>>();
  private readonly retirementPromises = new Set<Promise<void>>();
  private destroyed = false;

  constructor(opts: DiscordVoiceConsoleCaptureHostOptions) {
    this.opts = opts;
    this.sharedConnection = opts.connection;
    this.logger = opts.logger.child({ comp: "voice-console-capture" });
    this.dependencies = opts.dependencies ?? {
      createDecoder: () => new DiscordOpusDecoder(),
    };
    this.router = new VoiceConsoleCaptureRouter({
      persistence: opts.persistence,
      isAllowedUser: opts.isAllowedUser,
      inputActive: opts.inputActive,
      ...(opts.now ? { now: opts.now } : {}),
      callbacks: {
        onCaptureArmed: (capture) => this.armCapture(capture),
        onCaptureFinalize: (capture) => this.finalizeCapture(capture),
        onCaptureAbort: (capture, reason) => this.abortCapture(capture, reason),
        ...(opts.callbacks?.onInterim ? { onInterim: opts.callbacks.onInterim } : {}),
        ...(opts.callbacks?.onForwardedBytes
          ? { onForwardedBytes: opts.callbacks.onForwardedBytes }
          : {}),
        ...(opts.callbacks?.onSettled ? { onSettled: opts.callbacks.onSettled } : {}),
        onError: (error, context) => {
          this.logger.warn({ error: error.message, context }, "voice-console capture error");
          opts.callbacks?.onError?.(error, context);
        },
      },
    });

    for (const speaker of opts.initialSpeakers ?? []) this.addPresence(speaker);
    opts.client.on("voiceStateUpdate", this.onVoiceStateUpdate);
    opts.connection.receiver.speaking.on("start", this.onSpeakingStart);
    opts.connection.receiver.speaking.on("end", this.onSpeakingEnd);
  }

  async setInputEnabled(enabled: boolean): Promise<void> {
    await this.router.setInputEnabled(enabled);
  }

  /** Reconcile a live config reload without subscribing unauthorized users. */
  async refreshAllowedUsers(): Promise<void> {
    await this.router.refreshAuthorization();
    for (const [userId, present] of this.presence) {
      if (this.opts.isAllowedUser(userId) && !this.router.getLane(userId)) {
        this.router.speakerPresent(present);
      }
      if (!this.opts.isAllowedUser(userId)) this.retireRuntime(userId, "speaker_unauthorized");
    }
  }

  async idle(): Promise<void> {
    await Promise.all([...this.userSerial.values()]);
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.coordinator.idle()));
    while (this.settlementPromises.size > 0 || this.retirementPromises.size > 0) {
      await Promise.all([...this.settlementPromises, ...this.retirementPromises]);
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.opts.client.off("voiceStateUpdate", this.onVoiceStateUpdate);
    this.opts.connection.receiver.speaking.off("start", this.onSpeakingStart);
    this.opts.connection.receiver.speaking.off("end", this.onSpeakingEnd);
    await this.router.close();
    for (const userId of [...this.runtimes.keys()]) this.retireRuntime(userId, "router_closed");
    await this.idle();
    this.presence.clear();
  }

  private addPresence(speaker: VoiceConsoleInitialSpeaker): void {
    const present: Presence = {
      ...speaker,
      sessionId: speaker.sessionId ?? null,
    };
    this.presence.set(speaker.userId, present);
    this.router.speakerPresent(present);
  }

  private readonly onVoiceStateUpdate = (oldState: VoiceState, newState: VoiceState): void => {
    const userId = newState.id;
    this.enqueueUser(userId, async () => {
      if (this.destroyed) return;
      const wasHere = oldState.channelId === this.opts.voiceChannelId;
      const isHere = newState.channelId === this.opts.voiceChannelId;
      if (!wasHere && !isHere) return;

      if (wasHere && !isHere) {
        this.presence.delete(userId);
        this.destroySubscription(userId);
        await this.router.speakerLeft(userId);
        this.retireRuntime(userId, "speaker_left");
        return;
      }

      const present: Presence = {
        userId,
        speakerName: voiceStateDisplayName(newState),
        selfMuted: newState.selfMute === true,
        sessionId: newState.sessionId ?? null,
      };
      this.presence.set(userId, present);
      if (!wasHere && isHere) {
        this.router.speakerPresent(present);
        return;
      }

      const priorSession = oldState.sessionId ?? null;
      if (priorSession !== present.sessionId) {
        this.destroySubscription(userId);
        await this.router.rebindSpeaker({ ...present, continuityProven: false });
        return;
      }
      if (oldState.selfMute !== newState.selfMute) {
        await this.router.setSpeakerMuted({
          userId,
          speakerName: present.speakerName,
          selfMuted: present.selfMuted,
        });
      }
    });
  };

  private readonly onSpeakingStart = (userId: string): void => {
    if (this.destroyed || !this.router.canSubscribe(userId)) return;
    this.ensureSubscription(userId);
  };

  private readonly onSpeakingEnd = (_userId: string): void => {
    // Self-mute edges, never Discord speaking flags, end logical utterances.
  };

  private async armCapture(capture: VoiceConsoleArmedCapture): Promise<void> {
    if (this.destroyed) throw new Error("voice-console capture host is closed");
    const runtime = this.ensureRuntime(capture.speakerId);
    if (runtime.activeCaptureId || runtime.gate.capturing) {
      throw new Error(`speaker ${capture.speakerId} already has an active capture`);
    }
    runtime.pendingCapture = capture;
    runtime.activeCaptureId = capture.captureId;
    try {
      runtime.gate.setSelfMuted(capture.speakerId, false);
    } finally {
      runtime.pendingCapture = undefined;
    }
    if (!runtime.gate.capturing) throw new Error("speaker capture gate did not arm");
    if (this.opts.connection.receiver.speaking.users.has(capture.speakerId)) {
      this.ensureSubscription(capture.speakerId);
    }
  }

  private finalizeCapture(capture: VoiceConsoleArmedCapture): void {
    const runtime = this.runtimes.get(capture.speakerId);
    if (!runtime || runtime.activeCaptureId !== capture.captureId) return;
    this.destroySubscription(capture.speakerId);
    runtime.gate.setSelfMuted(capture.speakerId, true);
  }

  private abortCapture(
    capture: VoiceConsoleArmedCapture,
    reason: VoiceConsoleCaptureDropReason
  ): void {
    const runtime = this.runtimes.get(capture.speakerId);
    if (!runtime || runtime.activeCaptureId !== capture.captureId) return;
    const sequence = runtime.gate.currentSequence;
    if (sequence !== undefined) runtime.coordinator.abortSequence(sequence);
    this.destroySubscription(capture.speakerId);
    this.clearRollover(runtime);
    runtime.transcriber.close();
    runtime.gate.stop();
    runtime.activeCaptureId = undefined;
    this.retireRuntime(capture.speakerId, reason);
  }

  private ensureRuntime(userId: string): SpeakerRuntime {
    const existing = this.runtimes.get(userId);
    if (existing && !existing.retired) return existing;

    let runtime!: SpeakerRuntime;
    const transcriber = new LazySpeakerTranscriber(() =>
      this.opts.createTranscriber({
        speakerId: userId,
        handlers: {
          onInterim: (text) => runtime.coordinator.onInterim(text),
          onForwardedBytes: (bytes) => this.router.recordForwardedBytes(userId, bytes),
        },
      })
    );
    const coordinator = new ThreadVoiceCaptureCoordinator({
      ownerUserId: userId,
      transcribe: transcriber,
      logger: this.logger,
      ...(this.opts.now ? { now: this.opts.now } : {}),
      callbacks: {
        onInterim: (sequence, text) => {
          const captureId = runtime.capturesBySequence.get(sequence);
          if (captureId) this.router.reportInterim(captureId, text);
        },
        onTranscriptionSource: (sequence, source) => {
          runtime.sourcesBySequence.set(sequence, source);
        },
        onFinal: (segment) => {
          const captureId = runtime.capturesBySequence.get(segment.sequence);
          if (!captureId) return;
          this.trackSettlement(
            this.router.settleCapture(captureId, {
              ok: true,
              transcript: segment.transcript,
              audioMs: segment.audioMs,
              capturedEndedUtc: segment.capturedEndedUtc,
              source: runtime.sourcesBySequence.get(segment.sequence) ?? "live",
            }),
            runtime,
            segment.sequence,
            captureId
          );
        },
        onDropped: (segment) => {
          const captureId = runtime.capturesBySequence.get(segment.sequence);
          if (!captureId) return;
          this.trackSettlement(
            this.router.settleCapture(captureId, {
              ok: false,
              reason: segment.state,
              audioMs: segment.audioMs,
              capturedEndedUtc: segment.capturedEndedUtc,
              ...(segment.error ? { error: segment.error } : {}),
            }),
            runtime,
            segment.sequence,
            captureId
          );
        },
        onAudioSent: () => {
          // Gemini onForwardedBytes is the billing authority, not captured PCM.
        },
      },
    });
    runtime = {
      userId,
      coordinator,
      transcriber,
      decoder: this.dependencies.createDecoder(userId),
      capturesBySequence: new Map(),
      sourcesBySequence: new Map(),
      nextSequence: 0,
      retired: false,
      gate: undefined as unknown as ThreadVoiceCaptureGate,
    };
    runtime.gate = new ThreadVoiceCaptureGate({
      ownerUserId: userId,
      allocateSequence: () => {
        runtime.nextSequence += 1;
        const capture = runtime.pendingCapture;
        if (!capture) throw new Error("voice-console capture sequence allocated without snapshot");
        runtime.capturesBySequence.set(runtime.nextSequence, capture.captureId);
        return runtime.nextSequence;
      },
      ...(this.opts.minCaptureBytes !== undefined
        ? { minCaptureBytes: this.opts.minCaptureBytes }
        : {}),
      ...(this.opts.maxCapturePartBytes !== undefined
        ? { maxCapturePartBytes: this.opts.maxCapturePartBytes }
        : {}),
      callbacks: {
        onCaptureStart: (ref) => {
          coordinator.onCaptureStart(ref);
          this.scheduleRollover(runtime);
        },
        onPcm: (chunk) => coordinator.onPcm(chunk),
        onCaptureEnd: (end) => {
          if (!end.continuation) this.clearRollover(runtime);
          coordinator.onCaptureEnd(end);
        },
      },
    });
    this.runtimes.set(userId, runtime);
    return runtime;
  }

  private ensureSubscription(userId: string): void {
    const runtime = this.runtimes.get(userId);
    if (!runtime || runtime.retired || !this.router.canSubscribe(userId)) return;
    const current = runtime.subscription;
    if (current && !current.destroyed && !current.readableEnded) return;
    this.destroySubscription(userId);

    const stream = this.opts.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    runtime.subscription = stream;
    stream.on("data", (packet: Buffer) => this.receivePacket(runtime, stream, packet));
    const clear = (): void => {
      if (runtime.subscription !== stream) return;
      runtime.subscription = undefined;
      runtime.decoder = this.dependencies.createDecoder(userId);
      if (this.opts.connection.receiver.subscriptions.get(userId) === stream) {
        this.opts.connection.receiver.subscriptions.delete(userId);
      }
    };
    stream.once("error", (error: Error) => {
      this.logger.warn(
        { error: error.message, speakerId: userId },
        "voice-console receive stream error"
      );
      clear();
    });
    stream.once("close", clear);
    stream.once("end", clear);
  }

  private receivePacket(runtime: SpeakerRuntime, stream: Readable, packet: Buffer): void {
    if (
      this.destroyed ||
      runtime.retired ||
      runtime.subscription !== stream ||
      !runtime.activeCaptureId ||
      !this.router.canForward(runtime.userId, runtime.activeCaptureId) ||
      !Buffer.isBuffer(packet) ||
      packet.byteLength === 0
    ) {
      if (!this.opts.isAllowedUser(runtime.userId)) {
        this.destroySubscription(runtime.userId);
        void this.router.refreshAuthorization(runtime.userId);
      }
      return;
    }
    if (packet.equals(THREAD_VOICE_OPUS_SILENCE_FRAME)) {
      runtime.decoder.decode(packet);
      return;
    }
    const decoded = runtime.decoder.decode(packet);
    if (!decoded) {
      this.logger.warn(
        { speakerId: runtime.userId, packetBytes: packet.byteLength },
        "voice-console Opus decode failed"
      );
      return;
    }
    const pcm16 = pcm48kTo16kMono(decoded.pcm48k, decoded.channels);
    if (!hasNonZeroPcm(pcm16)) return;
    runtime.gate.pushPcm(runtime.userId, pcm16);
  }

  private destroySubscription(userId: string): void {
    const runtime = this.runtimes.get(userId);
    const stream = runtime?.subscription;
    if (runtime) runtime.subscription = undefined;
    if (stream) {
      try {
        stream.destroy();
      } catch {
        // Already ended.
      }
    }
    this.opts.connection.receiver.subscriptions.delete(userId);
  }

  private retireRuntime(userId: string, _reason: VoiceConsoleCaptureDropReason): void {
    const runtime = this.runtimes.get(userId);
    if (!runtime || runtime.retired) return;
    runtime.retired = true;
    this.destroySubscription(userId);
    this.clearRollover(runtime);
    runtime.transcriber.close();
    runtime.gate.stop();
    this.runtimes.delete(userId);
    const retirement = runtime.coordinator.idle().catch((error) => {
      this.logger.warn(
        { error: errorMessage(error), speakerId: userId },
        "voice-console retired speaker cleanup failed"
      );
    });
    this.retirementPromises.add(retirement);
    void retirement.finally(() => this.retirementPromises.delete(retirement));
  }

  private scheduleRollover(runtime: SpeakerRuntime): void {
    this.clearRollover(runtime);
    runtime.rolloverTimer = setTimeout(() => {
      runtime.rolloverTimer = undefined;
      if (!runtime.retired) runtime.gate.rollover();
    }, this.opts.maxCapturePartMs ?? DEFAULT_MAX_CAPTURE_PART_MS);
  }

  private clearRollover(runtime: SpeakerRuntime): void {
    if (!runtime.rolloverTimer) return;
    clearTimeout(runtime.rolloverTimer);
    runtime.rolloverTimer = undefined;
  }

  private trackSettlement(
    promise: Promise<VoiceConsoleCaptureSettlement>,
    runtime: SpeakerRuntime,
    sequence: number,
    captureId: string
  ): void {
    this.settlementPromises.add(promise);
    void promise.finally(() => {
      this.settlementPromises.delete(promise);
      runtime.capturesBySequence.delete(sequence);
      runtime.sourcesBySequence.delete(sequence);
      if (runtime.activeCaptureId === captureId) runtime.activeCaptureId = undefined;
    });
  }

  private enqueueUser(userId: string, task: () => Promise<void>): void {
    const prior = this.userSerial.get(userId) ?? Promise.resolve();
    const next = prior
      .then(task)
      .catch((error) => {
        this.logger.warn(
          { error: errorMessage(error), speakerId: userId },
          "voice-console speaker state update failed"
        );
      })
      .finally(() => {
        if (this.userSerial.get(userId) === next) this.userSerial.delete(userId);
      });
    this.userSerial.set(userId, next);
  }
}

function voiceStateDisplayName(state: VoiceState): string {
  return (
    state.member?.displayName ||
    state.member?.user.globalName ||
    state.member?.user.username ||
    state.id
  );
}

function hasNonZeroPcm(pcm: Buffer): boolean {
  for (let i = 0; i + 1 < pcm.byteLength; i += 2) {
    if (pcm.readInt16LE(i) !== 0) return true;
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

export type { ThreadVoiceCaptureEnd, ThreadVoiceCaptureRef };
