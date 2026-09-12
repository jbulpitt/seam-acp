import { spawn } from "node:child_process";

const OLLAMA_USAGE_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1_000_000;

export interface OllamaCloudModelUsage {
  model: string;
  requests: number;
}

export interface OllamaCloudUsageWindow {
  identifier: "5h" | "weekly";
  /** Used percentage reported directly by ollama-usage (0–100). */
  pctUsed: number;
  resetAt: string | null;
  models: OllamaCloudModelUsage[];
}

export interface OllamaCloudUsageData {
  ok: boolean;
  fiveHour: OllamaCloudUsageWindow | null;
  weekly: OllamaCloudUsageWindow | null;
  error?: string;
}

function failure(error: string): OllamaCloudUsageData {
  return { ok: false, fiveHour: null, weekly: null, error };
}

function parseWindow(
  raw: unknown,
  identifier: "5h" | "weekly"
): OllamaCloudUsageWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (
    record.identifier !== identifier ||
    typeof record.pct_used !== "number" ||
    !Number.isFinite(record.pct_used) ||
    record.pct_used < 0 ||
    record.pct_used > 100
  ) {
    return null;
  }
  const models = Array.isArray(record.models)
    ? record.models.flatMap((rawModel): OllamaCloudModelUsage[] => {
        if (!rawModel || typeof rawModel !== "object") return [];
        const model = rawModel as Record<string, unknown>;
        return typeof model.model === "string" &&
          typeof model.requests === "number" &&
          Number.isFinite(model.requests)
          ? [{ model: model.model, requests: model.requests }]
          : [];
      })
    : [];
  return {
    identifier,
    pctUsed: record.pct_used,
    resetAt: typeof record.reset_at === "string" ? record.reset_at : null,
    models,
  };
}

/** Parse the exact JSON object emitted by `ollama-usage --json`. */
export function parseOllamaCloudUsage(raw: unknown): OllamaCloudUsageData {
  if (!raw || typeof raw !== "object") {
    return failure("ollama-usage returned invalid JSON data");
  }
  const record = raw as Record<string, unknown>;
  const fiveHour = parseWindow(record["5h"], "5h");
  const weekly = parseWindow(record.weekly, "weekly");
  if (!fiveHour || !weekly) {
    return failure("ollama-usage response is missing valid 5h or weekly quota data");
  }
  return { ok: true, fiveHour, weekly };
}

/**
 * Read Ollama Cloud quota from `ollama-usage --json`. Never throws: spawn,
 * timeout, exit, output-size, and JSON failures are returned as `ok: false`.
 */
/**
 * Read the Ollama Cloud allowance by spawning `ollama-usage --json`.
 *
 * #361: `signal` cancels the WORK, not merely the wait. This path bounds
 * itself at {@link OLLAMA_USAGE_TIMEOUT_MS} (15s), comfortably inside the
 * quota poller's 30s per-source deadline, so unlike Grok's it could not
 * outlive the deadline on its own — but an aborted refresh still left the
 * child running to its own timer, doing work whose answer nobody would read.
 * The signal was handed to this source and dropped, and an
 * accepted-but-unconsumed signal is worse than no bound, because the caller
 * believes it has one.
 *
 * What an abort refuses: this one Ollama Cloud quota reading, which degrades
 * to "we cannot currently tell you Ollama Cloud's quota" and leaves the
 * registry's last-known-good value in place. What keeps working: every other
 * agent's quota source, each with its own controller; and Ollama Cloud itself
 * as an agent, because the only process killed here is this throwaway
 * `ollama-usage` reader, never a model runtime.
 */
export async function fetchOllamaCloudUsage(
  cliPath?: string,
  signal?: AbortSignal
): Promise<OllamaCloudUsageData> {
  const cli = cliPath?.trim() || "ollama-usage";
  // The cheapest cancellation is the one that never starts a process.
  if (signal?.aborted) return failure("ollama-usage aborted before it started");
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cli, ["--json"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve(failure(`ollama-usage spawn failed: ${message}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (data: OllamaCloudUsageData): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve(data);
    };
    // SIGKILL rather than SIGTERM, matching this path's own timeout below:
    // `ollama-usage` is a throwaway reader with nothing to flush, and the
    // point of consuming the signal is that the process actually stops.
    const onAbort = signal
      ? (): void => {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          finish(failure("ollama-usage aborted"));
        }
      : undefined;
    if (onAbort) signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(failure("ollama-usage timed out after 15s"));
    }, OLLAMA_USAGE_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish(failure("ollama-usage output exceeded 1 MB"));
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (err) => {
      finish(failure(`ollama-usage spawn failed: ${err.message}`));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim().slice(-500);
        finish(
          failure(
            `ollama-usage exited with code ${code ?? "null"}` +
              `${signal ? ` (signal ${signal})` : ""}` +
              `${detail ? `: ${detail}` : ""}`
          )
        );
        return;
      }
      try {
        finish(parseOllamaCloudUsage(JSON.parse(stdout)));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        finish(failure(`ollama-usage returned invalid JSON: ${message}`));
      }
    });
  });
}
