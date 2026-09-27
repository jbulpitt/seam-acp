import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../lib/logger.js";
import type { ChatAdapter, MessageRef } from "../platforms/chat-adapter.js";
import type { StructuredLayout } from "./types.js";
import { TOOL_ACTIVITY_EMOJIS } from "../platforms/discord/renderer.js";
import type {
  TestDriverClient,
  TestInventory,
  TestRestartAction,
} from "./test-driver.js";
import type { TesterBot, TesterMessage } from "./tester-bot.js";

export type CanaryTarget = "staging" | "self";
export type CanaryRowStatus = "passed" | "failed" | "skipped";

export interface CanaryRow {
  host: string;
  agent: string;
  check?: string;
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
  durability?: boolean;
  rows: CanaryRow[];
  cardError?: string;
}

export interface CanaryRunOptions {
  durability?: boolean;
}

export interface CanaryMessageObservation {
  state: "working" | "done" | "failed" | "timed_out" | "unknown";
  nonceSeen: boolean;
  toolSeen: boolean;
  cause?: string;
}

export interface DurabilityOutputObservation {
  missing: string[];
  duplicated: Array<{ line: string; count: number }>;
  observed: string[];
  inOrder: boolean;
  replyCount: number;
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
  testDriver: Pick<TestDriverClient, "interact" | "inventory" | "health" | "restart">;
  dataDir: string;
  stagingChannelId: string;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  nonce?: () => string;
  providerStatus?: (agentId: string) => string | undefined;
  durabilityAgentId?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 2_000;
const THREAD_FILE = "canary-staging-threads.json";
const HISTORY_FILE = "canary-staging-history.jsonl";
const LATEST_CARD_FILE = "canary-staging-latest-card.json";
const DURABILITY_AGENT = "codex";


export interface SelfCanaryInventory {
  bridges: Array<{
    host: string;
    ready: boolean;
    agents: Array<{
      id: string;
      installed: boolean;
      ready: boolean;
      reason?: string;
    }>;
  }>;
}

export interface SelfCanaryDispatchResult {
  output: string;
  deliveredOutput: string;
  toolSeen: boolean;
  statusCardDone: boolean;
}

interface SelfCanaryRunnerOptions {
  dataDir: string;
  inventory: () => SelfCanaryInventory;
  createThread: (host: string, agent: string, name: string) => Promise<string>;
  threadExists: (threadId: string) => Promise<boolean>;
  dispatchTurn: (
    threadId: string,
    prompt: string,
    dispatchId: string,
  ) => Promise<SelfCanaryDispatchResult>;
  now?: () => number;
  nonce?: () => string;
  providerStatus?: (agentId: string) => string | undefined;
}

const DURABILITY_CHECKS: ReadonlyArray<{ label: string; action: TestRestartAction }> = [
  { label: "redeploy", action: "controller" },
  { label: "bridge restart", action: "bridge" },
  { label: "controller + bridge", action: "controller_bridge" },
  { label: "sessiond restart", action: "sessiond" },
];

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
  const statusEntries = botMessages.flatMap((message) => [
    ...message.embeds,
    ...(message.components ?? []),
  ]);
  const statusText = statusEntries.join("\n");
  const statusHeads = statusEntries.map((entry) =>
    entry.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ""
  );
  const nonceSeen = botMessages.some((message) => message.content.includes(nonce));
  const toolSeen = /\bTool\s*:\s*\S/i.test(statusText)
    || TOOL_ACTIVITY_EMOJIS.some((emoji) => statusText.includes(`\`${emoji}`));
  if (statusHeads.some((head) => /^(?:❌\s*)?Failed\b/i.test(head))) {
    return { state: "failed", nonceSeen, toolSeen, cause: failureCause(botMessages) };
  }
  if (statusHeads.some((head) => /^(?:⏱️\s*)?(?:Timed out|Timeout)\b/i.test(head))) {
    return { state: "timed_out", nonceSeen, toolSeen, cause: failureCause(botMessages) };
  }
  if (statusHeads.some((head) => /^(?:✅\s*)?Done\b/i.test(head))) {
    return { state: "done", nonceSeen, toolSeen };
  }
  if (statusHeads.some((head) => /^(?:Working|Waiting|Reconnecting|Monitoring)\b/i.test(head))) {
    return { state: "working", nonceSeen, toolSeen };
  }
  return { state: "unknown", nonceSeen, toolSeen };
}

export function observeDurabilityOutput(
  messages: TesterMessage[],
  expected: string[],
): DurabilityOutputObservation {
  const replies = messages.filter((message) =>
    message.authorIsBot && expected.some((line) => message.content.includes(line))
  );
  const seen = replies.flatMap((message) =>
    message.content.split(/\r?\n/).map((line) => line.trim()).filter((line) => expected.includes(line))
  );
  const counts = new Map(expected.map((line) => [line, 0]));
  for (const line of seen) counts.set(line, (counts.get(line) ?? 0) + 1);
  return {
    missing: expected.filter((line) => counts.get(line) === 0),
    duplicated: expected
      .map((line) => ({ line, count: counts.get(line) ?? 0 }))
      .filter(({ count }) => count > 1),
    observed: seen,
    inOrder: seen.length === expected.length && seen.every((line, index) => line === expected[index]),
    replyCount: replies.length,
  };
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

  static async load(dataDir: string, filename = THREAD_FILE): Promise<CanaryThreadRegistry> {
    const file = path.join(dataDir, filename);
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

  async run(
    target: CanaryTarget = "staging",
    runOptions: CanaryRunOptions = {},
  ): Promise<CanaryRunResult> {
    if (target !== "staging") throw new Error(`unsupported canary target: ${target}`);
    if (runOptions.durability) return this.runDurability(target);
    return this.runBasic(target);
  }

  private async runBasic(target: CanaryTarget): Promise<CanaryRunResult> {
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

  private async runDurability(target: CanaryTarget): Promise<CanaryRunResult> {
    const started = this.now();
    const inventory = await this.options.testDriver.inventory();
    const registry = await CanaryThreadRegistry.load(this.options.dataDir);
    const agentId = this.options.durabilityAgentId ?? DURABILITY_AGENT;
    const candidates = inventory.bridges
      .map((bridge) => ({ bridge, agent: bridge.agents.find((agent) => agent.id === agentId) }))
      .filter((entry) => entry.agent)
      .sort((a, b) => a.bridge.host.localeCompare(b.bridge.host));
    const selected = candidates.find(({ bridge, agent }) => bridge.ready && agent!.installed && agent!.ready);
    const rows: CanaryRow[] = [];

    if (!selected) {
      const candidate = candidates[0];
      const cause = candidate
        ? candidate.agent!.reason ?? (!candidate.bridge.ready ? "bridge not ready" : `${agentId} not ready`)
        : `${agentId} was not reported by staging`;
      for (const check of DURABILITY_CHECKS) {
        rows.push({
          host: candidate?.bridge.host ?? "staging",
          agent: agentId,
          check: check.label,
          status: "failed",
          durationMs: null,
          cause,
        });
      }
    } else {
      let threadId: string | undefined;
      try {
        threadId = await this.ensureThread(registry, selected.bridge.host, agentId);
      } catch (error) {
        const cause = bounded(error instanceof Error ? error.message : String(error));
        for (const check of DURABILITY_CHECKS) {
          rows.push({
            host: selected.bridge.host,
            agent: agentId,
            check: check.label,
            status: "failed",
            durationMs: null,
            cause,
          });
        }
      }
      if (threadId) {
        for (const check of DURABILITY_CHECKS) {
          rows.push(await this.runDurabilityTurn(
            selected.bridge.host,
            agentId,
            threadId,
            check,
          ));
        }
      }
    }

    const result: CanaryRunResult = {
      id: randomUUID(),
      target,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(this.now()).toISOString(),
      branch: inventory.branch,
      commit: inventory.commit,
      durability: true,
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
      const initialized = await this.waitForTurn(id, posted.messageId, initNonce, false);
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

  private async runDurabilityTurn(
    host: string,
    agent: string,
    threadId: string,
    check: { label: string; action: TestRestartAction },
  ): Promise<CanaryRow> {
    const nonce = this.makeNonce();
    const expected = [1, 2, 3, 4, 5, 6].map((index) => `${nonce}-${index}`);
    const started = this.now();
    const fail = (cause: string): CanaryRow => {
      const providerNote = this.options.providerStatus?.(agent);
      return {
        host,
        agent,
        check: check.label,
        status: "failed",
        durationMs: this.now() - started,
        threadId,
        cause: bounded(cause),
        ...(providerNote ? { providerNote } : {}),
      };
    };

    try {
      const before = await this.options.testDriver.inventory();
      const posted = await this.options.testerBot.post({
        channel: threadId,
        text:
          "Run the shell command " +
          `\`for i in 1 2 3 4 5 6; do echo ${nonce}-$i; sleep 5; done\` ` +
          "and reply with only the complete six-line output, in order.",
      });
      const startedTurn = await this.waitForRestartPoint(threadId, posted.messageId, nonce);
      if (startedTurn.status === "failed") return fail(startedTurn.cause);
      await this.options.testDriver.restart(check.action);
      const recovered = await this.waitForRecovery(before, host, check);
      if (recovered.status === "failed") return fail(recovered.cause);
      const outcome = await this.waitForDurabilityTurn(
        threadId,
        posted.messageId,
        nonce,
        expected,
        startedTurn.toolSeen,
      );
      if (outcome.status === "failed") return fail(outcome.cause);
      return {
        host,
        agent,
        check: check.label,
        status: "passed",
        durationMs: this.now() - started,
        threadId,
      };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }

  private async waitForRestartPoint(
    threadId: string,
    after: string,
    nonce: string,
  ): Promise<{ status: "ready"; toolSeen: true } | { status: "failed"; cause: string }> {
    const deadline = this.now() + this.timeoutMs;
    let lastState: CanaryMessageObservation["state"] = "unknown";
    while (this.now() < deadline) {
      const messages = await this.options.testerBot.read({ channel: threadId, after, limit: 100 });
      const observed = observeCanaryMessages(messages, nonce);
      lastState = observed.state;
      if (observed.state === "failed" || observed.state === "timed_out") {
        return { status: "failed", cause: observed.cause ?? `status card finished ${observed.state}` };
      }
      if (observed.state === "done") {
        return {
          status: "failed",
          cause: `status card reached Done before ${observed.toolSeen ? "" : "a tool step and "}the restart trigger`,
        };
      }
      if (observed.state === "working" && observed.toolSeen) {
        return { status: "ready", toolSeen: true };
      }
      await this.sleep(Math.min(this.pollMs, Math.max(0, deadline - this.now())));
    }
    return {
      status: "failed",
      cause: `restart was not triggered: no visible Working tool step after ${Math.round(this.timeoutMs / 1000)}s; last state seen: ${lastState}`,
    };
  }

  private async waitForRecovery(
    before: TestInventory,
    host: string,
    check: { label: string; action: TestRestartAction },
  ): Promise<{ status: "ready" } | { status: "failed"; cause: string }> {
    const deadline = this.now() + this.timeoutMs;
    const oldBridge = before.bridges.find((bridge) => bridge.host === host)?.instanceId;
    let lastCause = "staging health and inventory have not returned";
    while (this.now() < deadline) {
      try {
        await this.options.testDriver.health();
        const current = await this.options.testDriver.inventory();
        const bridge = current.bridges.find((item) => item.host === host);
        const controllerChanged = current.controllerInstanceId !== before.controllerInstanceId;
        const bridgeChanged = Boolean(bridge && oldBridge && bridge.instanceId !== oldBridge);
        const needsController = check.action === "controller" || check.action === "controller_bridge";
        const needsBridge = check.action !== "controller";
        if ((!needsController || controllerChanged) && (!needsBridge || bridgeChanged) && bridge?.ready) {
          return { status: "ready" };
        }
        const waiting = [
          ...(needsController && !controllerChanged ? ["controller instance change"] : []),
          ...(needsBridge && !bridgeChanged ? ["bridge instance change"] : []),
          ...(!bridge?.ready ? ["ready bridge inventory"] : []),
        ];
        lastCause = `waiting for ${waiting.join(", ")}`;
      } catch (error) {
        lastCause = error instanceof Error ? error.message : String(error);
      }
      await this.sleep(Math.min(this.pollMs, Math.max(0, deadline - this.now())));
    }
    return {
      status: "failed",
      cause: `${check.label} did not recover within ${Math.round(this.timeoutMs / 1000)}s: ${lastCause}`,
    };
  }

  private async waitForDurabilityTurn(
    threadId: string,
    after: string,
    nonce: string,
    expected: string[],
    toolWasSeen: boolean,
  ): Promise<{ status: "passed" } | { status: "failed"; cause: string }> {
    const deadline = this.now() + this.timeoutMs;
    let lastState: CanaryMessageObservation["state"] = "unknown";
    let toolSeen = toolWasSeen;
    while (this.now() < deadline) {
      const messages = await this.options.testerBot.read({ channel: threadId, after, limit: 100 });
      const observed = observeCanaryMessages(messages, nonce);
      const output = observeDurabilityOutput(messages, expected);
      lastState = observed.state;
      toolSeen ||= observed.toolSeen;
      if (observed.state === "failed" || observed.state === "timed_out") {
        return { status: "failed", cause: observed.cause ?? `status card finished ${observed.state}` };
      }
      if (observed.state === "done") {
        const issues: string[] = [];
        if (!toolSeen) issues.push("no tool step was visible on the status card");
        if (output.missing.length > 0) issues.push(`missing: ${output.missing.join(", ")}`);
        if (output.duplicated.length > 0) {
          issues.push(`duplicated: ${output.duplicated.map(({ line, count }) => `${line} ×${count}`).join(", ")}`);
        }
        if (!output.inOrder && output.missing.length === 0 && output.duplicated.length === 0) {
          issues.push(`out of order: ${output.observed.join(", ")}`);
        }
        if (output.replyCount > 1) issues.push(`duplicate replies: ${output.replyCount}`);
        if (issues.length === 0) return { status: "passed" };
        return { status: "failed", cause: issues.join("; ") };
      }
      await this.sleep(Math.min(this.pollMs, Math.max(0, deadline - this.now())));
    }
    const output = observeDurabilityOutput(
      await this.options.testerBot.read({ channel: threadId, after, limit: 100 }),
      expected,
    );
    const detail = output.missing.length > 0 ? `; missing: ${output.missing.join(", ")}` : "";
    return {
      status: "failed",
      cause: `timed out after ${Math.round(this.timeoutMs / 1000)}s; last state seen: ${lastState}${detail}`,
    };
  }

  private async waitForTurn(
    threadId: string,
    after: string,
    nonce: string,
    requireTool = true,
  ): Promise<{ status: "passed" } | { status: "failed"; cause: string }> {
    const deadline = this.now() + this.timeoutMs;
    let lastState: CanaryMessageObservation["state"] = "unknown";
    let doneAt: number | undefined;
    let toolSeen = false;
    while (this.now() < deadline) {
      const messages = await this.options.testerBot.read({ channel: threadId, after, limit: 100 });
      const observed = observeCanaryMessages(messages, nonce);
      lastState = observed.state;
      toolSeen ||= observed.toolSeen;
      if (observed.state === "failed" || observed.state === "timed_out") {
        return {
          status: "failed",
          cause: observed.cause ?? `status card finished ${observed.state.replace("_", " ")}`,
        };
      }
      if (observed.state === "done" && observed.nonceSeen && (!requireTool || toolSeen)) {
        return { status: "passed" };
      }
      if (observed.state === "done") {
        doneAt ??= this.now();
        if (this.now() - doneAt >= Math.max(5_000, this.pollMs * 2)) {
          const cause = !observed.nonceSeen
            ? "status card finished Done, but no reply contained the nonce"
            : "status card finished Done, but no tool step was visible";
          return { status: "failed", cause };
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

export class SelfCanaryRunner {
  private readonly now: () => number;
  private readonly makeNonce: () => string;

  constructor(private readonly options: SelfCanaryRunnerOptions) {
    this.now = options.now ?? Date.now;
    this.makeNonce = options.nonce ?? (() => randomUUID().replaceAll("-", ""));
  }

  async run(target: CanaryTarget = "self"): Promise<CanaryRunResult> {
    if (target !== "self") throw new Error(`unsupported self canary target: ${target}`);
    const started = this.now();
    const inventory = this.options.inventory();
    const registry = await CanaryThreadRegistry.load(
      this.options.dataDir,
      "canary-self-threads.json",
    );
    const targets = inventory.bridges
      .flatMap((bridge) => bridge.agents.map((agent) => ({ bridge, agent })))
      .sort((a, b) =>
        a.bridge.host.localeCompare(b.bridge.host) || a.agent.id.localeCompare(b.agent.id)
      );

    const rows: CanaryRow[] = [];
    const runnable: Array<{ host: string; agent: string; threadId: string }> = [];
    for (const { bridge, agent } of targets) {
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
        rows.push(this.failedRow(
          bridge.host,
          agent.id,
          null,
          error instanceof Error ? error.message : String(error),
        ));
      }
    }

    rows.push(...await Promise.all(
      runnable.map(({ host, agent, threadId }) => this.runTurn(host, agent, threadId))
    ));
    rows.sort((a, b) => a.host.localeCompare(b.host) || a.agent.localeCompare(b.agent));
    if (rows.length === 0) {
      rows.push({
        host: "self",
        agent: "inventory",
        status: "failed",
        durationMs: null,
        cause: "controller reported no connected bridges",
      });
    }

    const identity = readGitIdentity();
    const result: CanaryRunResult = {
      id: randomUUID(),
      target,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(this.now()).toISOString(),
      branch: identity.branch,
      commit: identity.commit,
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
    if (saved && await this.options.threadExists(saved.threadId)) return saved.threadId;

    const name = threadName(host, agent);
    const threadId = await this.options.createThread(host, agent, name);
    await registry.set(key, {
      threadId,
      threadName: name,
      createdAt: new Date(this.now()).toISOString(),
    });
    return threadId;
  }

  private async runTurn(host: string, agent: string, threadId: string): Promise<CanaryRow> {
    const nonce = this.makeNonce();
    const started = this.now();
    try {
      const result = await this.options.dispatchTurn(
        threadId,
        `Run the shell command \`echo ${nonce}\` and reply with only its output.`,
        `canary-${randomUUID()}`,
      );
      const issues: string[] = [];
      if (!result.output.includes(nonce)) issues.push("agent output did not contain the nonce");
      if (!result.deliveredOutput.includes(nonce)) {
        issues.push("no Discord reply contained the nonce");
      }
      if (!result.toolSeen) issues.push("no tool step was visible on the status card");
      if (!result.statusCardDone) issues.push("status card did not finish Done");
      if (issues.length > 0) {
        return this.failedRow(host, agent, this.now() - started, issues.join("; "), threadId);
      }
      return {
        host,
        agent,
        status: "passed",
        durationMs: this.now() - started,
        threadId,
      };
    } catch (error) {
      return this.failedRow(
        host,
        agent,
        this.now() - started,
        error instanceof Error ? error.message : String(error),
        threadId,
      );
    }
  }

  private failedRow(
    host: string,
    agent: string,
    durationMs: number | null,
    cause: string,
    threadId?: string,
  ): CanaryRow {
    const providerNote = this.options.providerStatus?.(agent);
    return {
      host,
      agent,
      status: "failed",
      durationMs,
      ...(threadId ? { threadId } : {}),
      cause: bounded(cause),
      ...(providerNote ? { providerNote } : {}),
    };
  }

  private async appendHistory(result: CanaryRunResult): Promise<void> {
    await fs.mkdir(this.options.dataDir, { recursive: true });
    await fs.appendFile(
      path.join(this.options.dataDir, "canary-self-history.jsonl"),
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

function targetLabel(target: CanaryTarget): string {
  return target === "self" ? "Self" : "Staging";
}

export function formatCanaryResult(result: CanaryRunResult): string {
  const failed = result.rows.filter((row) => row.status === "failed").length;
  const skipped = result.rows.filter((row) => row.status === "skipped").length;
  const state = failed > 0 ? "RED" : "GREEN";
  const rows = result.rows.map((row) => {
    const detail = row.cause ? ` — ${row.cause}` : "";
    const provider = row.providerNote ? ` Provider: ${row.providerNote}` : "";
    const check = row.check ? ` · ${row.check}` : "";
    return `${rowIcon(row.status)} ${row.host}@${row.agent}${check} · ${formatDuration(row.durationMs)}${detail}${provider}`;
  });
  return [
    `${targetLabel(result.target)} ${result.durability ? "durability" : "canary"}: ${state} (${failed} failed, ${skipped} skipped)`,
    `Revision: ${result.branch} @ ${result.commit.slice(0, 12)}`,
    ...rows,
    ...(result.cardError ? [`Result card error: ${result.cardError}`] : []),
  ].join("\n");
}

const MAX_CANARY_CONTAINER_BLOCKS = 40;
const CANARY_PAGE_FRAME_BLOCKS = 4;

function renderCanaryRow(row: CanaryRow): StructuredLayout["blocks"][number] {
  const thread = row.threadId ? ` · <#${row.threadId}>` : "";
  const check = row.check ? ` · ${row.check}` : "";
  const cause = row.cause ? `\n↳ ${bounded(row.cause)}` : "";
  const provider = row.providerNote ? `\n↳ Provider: ${bounded(row.providerNote)}` : "";
  return {
    kind: "text",
    content:
      `${rowIcon(row.status)} **${row.host}@${row.agent}**${check} · ${formatDuration(row.durationMs)}${thread}` +
      cause +
      provider,
  };
}

function renderSkippedRows(rows: CanaryRow[]): StructuredLayout["blocks"] {
  const byHost = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const reasons = byHost.get(row.host) ?? new Map<string, string[]>();
    const reason = row.cause ?? "not ready";
    const agents = reasons.get(reason) ?? [];
    agents.push(row.check ? `${row.agent} (${row.check})` : row.agent);
    reasons.set(reason, agents);
    byHost.set(row.host, reasons);
  }
  return [...byHost.entries()].map(([host, reasons]) => ({
    kind: "text" as const,
    content: bounded(
      `⏭️ **${host}** · ` +
        [...reasons.entries()]
          .map(([reason, agents]) => `${agents.join(", ")} — ${reason}`)
          .join(" · "),
      3_800,
    ),
  }));
}

export function renderCanaryLayouts(result: CanaryRunResult): StructuredLayout[] {
  const failed = result.rows.some((row) => row.status === "failed");
  const passed = result.rows.filter((row) => row.status === "passed").length;
  const skipped = result.rows.filter((row) => row.status === "skipped").length;
  const label = result.durability ? "durability" : "canary";
  const header = failed
    ? `❌ ${targetLabel(result.target)} ${label} — RED`
    : `✅ ${targetLabel(result.target)} ${label} — GREEN`;
  const rows = [
    ...result.rows.filter((row) => row.status !== "skipped").map(renderCanaryRow),
    ...renderSkippedRows(result.rows.filter((row) => row.status === "skipped")),
  ];
  const rowsPerPage = MAX_CANARY_CONTAINER_BLOCKS - CANARY_PAGE_FRAME_BLOCKS;
  const pageCount = Math.max(1, Math.ceil(rows.length / rowsPerPage));
  return Array.from({ length: pageCount }, (_, pageIndex) => {
    const page = pageCount > 1 ? ` · page ${pageIndex + 1}/${pageCount}` : "";
    const blocks: StructuredLayout["blocks"] = [
      {
        kind: "text",
        content:
          `## ${header}${page}\n` +
          `**Revision:** \`${result.branch}\` @ \`${result.commit.slice(0, 12)}\`\n` +
          `**Run:** ${result.id.slice(0, 8)} · ${passed} passed · ${skipped} skipped`,
      },
      { kind: "separator", spacing: "small" },
      ...rows.slice(pageIndex * rowsPerPage, (pageIndex + 1) * rowsPerPage),
      { kind: "separator", spacing: "small" },
      { kind: "text", content: `Completed <t:${Math.floor(Date.parse(result.finishedAt) / 1000)}:R>` },
    ];
    return { color: failed ? 0xed4245 : 0x57f287, blocks };
  });
}

interface CanaryCardOptions {
  result: CanaryRunResult;
  adapter: Pick<ChatAdapter, "sendLayout" | "pinMessage" | "unpinMessage">;
  channelId: string;
  dataDir: string;
  logger: Logger;
}

async function postCanaryCards(options: CanaryCardOptions): Promise<MessageRef> {
  if (!options.adapter.sendLayout) throw new Error("adapter cannot post canary result cards");
  const channel = { platform: "discord", id: options.channelId };
  const messages: MessageRef[] = [];
  for (const layout of renderCanaryLayouts(options.result)) {
    messages.push(await options.adapter.sendLayout(channel, layout));
  }
  const message = messages[0]!;
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

export async function publishCanaryCard(options: CanaryCardOptions): Promise<CanaryRunResult> {
  try {
    await postCanaryCards(options);
    return options.result;
  } catch (error) {
    const cardError = error instanceof Error ? error.message : String(error);
    options.logger.error(
      { error, canaryRunId: options.result.id },
      "canary result card failed",
    );
    return { ...options.result, cardError };
  }
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
