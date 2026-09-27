import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../lib/logger.js";
import type { ChatAdapter, MessageRef } from "../platforms/chat-adapter.js";
import type { StructuredLayout } from "./types.js";
import type { TestDriverClient, TestInventory } from "./test-driver.js";
import type { TesterBot, TesterMessage } from "./tester-bot.js";

export type CanaryTarget = "staging";
export type CanaryRowStatus = "passed" | "failed" | "skipped";

export interface CanaryRow {
  host: string;
  agent: string;
  status: CanaryRowStatus;
  durationMs: number | null;
  threadId?: string;
  cause?: string;
  providerNote?: string;
}

export interface CanaryRunResult {
  id: string;
  target: CanaryTarget;
  startedAt: string;
  finishedAt: string;
  branch: string;
  commit: string;
  rows: CanaryRow[];
}

export interface CanaryMessageObservation {
  state: "working" | "done" | "failed" | "timed_out" | "unknown";
  nonceSeen: boolean;
  cause?: string;
}

interface CanaryThreadEntry {
  threadId: string;
  threadName: string;
  createdAt: string;
}

interface CanaryThreadFile {
  version: 1;
  threads: Record<string, CanaryThreadEntry>;
}

interface CanaryRunnerOptions {
  testerBot: Pick<TesterBot, "post" | "read" | "findThread">;
  testDriver: Pick<TestDriverClient, "interact" | "inventory">;
  dataDir: string;
  stagingChannelId: string;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  nonce?: () => string;
  providerStatus?: (agentId: string) => string | undefined;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 2_000;
const THREAD_FILE = "canary-staging-threads.json";
const HISTORY_FILE = "canary-staging-history.jsonl";
const LATEST_CARD_FILE = "canary-staging-latest-card.json";

export function readGitIdentity(cwd = process.cwd()): { branch: string; commit: string } {
  const read = (args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  try {
    return {
      branch: read(["branch", "--show-current"]) || "detached",
      commit: read(["rev-parse", "HEAD"]),
    };
  } catch {
    return { branch: "unknown", commit: "unknown" };
  }
}

function bounded(text: string, max = 700): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function messageText(message: TesterMessage): string {
  return [message.content, ...message.embeds, ...(message.components ?? [])]
    .filter(Boolean)
    .join("\n");
}

function failureCause(messages: TesterMessage[]): string | undefined {
  const text = messages
    .filter((message) => message.authorIsBot)
    .map(messageText)
    .filter(Boolean)
    .join("\n");
  const named = text.match(/(?:Error|Cause|Failure|Action)\s*:\s*([^\n]+)/i)?.[1];
  if (named) return bounded(named);
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const terminal = lines.find((line) => /(?:failed|timed out|error|unavailable|refused)/i.test(line));
  return terminal ? bounded(terminal) : undefined;
}

export function observeCanaryMessages(
  messages: TesterMessage[],
  nonce: string,
): CanaryMessageObservation {
  const botMessages = messages.filter((message) => message.authorIsBot);
  const statusText = botMessages.flatMap((message) => [...message.embeds, ...(message.components ?? [])]).join("\n");
  const nonceSeen = botMessages.some((message) => message.content.includes(nonce));
  if (/(?:❌|\b)Failed\b/i.test(statusText)) {
    return { state: "failed", nonceSeen, cause: failureCause(botMessages) };
  }
  if (/(?:Timed out|Timeout)/i.test(statusText)) {
    return { state: "timed_out", nonceSeen, cause: failureCause(botMessages) };
  }
  if (/(?:✅|\b)Done\b/i.test(statusText)) return { state: "done", nonceSeen };
  if (/(?:Working|Waiting|Reconnecting|Monitoring)/i.test(statusText)) {
    return { state: "working", nonceSeen };
  }
  return { state: "unknown", nonceSeen };
}

function interactionFailure(
  result: Awaited<ReturnType<TestDriverClient["interact"]>>,
): string | undefined {
  for (const entry of result.transcript) {
    if (entry.error) return `${entry.error.message} (${entry.error.code})`;
    const content = entry.content?.trim();
    if (content && /(?:Could not|\berror\b|unavailable|refused|not configured)/i.test(content)) {
      return bounded(content);
    }
  }
  return undefined;
}

class CanaryThreadRegistry {
  readonly file: string;
  private readonly state: CanaryThreadFile;
  private writeTail = Promise.resolve();

  private constructor(file: string, state: CanaryThreadFile) {
    this.file = file;
    this.state = state;
  }

  static async load(dataDir: string): Promise<CanaryThreadRegistry> {
    const file = path.join(dataDir, THREAD_FILE);
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8")) as CanaryThreadFile;
      if (parsed.version === 1 && parsed.threads && typeof parsed.threads === "object") {
        return new CanaryThreadRegistry(file, parsed);
      }
    } catch {
      // A missing or invalid map is rebuilt from Discord thread names.
    }
    return new CanaryThreadRegistry(file, { version: 1, threads: {} });
  }

  get(key: string): CanaryThreadEntry | undefined {
    return this.state.threads[key];
  }

  async set(key: string, entry: CanaryThreadEntry): Promise<void> {
    this.state.threads[key] = entry;
    const snapshot = JSON.stringify(this.state, null, 2) + "\n";
    this.writeTail = this.writeTail.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, snapshot, { mode: 0o600 });
      await fs.rename(temp, this.file);
    });
    await this.writeTail;
  }
}

function threadKey(host: string, agent: string): string {
  return `${host}@${agent}`;
}

function threadName(host: string, agent: string): string {
  return `canary-${host}-${agent}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 100);
}

export class StagingCanaryRunner {
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly makeNonce: () => string;

  constructor(private readonly options: CanaryRunnerOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.makeNonce = options.nonce ?? (() => randomUUID().replaceAll("-", ""));
  }

  async run(target: CanaryTarget = "staging"): Promise<CanaryRunResult> {
    if (target !== "staging") throw new Error(`unsupported canary target: ${target}`);
    const started = this.now();
    const inventory = await this.options.testDriver.inventory();
    const registry = await CanaryThreadRegistry.load(this.options.dataDir);
    const targets = inventory.bridges
      .flatMap((bridge) => bridge.agents.map((agent) => ({ bridge, agent })))
      .sort((a, b) =>
        a.bridge.host.localeCompare(b.bridge.host) || a.agent.id.localeCompare(b.agent.id)
      );

    const rows: CanaryRow[] = [];
    const runnable: Array<{ host: string; agent: string; threadId: string }> = [];
    for (const { bridge, agent } of targets) {
      if (!bridge.ready) {
        rows.push({
          host: bridge.host,
          agent: agent.id,
          status: "skipped",
          durationMs: null,
          cause: "bridge not ready",
        });
        continue;
      }
      if (!agent.installed || !agent.ready) {
        rows.push({
          host: bridge.host,
          agent: agent.id,
          status: "skipped",
          durationMs: null,
          cause: agent.reason ?? (!agent.installed ? "not installed" : "not ready"),
        });
        continue;
      }
      try {
        const threadId = await this.ensureThread(registry, bridge.host, agent.id);
        runnable.push({ host: bridge.host, agent: agent.id, threadId });
      } catch (error) {
        const providerNote = this.options.providerStatus?.(agent.id);
        rows.push({
          host: bridge.host,
          agent: agent.id,
          status: "failed",
          durationMs: null,
          cause: bounded(error instanceof Error ? error.message : String(error)),
          ...(providerNote ? { providerNote } : {}),
        });
      }
    }
    rows.push(...await Promise.all(
      runnable.map(({ host, agent, threadId }) => this.runTurn(host, agent, threadId))
    ));
    rows.sort((a, b) => a.host.localeCompare(b.host) || a.agent.localeCompare(b.agent));

    if (rows.length === 0) {
      rows.push({
        host: "staging",
        agent: "inventory",
        status: "failed",
        durationMs: null,
        cause: "staging reported no connected bridges",
      });
    }

    const result: CanaryRunResult = {
      id: randomUUID(),
      target,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(this.now()).toISOString(),
      branch: inventory.branch,
      commit: inventory.commit,
      rows,
    };
    await this.appendHistory(result);
    return result;
  }

  private async ensureThread(
    registry: CanaryThreadRegistry,
    host: string,
    agent: string,
  ): Promise<string> {
    const key = threadKey(host, agent);
    const saved = registry.get(key);
    if (saved) return saved.threadId;

    const name = threadName(host, agent);
    let id = await this.options.testerBot.findThread(this.options.stagingChannelId, name);
    if (!id) {
      const initNonce = `READY-${this.makeNonce()}`;
      const posted = await this.options.testerBot.post({
        channel: this.options.stagingChannelId,
        threadName: name,
        text: `Reply with only ${initNonce}.`,
      });
      id = posted.threadId;
      const initialized = await this.waitForTurn(id, posted.messageId, initNonce);
      if (initialized.status !== "passed") {
        throw new Error(`canary thread initialization failed: ${initialized.cause}`);
      }
    }

    const switched = await this.options.testDriver.interact({
      kind: "slash",
      channelId: id,
      command: "seam",
      subcommandGroup: "config",
      subcommand: "agent",
      options: { id: `${agent}@${host}` },
    });
    const switchFailure = interactionFailure(switched);
    if (switchFailure) throw new Error(`could not configure ${agent}@${host}: ${switchFailure}`);

    const role = await this.options.testDriver.interact({
      kind: "slash",
      channelId: id,
      command: "seam",
      subcommandGroup: "config",
      subcommand: "role",
      options: { value: "canary", scope: "thread" },
    });
    const roleFailure = interactionFailure(role);
    if (roleFailure) throw new Error(`could not set canary role: ${roleFailure}`);

    await registry.set(key, {
      threadId: id,
      threadName: name,
      createdAt: new Date(this.now()).toISOString(),
    });
    return id;
  }

  private async runTurn(host: string, agent: string, threadId: string): Promise<CanaryRow> {
    const nonce = this.makeNonce();
    const started = this.now();
    const posted = await this.options.testerBot.post({
      channel: threadId,
      text: `Run the shell command \`echo ${nonce}\` and reply with only its output.`,
    });
    const outcome = await this.waitForTurn(threadId, posted.messageId, nonce);
    const durationMs = this.now() - started;
    if (outcome.status === "passed") {
      return { host, agent, status: "passed", durationMs, threadId };
    }
    const providerNote = this.options.providerStatus?.(agent);
    return {
      host,
      agent,
      status: "failed",
      durationMs,
      threadId,
      cause: outcome.cause,
      ...(providerNote ? { providerNote } : {}),
    };
  }

  private async waitForTurn(
    threadId: string,
    after: string,
    nonce: string,
  ): Promise<{ status: "passed" } | { status: "failed"; cause: string }> {
    const deadline = this.now() + this.timeoutMs;
    let lastState: CanaryMessageObservation["state"] = "unknown";
    let doneAt: number | undefined;
    while (this.now() < deadline) {
      const messages = await this.options.testerBot.read({ channel: threadId, after, limit: 100 });
      const observed = observeCanaryMessages(messages, nonce);
      lastState = observed.state;
      if (observed.state === "failed" || observed.state === "timed_out") {
        return {
          status: "failed",
          cause: observed.cause ?? `status card finished ${observed.state.replace("_", " ")}`,
        };
      }
      if (observed.state === "done" && observed.nonceSeen) return { status: "passed" };
      if (observed.state === "done") {
        doneAt ??= this.now();
        if (this.now() - doneAt >= Math.max(5_000, this.pollMs * 2)) {
          return { status: "failed", cause: "status card finished Done, but no reply contained the nonce" };
        }
      }
      await this.sleep(Math.min(this.pollMs, Math.max(0, deadline - this.now())));
    }
    return {
      status: "failed",
      cause: `timed out after ${Math.round(this.timeoutMs / 1000)}s; last state seen: ${lastState}`,
    };
  }

  private async appendHistory(result: CanaryRunResult): Promise<void> {
    await fs.mkdir(this.options.dataDir, { recursive: true });
    await fs.appendFile(
      path.join(this.options.dataDir, HISTORY_FILE),
      JSON.stringify(result) + "\n",
      { mode: 0o600 },
    );
  }
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

function rowIcon(status: CanaryRowStatus): string {
  if (status === "passed") return "✅";
  if (status === "skipped") return "⏭️";
  return "❌";
}

export function formatCanaryResult(result: CanaryRunResult): string {
  const failed = result.rows.filter((row) => row.status === "failed").length;
  const skipped = result.rows.filter((row) => row.status === "skipped").length;
  const state = failed > 0 ? "RED" : "GREEN";
  const rows = result.rows.map((row) => {
    const detail = row.cause ? ` — ${row.cause}` : "";
    const provider = row.providerNote ? ` Provider: ${row.providerNote}` : "";
    return `${rowIcon(row.status)} ${row.host}@${row.agent} · ${formatDuration(row.durationMs)}${detail}${provider}`;
  });
  return [
    `Staging canary: ${state} (${failed} failed, ${skipped} skipped)`,
    `Revision: ${result.branch} @ ${result.commit.slice(0, 12)}`,
    ...rows,
  ].join("\n");
}

export function renderCanaryLayout(result: CanaryRunResult): StructuredLayout {
  const failed = result.rows.some((row) => row.status === "failed");
  const passed = result.rows.filter((row) => row.status === "passed").length;
  const skipped = result.rows.filter((row) => row.status === "skipped").length;
  const header = failed ? "❌ Staging canary — RED" : "✅ Staging canary — GREEN";
  const blocks: StructuredLayout["blocks"] = [
    {
      kind: "text",
      content:
        `## ${header}\n` +
        `**Revision:** \`${result.branch}\` @ \`${result.commit.slice(0, 12)}\`\n` +
        `**Run:** ${result.id.slice(0, 8)} · ${passed} passed · ${skipped} skipped`,
    },
    { kind: "separator", spacing: "small" },
  ];
  for (const row of result.rows) {
    const thread = row.threadId ? ` · <#${row.threadId}>` : "";
    const cause = row.cause ? `\n↳ ${bounded(row.cause)}` : "";
    const provider = row.providerNote ? `\n↳ Provider: ${bounded(row.providerNote)}` : "";
    blocks.push({
      kind: "text",
      content:
        `${rowIcon(row.status)} **${row.host}@${row.agent}** · ${formatDuration(row.durationMs)}${thread}` +
        cause +
        provider,
    });
  }
  blocks.push(
    { kind: "separator", spacing: "small" },
    { kind: "text", content: `Completed <t:${Math.floor(Date.parse(result.finishedAt) / 1000)}:R>` },
  );
  return { color: failed ? 0xed4245 : 0x57f287, blocks };
}

export async function publishCanaryCard(options: {
  result: CanaryRunResult;
  adapter: Pick<ChatAdapter, "sendLayout" | "pinMessage" | "unpinMessage">;
  channelId: string;
  dataDir: string;
  logger: Logger;
}): Promise<MessageRef> {
  if (!options.adapter.sendLayout) throw new Error("adapter cannot post canary result cards");
  const channel = { platform: "discord", id: options.channelId };
  const message = await options.adapter.sendLayout(channel, renderCanaryLayout(options.result));
  await options.adapter.pinMessage?.(message).catch((error) => {
    options.logger.warn({ error }, "canary latest-card pin failed");
  });

  const file = path.join(options.dataDir, LATEST_CARD_FILE);
  let previous: MessageRef | undefined;
  try {
    previous = JSON.parse(await fs.readFile(file, "utf8")) as MessageRef;
  } catch {
    previous = undefined;
  }
  await fs.mkdir(options.dataDir, { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(message) + "\n", { mode: 0o600 });
  await fs.rename(temp, file);
  if (previous && previous.id !== message.id) {
    await options.adapter.unpinMessage?.(previous).catch((error) => {
      options.logger.warn({ error }, "canary previous-card unpin failed");
    });
  }
  return message;
}

export function providerSourceForAgent(agentId: string): string | undefined {
  if (agentId === "claude" || agentId.startsWith("claude-")) return "anthropic";
  if (agentId === "codex" || agentId === "copilot" || agentId.startsWith("copilot-")) return "openai";
  if (agentId === "grok") return "xai";
  if (agentId === "agy") return "google-ai-studio";
  return undefined;
}

export function canaryTargets(inventory: TestInventory): string[] {
  return inventory.bridges.flatMap((bridge) =>
    bridge.agents.map((agent) => `${bridge.host}@${agent.id}`)
  );
}
