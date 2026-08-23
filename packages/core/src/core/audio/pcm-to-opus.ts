/**
 * Pipe raw L16 PCM through ffmpeg to Ogg Opus. No wav on disk.
 */
import { spawn } from "node:child_process";

export type OpusResult = { ok: true; ogg: Uint8Array } | { ok: false; error: string };

export async function encodePcmToOggOpus(opts: {
  pcm: Uint8Array;
  sampleRate: number;
  channels: number;
  ffmpegPath?: string;
}): Promise<OpusResult> {
  if (opts.pcm.byteLength === 0) return { ok: false, error: "empty pcm" };
  const rate = opts.sampleRate > 0 ? opts.sampleRate : 24_000;
  const channels = opts.channels > 0 ? opts.channels : 1;
  const bin = opts.ffmpegPath ?? "ffmpeg";

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    const child = spawn(
      bin,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "s16le",
        "-ar",
        String(rate),
        "-ac",
        String(channels),
        "-i",
        "pipe:0",
        "-c:a",
        "libopus",
        "-b:a",
        "32k",
        "-f",
        "ogg",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );

    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => errChunks.push(c));
    child.on("error", (err) => {
      resolve({ ok: false, error: err.message || "ffmpeg failed to start" });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf8").trim();
        resolve({
          ok: false,
          error: stderr || `ffmpeg exited ${code ?? "unknown"}`,
        });
        return;
      }
      const ogg = Buffer.concat(chunks);
      if (ogg.byteLength === 0) {
        resolve({ ok: false, error: "ffmpeg produced no audio" });
        return;
      }
      resolve({ ok: true, ogg });
    });

    child.stdin.on("error", () => {
      // ffmpeg may close stdin after it has enough; ignore EPIPE.
    });
    child.stdin.end(Buffer.from(opts.pcm));
  });
}
