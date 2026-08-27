import { promises as fsp } from "node:fs";

export interface ThreadMigrationPlan {
  agentId: string;
  model: string;
  concurrency: number;
  threadIds: string[];
}

export type ThreadMigrationOutcome<T> =
  | { threadId: string; ok: true; value: T }
  | { threadId: string; ok: false; error: Error };

export function parseThreadMigrationPlan(value: unknown): ThreadMigrationPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Thread migration sentinel must contain a JSON object.");
  }
  const raw = value as Record<string, unknown>;
  const agentId = typeof raw.agentId === "string" ? raw.agentId.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!agentId) throw new Error("Thread migration agentId must be a non-empty string.");
  if (!model) throw new Error("Thread migration model must be a non-empty string.");
  if (
    !Array.isArray(raw.threadIds) ||
    raw.threadIds.length === 0 ||
    raw.threadIds.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new Error("Thread migration threadIds must be a non-empty array of non-empty strings.");
  }

  let concurrency = 2;
  if (raw.concurrency !== undefined) {
    if (typeof raw.concurrency !== "number" || !Number.isFinite(raw.concurrency)) {
      throw new Error("Thread migration concurrency must be a finite number.");
    }
    concurrency = Math.trunc(raw.concurrency);
  }

  return {
    agentId,
    model,
    concurrency: Math.max(1, Math.min(4, concurrency)),
    threadIds: raw.threadIds.map((id) => (id as string).trim()),
  };
}

export async function loadThreadMigrationPlan(
  sentinelPath: string
): Promise<ThreadMigrationPlan | null> {
  let text: string;
  try {
    text = await fsp.readFile(sentinelPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid thread migration JSON: ${(err as Error).message}`);
  }
  return parseThreadMigrationPlan(parsed);
}

export async function runThreadMigrationPool<T>(
  threadIds: string[],
  concurrency: number,
  worker: (threadId: string) => Promise<T>
): Promise<Array<ThreadMigrationOutcome<T>>> {
  const outcomes = new Array<ThreadMigrationOutcome<T>>(threadIds.length);
  let nextIndex = 0;
  const width = Math.min(threadIds.length, Math.max(1, Math.min(4, Math.trunc(concurrency))));

  await Promise.all(
    Array.from({ length: width }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= threadIds.length) return;
        const threadId = threadIds[index]!;
        try {
          outcomes[index] = { threadId, ok: true, value: await worker(threadId) };
        } catch (err) {
          outcomes[index] = {
            threadId,
            ok: false,
            error: err instanceof Error ? err : new Error(String(err)),
          };
        }
      }
    })
  );
  return outcomes;
}
