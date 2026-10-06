import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { addAbortSignal } from "node:stream";
import { ProbeError, runBoundedProbe } from "../probe-process.js";

export interface CopilotModelContext {
  native: number | null;
  maximum: number | null;
  effective: number | null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function tokens(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** models.list reports the total maximum separately from each tier's input limit. */
export function copilotModelContexts(value: unknown, requestedTier?: string): Map<string, CopilotModelContext> {
  const models = object(value).models;
  if (!Array.isArray(models)) throw new Error("Copilot models.list omitted its models array");
  const contexts = new Map<string, CopilotModelContext>();
  for (const raw of models) {
    const model = object(raw);
    if (typeof model.id !== "string") continue;
    const limits = object(object(model.capabilities).limits);
    const prices = object(object(model.billing).tokenPrices);
    const tier = requestedTier === "long_context" ? object(prices.longContext) : prices;
    const prompt = tokens(tier.maxPromptTokens) ?? tokens(tier.contextMax) ??
      (requestedTier !== "long_context" && !Object.keys(prices).length ? tokens(limits.max_prompt_tokens) : null);
    const total = tokens(limits.max_context_window_tokens);
    contexts.set(model.id, { native: total, maximum: total, effective: prompt });
  }
  return contexts;
}

/** The CLI's SDK transport uses Content-Length frames; this read never opens a session. */
export async function probeCopilotModelContexts(options: {
  cliPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  requestedTier?: string;
  timeoutMs: number;
  cleanupTimeoutMs: number;
  signal: AbortSignal;
  spawnProcess?: (
    executable: string, args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["pipe", "pipe", "pipe"] }
  ) => ChildProcessWithoutNullStreams;
}): Promise<Map<string, CopilotModelContext>> {
  const args = [...options.args.filter(arg => arg !== "--acp"), "--headless", "--stdio"];
  return runBoundedProbe({
    executable: options.cliPath, args, cwd: options.cwd, env: options.env,
    timeoutMs: options.timeoutMs, signal: options.signal,
    killGraceMs: options.cleanupTimeoutMs, finalizeDeadlineMs: options.cleanupTimeoutMs,
    label: "Copilot models.list",
    ...(options.spawnProcess ? { spawnOverride: () => options.spawnProcess!(options.cliPath, args, {
      cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"],
    }) } : {}),
    run: async handle => {
      handle.onClose(() => { handle.stdin.end(); handle.stdout.destroy(); }, "connection");
      const request = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "models.list", params: {} }));
      handle.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${request.length}\r\n\r\n`), request]));
      let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let length: number | undefined;
      for await (const chunk of addAbortSignal(handle.signal, handle.stdout)) {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        for (;;) {
          if (length === undefined) {
            const end = buffer.indexOf("\r\n\r\n");
            if (end < 0) break;
            const header = buffer.subarray(0, end).toString("ascii");
            const declared = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
            if (!declared) throw new ProbeError("protocol_error", "Copilot models.list response omitted Content-Length");
            length = Number(declared[1]);
            buffer = buffer.subarray(end + 4);
          }
          if (buffer.length < length) break;
          const response = JSON.parse(buffer.subarray(0, length).toString("utf8"));
          buffer = buffer.subarray(length);
          length = undefined;
          if (response.id !== 1) continue;
          if (response.error) throw new Error(`Copilot models.list: ${response.error.message ?? JSON.stringify(response.error)}`);
          return copilotModelContexts(response.result, options.requestedTier);
        }
      }
      throw new ProbeError("protocol_error", "Copilot models.list ended before its response");
    },
  });
}
