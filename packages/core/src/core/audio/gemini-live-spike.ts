/**
 * Live-help spike: one-shot Gemini Live WS. Not production.
 * Studio BidiGenerateContent, gemini-3.1-flash-live-preview.
 * Wait for setupComplete before sending (first-frame JSON can be junk).
 */
import { WebSocket } from "ws";

export const GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview";
const SETUP_TIMEOUT_MS = 12_000;
const REPLY_TIMEOUT_MS = 45_000;
const CHUNK_BYTES = 3200; // 100ms of 16 kHz mono s16le

export function liveWsUrl(apiKey: string): string {
  return (
    "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=" +
    encodeURIComponent(apiKey)
  );
}

export function parseLiveWsData(data: unknown): Record<string, unknown> | null {
  try {
    let text: string | null = null;
    if (typeof data === "string") text = data;
    else if (Buffer.isBuffer(data)) text = data.toString("utf8");
    else if (data instanceof Uint8Array) text = Buffer.from(data).toString("utf8");
    else if (Array.isArray(data)) text = Buffer.concat(data as Buffer[]).toString("utf8");
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function pick(rec: Record<string, unknown> | null, ...keys: string[]): unknown {
  if (!rec) return undefined;
  for (const k of keys) {
    if (k in rec) return rec[k];
  }
  return undefined;
}

export function serverContentOf(msg: Record<string, unknown>): Record<string, unknown> | null {
  return asRecord(pick(msg, "serverContent", "server_content"));
}

export function extractLiveAudioB64(msg: Record<string, unknown>): string[] {
  const sc = serverContentOf(msg);
  const turn = asRecord(pick(sc, "modelTurn", "model_turn"));
  const parts = pick(turn, "parts");
  if (!Array.isArray(parts)) return [];
  const out: string[] = [];
  for (const part of parts) {
    const rec = asRecord(part);
    const blob = asRecord(pick(rec, "inlineData", "inline_data"));
    const data = blob?.data;
    if (typeof data !== "string" || !data) continue;
    const mime = typeof blob?.mimeType === "string" ? blob.mimeType : typeof blob?.mime_type === "string" ? blob.mime_type : "";
    if (!mime || mime.includes("audio")) out.push(data);
  }
  return out;
}

export function extractLiveText(msg: Record<string, unknown>, which: "input" | "output"): string {
  const chunks: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && v.trim()) chunks.push(v);
  };
  const sc = serverContentOf(msg);
  const named = which === "input"
    ? pick(sc, "inputTranscription", "input_transcription")
    : pick(sc, "outputTranscription", "output_transcription");
  push(asRecord(named)?.text);
  if (which === "output") {
    const parts = pick(asRecord(pick(sc, "modelTurn", "model_turn")), "parts");
    if (Array.isArray(parts)) {
      for (const p of parts) push(asRecord(p)?.text);
    }
  }
  const top = which === "input"
    ? pick(msg, "inputTranscription", "input_transcription")
    : pick(msg, "outputTranscription", "output_transcription");
  push(asRecord(top)?.text);
  return chunks.join("");
}

export function isLiveTurnComplete(msg: Record<string, unknown>): boolean {
  const sc = serverContentOf(msg);
  return (
    pick(sc, "turnComplete", "turn_complete") === true ||
    pick(sc, "generationComplete", "generation_complete") === true
  );
}

export function liveMsgKeys(msg: Record<string, unknown>): string {
  return Object.keys(msg).sort().join(",");
}

/** True when we have PCM and the model has finished (or the socket died with PCM). */
export function liveReplyReady(opts: {
  audioChunks: number;
  turnComplete: boolean;
  closed: boolean;
}): boolean {
  return opts.audioChunks > 0 && (opts.turnComplete || opts.closed);
}

export type LiveRoundTrip =
  | {
      ok: true;
      pcm24k: Buffer;
      inputTranscript: string;
      outputTranscript: string;
    }
  | { ok: false; reason: string };

export async function liveAudioRoundTrip(opts: {
  apiKey: string;
  pcm16k: Buffer;
  timeoutMs?: number;
}): Promise<LiveRoundTrip> {
  if (!opts.apiKey.trim()) return { ok: false, reason: "no SEAM_GEMINI_API_KEY" };
  if (opts.pcm16k.byteLength < 3200) {
    return { ok: false, reason: "pcm clip too short to send" };
  }

  const replyTimeout = opts.timeoutMs ?? REPLY_TIMEOUT_MS;
  const ws = new WebSocket(liveWsUrl(opts.apiKey));

  const audioB64: string[] = [];
  let inputTranscript = "";
  let outputTranscript = "";
  let setupDone = false;
  let turnComplete = false;

  const fail = (reason: string): LiveRoundTrip => ({ ok: false, reason });
  const keysSeen: string[] = [];
  let unparsed = 0;
  let closed = false;
  let closeCode: number | undefined;
  let closeReason = "";

  const ingest = (msg: Record<string, unknown>): void => {
    keysSeen.push(liveMsgKeys(msg));
    if ("setupComplete" in msg || "setup_complete" in msg) setupDone = true;
    if (isLiveTurnComplete(msg)) turnComplete = true;
    audioB64.push(...extractLiveAudioB64(msg));
    inputTranscript += extractLiveText(msg, "input");
    outputTranscript += extractLiveText(msg, "output");
  };

  const waitUntil = (ok: () => boolean, ms: number, label: () => string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (ok()) return resolve();
      const t = setTimeout(() => {
        clearInterval(iv);
        reject(new Error(label()));
      }, ms);
      const iv = setInterval(() => {
        if (!ok()) return;
        clearTimeout(t);
        clearInterval(iv);
        resolve();
      }, 20);
    });

  try {
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

    // Listen before any send so a fast model turn is not dropped.
    ws.on("message", (data) => {
      const msg = parseLiveWsData(data);
      if (!msg) {
        unparsed += 1;
        return;
      }
      ingest(msg);
    });
    ws.once("close", (code, reason) => {
      closed = true;
      closeCode = code;
      closeReason = String(reason ?? "");
    });

    ws.send(
      JSON.stringify({
        setup: {
          model: `models/${GEMINI_LIVE_MODEL}`,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
            },
          },
          systemInstruction: {
            parts: [
              {
                text: "You are a brief voice assistant in a Discord test call. Reply in one short spoken sentence to what the user said. Do not ask a follow-up.",
              },
            ],
          },
          // Clip is already segmented; auto-VAD on a burst never ends the turn.
          realtimeInputConfig: {
            automaticActivityDetection: { disabled: true },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        },
      })
    );

    await waitUntil(
      () => setupDone || closed,
      SETUP_TIMEOUT_MS,
      () => `live setupComplete timed out (keys=${keysSeen.join("|") || "none"} unparsed=${unparsed} closed=${closed} code=${closeCode ?? "n/a"} reason=${closeReason || "none"})`
    );
    if (!setupDone) {
      throw new Error(
        `live setup failed (keys=${keysSeen.join("|") || "none"} unparsed=${unparsed} closed=${closed} code=${closeCode ?? "n/a"} reason=${closeReason || "none"})`
      );
    }

    ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
    for (let i = 0; i < opts.pcm16k.byteLength; i += CHUNK_BYTES) {
      const chunk = opts.pcm16k.subarray(i, i + CHUNK_BYTES);
      ws.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              mimeType: "audio/pcm;rate=16000",
              data: Buffer.from(chunk).toString("base64"),
            },
          },
        })
      );
    }
    ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));

    try {
      await waitUntil(
        () =>
          liveReplyReady({
            audioChunks: audioB64.length,
            turnComplete,
            closed,
          }),
        replyTimeout,
        () =>
          `live audio reply timed out (chunks=${audioB64.length} complete=${turnComplete} keys=${keysSeen.join("|") || "none"} unparsed=${unparsed} closed=${closed} code=${closeCode ?? "n/a"} reason=${closeReason || "none"} in="${inputTranscript.trim()}" out="${outputTranscript.trim()}")`
      );
    } catch (err) {
      // Keep whatever PCM we already have rather than failing a long reply.
      if (audioB64.length === 0) throw err;
    }

    const pcm24k = Buffer.concat(audioB64.map((b) => Buffer.from(b, "base64")));
    if (pcm24k.byteLength === 0) return fail("live returned no pcm");
    return {
      ok: true,
      pcm24k,
      inputTranscript: inputTranscript.trim(),
      outputTranscript: outputTranscript.trim(),
    };
  } catch (err) {
    return fail((err as Error).message);
  } finally {
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    } catch {
      /* ignore */
    }
  }
}
