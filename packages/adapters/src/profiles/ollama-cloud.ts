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
export async function fetchOllamaCloudUsage(
  cliPath?: string
): Promise<OllamaCloudUsageData> {
  const cli = cliPath?.trim() || "ollama-usage";
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
      resolve(data);
    };
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
