/**
 * Gemini 3.5 Live Transcribe client for Thread Voice.
 *
 * This module deliberately owns only the Google streaming boundary. Discord
 * mute gating, PCM conversion, capture limits, and caller-side fallback
 * buffering remain outside the client.
 */
import { WebSocket } from "ws";
import { liveWsUrl, parseLiveWsData, serverContentOf } from "./gemini-live-spike.js";
import {
  normalizeCustomVocabulary,
  transcribeAudioWithGemini,
  type SttResult,
} from "./gemini-stt.js";

export const GEMINI_LIVE_TRANSCRIBE_MODEL = "gemini-3.5-transcribe-live";
export const GEMINI_UNARY_TRANSCRIBE_MODEL = "gemini-3.5-transcribe";
export const GEMINI_PCM16K_MIME = "audio/pcm;rate=16000";

const DEFAULT_SETUP_TIMEOUT_MS = 12_000;
const DEFAULT_FINALIZATION_TIMEOUT_MS = 8_000;
// Leave a full minute before the documented ten-minute Live Transcribe limit.
const DEFAULT_ROTATION_MS = 9 * 60_000;
const RECONNECT_RETRY_MS = 5_000;
const PCM_CHUNK_BYTES = 3_200; // 100 ms of 16 kHz mono s16le.

export type GeminiLiveTranscribeSource = "live" | "unary";

export type GeminiLiveTranscribeResult =
  | { ok: true; text: string; source: GeminiLiveTranscribeSource }
  | { ok: false; error: string; source: "unary" };

export interface GeminiLiveTranscribeFinal {
  text: string;
  source: GeminiLiveTranscribeSource;
}

export interface GeminiLiveTranscribeByteEvent {
  bytes: number;
  totalBytes: number;
}

export type GeminiLiveTranscribeSessionEvent =
  | { type: "go_away"; timeLeft?: string }
  | { type: "rotated"; reason: "age" | "go_away" | "close" }
  | { type: "closed"; code: number; reason: string }
  | { type: "reconnect_failed"; reason: string };

export interface GeminiLiveTranscribeHandlers {
  /** Speculative panel text. Never use this callback to dispatch a prompt. */
  onInterim?: (text: string) => void;
  /** Exactly one successful final callback per completed utterance. */
  onFinal?: (result: GeminiLiveTranscribeFinal) => void;
  /** Counts only PCM bytes successfully handed to an open WebSocket. */
  onForwardedBytes?: (event: GeminiLiveTranscribeByteEvent) => void;
  onSessionEvent?: (event: GeminiLiveTranscribeSessionEvent) => void;
}

export interface GeminiUnaryFallbackInput {
  apiKey: string;
  model: string;
  pcm16k: Uint8Array;
  customVocabulary: ReadonlyArray<string>;
}

export type GeminiUnaryFallback = (
  input: GeminiUnaryFallbackInput
) => Promise<SttResult>;

export interface GeminiLiveTranscribeOptions {
  apiKey: string;
  unaryModel?: string;
  customVocabulary?: ReadonlyArray<string>;
  handlers?: GeminiLiveTranscribeHandlers;
  /** Test seam and optional host override. */
  webSocketFactory?: (url: string) => WebSocket;
  /** Test seam; production defaults to existing Smart voice-note STT. */
  unaryFallback?: GeminiUnaryFallback;
  /** Passed only to the default unary fallback. */
  fetchFn?: typeof fetch;
  setupTimeoutMs?: number;
  finalizationTimeoutMs?: number;
  rotationMs?: number;
}

export function buildGeminiLiveTranscribeSetup(opts: {
  customVocabulary?: ReadonlyArray<string>;
} = {}): { setup: Record<string, unknown> } {
  const customVocabulary = normalizeCustomVocabulary(opts.customVocabulary ?? []);
  return {
    setup: {
      model: `models/${GEMINI_LIVE_TRANSCRIBE_MODEL}`,
      generationConfig: {
        responseModalities: ["TEXT"],
      },
      inputAudioTranscription: {
        languageCodes: [],
        mode: "SMART",
        ...(customVocabulary.length > 0 ? { customVocabulary } : {}),
      },
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: true },
      },
    },
  };
}

export function buildGeminiTranscribeActivityStart(): Record<string, unknown> {
  return { realtimeInput: { activityStart: {} } };
}

export function buildGeminiTranscribeActivityEnd(): Record<string, unknown> {
  return { realtimeInput: { activityEnd: {} } };
}

export function buildGeminiTranscribePcm(pcm16k: Uint8Array): Record<string, unknown> {
  return {
    realtimeInput: {
      audio: {
        mimeType: GEMINI_PCM16K_MIME,
        data: Buffer.from(pcm16k).toString("base64"),
      },
    },
  };
}

interface LiveConnection {
  ws: WebSocket;
  intentionalClose: boolean;
}

interface ActiveUtterance {
  phase: "capturing" | "finalizing";
  finalParts: string[];
  liveFailure?: string;
  bufferedPcm?: Uint8Array;
  resultPromise?: Promise<GeminiLiveTranscribeResult>;
  resolve?: (result: GeminiLiveTranscribeResult) => void;
  finalizationTimer?: ReturnType<typeof setTimeout>;
  decision?: "live" | "unary";
  completed: boolean;
}

function textField(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" ? text.trim() : "";
}

export function extractGeminiLiveTranscriptions(msg: Record<string, unknown>): {
  interim: string;
  final: string;
} {
  const content = serverContentOf(msg);
  if (!content) return { interim: "", final: "" };
  return {
    interim: textField(
      content.interimInputTranscription ?? content.interim_input_transcription
    ),
    final: textField(content.inputTranscription ?? content.input_transcription),
  };
}

function goAwayTimeLeft(msg: Record<string, unknown>): string | undefined {
  const value = msg.goAway ?? msg.go_away;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw =
    (value as Record<string, unknown>).timeLeft ??
    (value as Record<string, unknown>).time_left;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function isSetupComplete(msg: Record<string, unknown>): boolean {
  return "setupComplete" in msg || "setup_complete" in msg;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err || "unknown error");
}

function joinFinalParts(parts: ReadonlyArray<string>): string {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n").trim();
}

/**
 * One logical utterance may be active at a time. The caller owns and bounds the
 * PCM fallback buffer, then passes it to finalizeUtterance().
 */
export class GeminiLiveTranscribeClient {
  private readonly apiKey: string;
  private readonly unaryModel: string;
  private readonly customVocabulary: string[];
  private readonly handlers: GeminiLiveTranscribeHandlers;
  private readonly webSocketFactory: (url: string) => WebSocket;
  private readonly unaryFallback: GeminiUnaryFallback;
  private readonly setupTimeoutMs: number;
  private readonly finalizationTimeoutMs: number;
  private readonly rotationMs: number;

  private connection?: LiveConnection;
  private connectionPromise?: Promise<LiveConnection>;
  private rotationPromise?: Promise<void>;
  private rotationTimer?: ReturnType<typeof setTimeout>;
  private utterance?: ActiveUtterance;
  private stopped = false;
  private totalForwardedBytes = 0;

  private constructor(opts: GeminiLiveTranscribeOptions) {
    this.apiKey = opts.apiKey.trim();
    this.unaryModel = opts.unaryModel?.trim() || GEMINI_UNARY_TRANSCRIBE_MODEL;
    this.customVocabulary = normalizeCustomVocabulary(opts.customVocabulary ?? []);
    this.handlers = opts.handlers ?? {};
    this.webSocketFactory = opts.webSocketFactory ?? ((url) => new WebSocket(url));
    this.setupTimeoutMs = opts.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS;
    this.finalizationTimeoutMs =
      opts.finalizationTimeoutMs ?? DEFAULT_FINALIZATION_TIMEOUT_MS;
    this.rotationMs = opts.rotationMs ?? DEFAULT_ROTATION_MS;
    this.unaryFallback =
      opts.unaryFallback ??
      ((input) =>
        transcribeAudioWithGemini({
          apiKey: input.apiKey,
          bytes: input.pcm16k,
          mimeType: GEMINI_PCM16K_MIME,
          model: input.model,
          customVocabulary: input.customVocabulary,
          ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
        }));
  }

  static async connect(
    opts: GeminiLiveTranscribeOptions
  ): Promise<GeminiLiveTranscribeClient> {
    if (!opts.apiKey.trim()) throw new Error("no SEAM_GEMINI_API_KEY");
    const client = new GeminiLiveTranscribeClient(opts);
    await client.ensureConnection();
    return client;
  }

  get forwardedBytes(): number {
    return this.totalForwardedBytes;
  }

  get readyState(): number {
    return this.connection?.ws.readyState ?? WebSocket.CLOSED;
  }

  async startUtterance(): Promise<void> {
    if (this.stopped) throw new Error("live transcribe client is closed");
    if (this.utterance) throw new Error("a live transcribe utterance is already active");
    const connection = await this.ensureConnection();
    const utterance: ActiveUtterance = {
      phase: "capturing",
      finalParts: [],
      completed: false,
    };
    this.utterance = utterance;
    if (!this.sendJson(connection, buildGeminiTranscribeActivityStart())) {
      utterance.liveFailure = "failed to send activityStart";
    }
  }

  sendPcm16k(pcm16k: Uint8Array): void {
    const utterance = this.utterance;
    if (!utterance || utterance.phase !== "capturing") {
      throw new Error("no capturing live transcribe utterance");
    }
    if (pcm16k.byteLength === 0) return;
    if (pcm16k.byteLength % 2 !== 0) {
      throw new Error("PCM16 chunk must contain complete 16-bit samples");
    }
    if (utterance.liveFailure) return;
    const connection = this.connection;
    if (!connection || connection.ws.readyState !== WebSocket.OPEN) {
      utterance.liveFailure = "live transcribe socket is not open";
      return;
    }

    for (let offset = 0; offset < pcm16k.byteLength; offset += PCM_CHUNK_BYTES) {
      const chunk = pcm16k.subarray(offset, offset + PCM_CHUNK_BYTES);
      if (!this.sendJson(connection, buildGeminiTranscribePcm(chunk))) {
        utterance.liveFailure = "failed to send PCM to live transcribe";
        return;
      }
      this.totalForwardedBytes += chunk.byteLength;
      this.safeCallback(() =>
        this.handlers.onForwardedBytes?.({
          bytes: chunk.byteLength,
          totalBytes: this.totalForwardedBytes,
        })
      );
    }
  }

  finalizeUtterance(callerBufferedPcm: Uint8Array): Promise<GeminiLiveTranscribeResult> {
    const utterance = this.utterance;
    if (!utterance) throw new Error("no live transcribe utterance to finalize");
    if (utterance.resultPromise) return utterance.resultPromise;

    utterance.phase = "finalizing";
    utterance.bufferedPcm = Uint8Array.from(callerBufferedPcm);
    utterance.resultPromise = new Promise((resolve) => {
      utterance.resolve = resolve;
    });

    const connection = this.connection;
    if (
      !utterance.liveFailure &&
      (!connection || !this.sendJson(connection, buildGeminiTranscribeActivityEnd()))
    ) {
      utterance.liveFailure = "failed to send activityEnd";
    }

    const finalText = joinFinalParts(utterance.finalParts);
    if (finalText) {
      this.finishWithLive(utterance, finalText);
    } else if (utterance.liveFailure) {
      void this.finishWithUnary(utterance);
    } else {
      utterance.finalizationTimer = setTimeout(() => {
        void this.finishWithUnary(utterance);
      }, this.finalizationTimeoutMs);
    }
    return utterance.resultPromise;
  }

  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearRotationTimer();
    const connection = this.connection;
    this.connection = undefined;
    if (connection) this.closeConnection(connection);

    const utterance = this.utterance;
    if (utterance && !utterance.completed) {
      utterance.liveFailure = "live transcribe client closed";
      if (utterance.phase === "finalizing") void this.finishWithUnary(utterance);
    }
  }

  private async ensureConnection(): Promise<LiveConnection> {
    if (this.stopped) throw new Error("live transcribe client is closed");
    if (this.connection?.ws.readyState === WebSocket.OPEN) return this.connection;
    if (this.connectionPromise) return this.connectionPromise;

    const pending = this.openConnection();
    this.connectionPromise = pending;
    try {
      const connection = await pending;
      if (this.stopped) {
        this.closeConnection(connection);
        throw new Error("live transcribe client is closed");
      }
      this.connection = connection;
      this.armRotation(connection);
      return connection;
    } finally {
      if (this.connectionPromise === pending) this.connectionPromise = undefined;
    }
  }

  private openConnection(): Promise<LiveConnection> {
    const ws = this.webSocketFactory(liveWsUrl(this.apiKey));
    const connection: LiveConnection = { ws, intentionalClose: false };

    return new Promise((resolve, reject) => {
      let opened = false;
      let ready = false;
      let settled = false;
      const openTimer = setTimeout(() => fail(new Error("live transcribe ws open timed out")), 10_000);
      let setupTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanupPending = (): void => {
        clearTimeout(openTimer);
        if (setupTimer) clearTimeout(setupTimer);
      };
      const fail = (err: unknown): void => {
        if (settled) return;
        settled = true;
        cleanupPending();
        connection.intentionalClose = true;
        this.closeConnection(connection);
        reject(err instanceof Error ? err : new Error(errorMessage(err)));
      };

      ws.once("open", () => {
        opened = true;
        clearTimeout(openTimer);
        if (
          !this.sendJson(
            connection,
            buildGeminiLiveTranscribeSetup({ customVocabulary: this.customVocabulary })
          )
        ) {
          fail(new Error("failed to send live transcribe setup"));
          return;
        }
        setupTimer = setTimeout(
          () => fail(new Error("live transcribe setupComplete timed out")),
          this.setupTimeoutMs
        );
      });

      ws.on("message", (data) => {
        const msg = parseLiveWsData(data);
        if (!msg) return;
        if (!ready && isSetupComplete(msg)) {
          ready = true;
          settled = true;
          cleanupPending();
          resolve(connection);
          return;
        }
        if (ready) this.handleMessage(connection, msg);
      });

      ws.on("error", (err) => {
        if (!ready) {
          fail(err);
          return;
        }
        this.handleConnectionFailure(connection, `socket error: ${errorMessage(err)}`);
      });

      ws.once("close", (code, reason) => {
        const closeReason = String(reason ?? "");
        if (!ready) {
          fail(
            new Error(
              `live transcribe setup failed (opened=${opened} code=${code} reason=${closeReason || "none"})`
            )
          );
          return;
        }
        this.handleConnectionClose(connection, code, closeReason);
      });
    });
  }

  private handleMessage(connection: LiveConnection, msg: Record<string, unknown>): void {
    if (this.connection !== connection || this.stopped) return;
    const timeLeft = goAwayTimeLeft(msg);
    if ("goAway" in msg || "go_away" in msg) {
      this.safeCallback(() =>
        this.handlers.onSessionEvent?.({
          type: "go_away",
          ...(timeLeft ? { timeLeft } : {}),
        })
      );
      this.requestRotation("go_away");
    }

    const transcripts = extractGeminiLiveTranscriptions(msg);
    const utterance = this.utterance;
    if (!utterance || utterance.completed) return;
    if (transcripts.interim) {
      this.safeCallback(() => this.handlers.onInterim?.(transcripts.interim));
    }
    if (transcripts.final) {
      utterance.finalParts.push(transcripts.final);
      if (utterance.phase === "finalizing") {
        this.finishWithLive(utterance, joinFinalParts(utterance.finalParts));
      }
    }
  }

  private handleConnectionFailure(connection: LiveConnection, reason: string): void {
    if (this.connection !== connection || connection.intentionalClose || this.stopped) return;
    const utterance = this.utterance;
    if (utterance && !utterance.completed) {
      utterance.liveFailure = reason;
      if (utterance.phase === "finalizing") void this.finishWithUnary(utterance);
    }
    this.requestRotation("close");
  }

  private handleConnectionClose(
    connection: LiveConnection,
    code: number,
    reason: string
  ): void {
    if (this.connection !== connection || connection.intentionalClose || this.stopped) return;
    this.connection = undefined;
    this.clearRotationTimer();
    this.safeCallback(() =>
      this.handlers.onSessionEvent?.({ type: "closed", code, reason })
    );
    const utterance = this.utterance;
    if (utterance && !utterance.completed) {
      utterance.liveFailure = `live transcribe socket closed (${code}${reason ? `: ${reason}` : ""})`;
      if (utterance.phase === "finalizing") void this.finishWithUnary(utterance);
    }
    this.requestRotation("close");
  }

  private finishWithLive(utterance: ActiveUtterance, text: string): void {
    if (utterance.completed || utterance.decision) return;
    const normalized = text.trim();
    if (!normalized) return;
    utterance.decision = "live";
    this.completeUtterance(utterance, { ok: true, text: normalized, source: "live" });
  }

  private async finishWithUnary(utterance: ActiveUtterance): Promise<void> {
    if (utterance.completed || utterance.decision) return;
    utterance.decision = "unary";
    if (utterance.finalizationTimer) clearTimeout(utterance.finalizationTimer);
    const pcm16k = utterance.bufferedPcm ?? new Uint8Array();
    let result: SttResult;
    try {
      result = await this.unaryFallback({
        apiKey: this.apiKey,
        model: this.unaryModel,
        pcm16k,
        customVocabulary: this.customVocabulary,
      });
    } catch (err) {
      result = { ok: false, error: errorMessage(err) };
    }
    if (result.ok) {
      this.completeUtterance(utterance, {
        ok: true,
        text: result.text.trim(),
        source: "unary",
      });
    } else {
      this.completeUtterance(utterance, {
        ok: false,
        error: result.error,
        source: "unary",
      });
    }
  }

  private completeUtterance(
    utterance: ActiveUtterance,
    result: GeminiLiveTranscribeResult
  ): void {
    if (utterance.completed) return;
    utterance.completed = true;
    if (utterance.finalizationTimer) clearTimeout(utterance.finalizationTimer);
    utterance.bufferedPcm = undefined;
    if (this.utterance === utterance) this.utterance = undefined;
    if (result.ok) {
      this.safeCallback(() =>
        this.handlers.onFinal?.({ text: result.text, source: result.source })
      );
    }
    utterance.resolve?.(result);
    this.afterUtterance();
  }

  private afterUtterance(): void {
    if (this.stopped) return;
    if (!this.connection) this.requestRotation("close");
  }

  private requestRotation(reason: "age" | "go_away" | "close"): void {
    if (this.stopped) return;
    const utterance = this.utterance;
    if (utterance && !utterance.completed) {
      // Do not let a long capture carry an old socket through the hard session
      // limit. The caller's full PCM buffer makes this utterance recoverable.
      utterance.liveFailure ??= `live transcribe session rotating (${reason})`;
      if (utterance.phase === "finalizing") void this.finishWithUnary(utterance);
    }
    if (this.rotationPromise) return;
    const pending = this.rotateConnection(reason);
    this.rotationPromise = pending;
    void pending.finally(() => {
      if (this.rotationPromise === pending) this.rotationPromise = undefined;
    });
  }

  private async rotateConnection(reason: "age" | "go_away" | "close"): Promise<void> {
    const previous = this.connection;
    try {
      const next = await this.openConnection();
      if (this.stopped) {
        this.closeConnection(next);
        return;
      }
      this.connection = next;
      this.armRotation(next);
      if (previous) this.closeConnection(previous);
      this.safeCallback(() => this.handlers.onSessionEvent?.({ type: "rotated", reason }));
    } catch (err) {
      this.safeCallback(() =>
        this.handlers.onSessionEvent?.({
          type: "reconnect_failed",
          reason: errorMessage(err),
        })
      );
      if (!previous || previous.ws.readyState !== WebSocket.OPEN) this.connection = undefined;
      this.clearRotationTimer();
      if (!this.stopped) {
        this.rotationTimer = setTimeout(
          () => this.requestRotation(reason),
          Math.min(RECONNECT_RETRY_MS, this.rotationMs)
        );
      }
    }
  }

  private armRotation(connection: LiveConnection): void {
    this.clearRotationTimer();
    this.rotationTimer = setTimeout(() => {
      if (this.connection === connection) this.requestRotation("age");
    }, this.rotationMs);
  }

  private clearRotationTimer(): void {
    if (this.rotationTimer) clearTimeout(this.rotationTimer);
    this.rotationTimer = undefined;
  }

  private sendJson(connection: LiveConnection, message: Record<string, unknown>): boolean {
    if (connection.ws.readyState !== WebSocket.OPEN) return false;
    try {
      connection.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private closeConnection(connection: LiveConnection): void {
    connection.intentionalClose = true;
    try {
      if (
        connection.ws.readyState === WebSocket.OPEN ||
        connection.ws.readyState === WebSocket.CONNECTING
      ) {
        connection.ws.close();
      }
    } catch {
      // Closing is best effort; the caller's PCM fallback remains authoritative.
    }
  }

  private safeCallback(callback: () => void): void {
    try {
      callback();
    } catch {
      // Observability/UI callbacks must not alter transcription correctness.
    }
  }
}
