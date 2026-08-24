/**
 * Production Gemini Live session (#98). Continuous duplex.
 * Do NOT put responseModalities on the setup root (close 1007).
 * Auto-VAD never completes a turn when Discord stops sending packets
 * (proven in the spike). Disable it and bracket each utterance with
 * activityStart / activityEnd from Discord speaking.
 */
import { WebSocket } from "ws";
import {
  extractLiveAudioB64,
  extractLiveText,
  isLiveTurnComplete,
  liveWsUrl,
  parseLiveWsData,
} from "./gemini-live-spike.js";
import { LIVE_HELP_MODEL } from "../live-help/types.js";

const SETUP_TIMEOUT_MS = 12_000;
const CHUNK_BYTES = 3200;

export function buildLiveHelpSetup(opts: {
  system: string;
  voiceName?: string;
}): { setup: Record<string, unknown> } {
  return {
    setup: {
      model: `models/${LIVE_HELP_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: opts.voiceName ?? "Kore" },
          },
        },
      },
      systemInstruction: {
        parts: [{ text: opts.system }],
      },
      // Seed history as context only — must not start a spoken turn.
      historyConfig: { initialHistoryInClientContent: true },
      realtimeInputConfig: {
        automaticActivityDetection: { disabled: true },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

export function buildActivityStart(): Record<string, unknown> {
  return { realtimeInput: { activityStart: {} } };
}

export function buildActivityEnd(): Record<string, unknown> {
  return { realtimeInput: { activityEnd: {} } };
}

export function buildHistoryClientContent(summary: string): Record<string, unknown> {
  return {
    clientContent: {
      turns: [{ role: "user", parts: [{ text: summary }] }],
      turnComplete: true,
    },
  };
}

export function isLiveSetupComplete(msg: Record<string, unknown>): boolean {
  return "setupComplete" in msg || "setup_complete" in msg;
}

export function isLiveInterrupted(msg: Record<string, unknown>): boolean {
  const sc = msg.serverContent ?? msg.server_content;
  if (!sc || typeof sc !== "object" || Array.isArray(sc)) return false;
  const rec = sc as Record<string, unknown>;
  return rec.interrupted === true;
}

export function isLiveGoAway(msg: Record<string, unknown>): boolean {
  return "goAway" in msg || "go_away" in msg;
}

export function setupHasRootResponseModalities(setupMsg: { setup: Record<string, unknown> }): boolean {
  return "responseModalities" in setupMsg.setup || "response_modalities" in setupMsg.setup;
}

export interface GeminiLiveHandlers {
  onAudio?: (pcm24k: Buffer) => void;
  onTranscript?: (side: "input" | "output", text: string) => void;
  onInterrupted?: () => void;
  onTurnComplete?: () => void;
  onGoAway?: () => void;
  onClose?: (code: number, reason: string) => void;
}

export class GeminiLiveSession {
  private ws: WebSocket;
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
  }

  static async connect(opts: {
    apiKey: string;
    system: string;
    historySummary?: string;
    handlers?: GeminiLiveHandlers;
    voiceName?: string;
  }): Promise<GeminiLiveSession> {
    if (!opts.apiKey.trim()) throw new Error("no SEAM_GEMINI_API_KEY");
    const ws = new WebSocket(liveWsUrl(opts.apiKey));
    const session = new GeminiLiveSession(ws);
    const h = opts.handlers ?? {};

    let setupDone = false;
    let closed = false;
    let closeCode = 0;
    let closeReason = "";

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("live ws open timed out")), 10_000);
      ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });

    ws.on("message", (data) => {
      const msg = parseLiveWsData(data);
      if (!msg) return;
      if (isLiveSetupComplete(msg)) setupDone = true;
      if (isLiveGoAway(msg)) h.onGoAway?.();
      if (isLiveInterrupted(msg)) h.onInterrupted?.();
      if (isLiveTurnComplete(msg)) h.onTurnComplete?.();
      for (const b64 of extractLiveAudioB64(msg)) {
        const pcm = Buffer.from(b64, "base64");
        if (pcm.byteLength > 0) h.onAudio?.(pcm);
      }
      const inn = extractLiveText(msg, "input");
      if (inn) h.onTranscript?.("input", inn);
      const out = extractLiveText(msg, "output");
      if (out) h.onTranscript?.("output", out);
    });
    ws.once("close", (code, reason) => {
      closed = true;
      session.closed = true;
      closeCode = code;
      closeReason = String(reason ?? "");
      h.onClose?.(code, closeReason);
    });

    const setupMsg = buildLiveHelpSetup({
      system: opts.system,
      ...(opts.voiceName ? { voiceName: opts.voiceName } : {}),
    });
    ws.send(JSON.stringify(setupMsg));

    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        reject(
          new Error(
            `live setupComplete timed out (closed=${closed} code=${closeCode || "n/a"} reason=${closeReason || "none"})`
          )
        );
      }, SETUP_TIMEOUT_MS);
      const iv = setInterval(() => {
        if (setupDone) {
          clearTimeout(t);
          clearInterval(iv);
          resolve();
        } else if (closed) {
          clearTimeout(t);
          clearInterval(iv);
          reject(
            new Error(
              `live setup failed (closed code=${closeCode} reason=${closeReason || "none"} after ${Date.now() - started}ms)`
            )
          );
        }
      }, 20);
    });

    if (opts.historySummary?.trim()) {
      ws.send(JSON.stringify(buildHistoryClientContent(opts.historySummary.trim())));
    }
    return session;
  }

  get readyState(): number {
    return this.ws.readyState;
  }

  sendActivityStart(): void {
    this.sendJson(buildActivityStart());
  }

  sendActivityEnd(): void {
    this.sendJson(buildActivityEnd());
  }

  sendPcm16k(pcm: Buffer): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    if (pcm.byteLength === 0) return;
    for (let i = 0; i < pcm.byteLength; i += CHUNK_BYTES) {
      const chunk = pcm.subarray(i, i + CHUNK_BYTES);
      this.sendJson({
        realtimeInput: {
          audio: {
            mimeType: "audio/pcm;rate=16000",
            data: Buffer.from(chunk).toString("base64"),
          },
        },
      });
    }
  }

  private sendJson(msg: Record<string, unknown>): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.closed = true;
    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
    } catch {
      /* ignore */
    }
  }
}
