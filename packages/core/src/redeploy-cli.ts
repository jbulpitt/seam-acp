#!/usr/bin/env node
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { MessageFlags, REST, Routes } from "discord.js";
import { readProcessIdentity } from "@seam/adapters";
import { processOwner, isProcessOwner } from "./core/dispatch/process-owner.js";
import { writeRestartSentinel } from "./core/restart-sentinel.js";
import { canaryIsGreen, formatCanaryResult, publishCanaryCard, readGitIdentity, type CanaryRunResult } from "./core/canary.js";
import { DEPLOY_REQUEST_FILE, DEPLOY_RESULT_FILE, DEPLOY_WAIT_MS, deployBootRows, readDeployFile,
  sameController, writeDeployFile, type DeployRequest } from "./core/deploy-verification.js";
import { BOOT_OBSERVATION_FILE, type BootObservation, type ControllerIdentity } from "./lib/boot-observation.js";
import { DiscordAdapter } from "./platforms/discord/adapter.js";
import { discordMessageLink } from "./platforms/discord/message-link.js";
import { logger } from "./lib/logger.js";

export interface DeployHealth { status: string; controller?: BootObservation }
async function readHealth(): Promise<DeployHealth> {
  const response = await fetch(`http://127.0.0.1:${process.env.HEALTH_PORT ?? 3000}/health`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`/health: HTTP ${response.status}`);
  return await response.json() as DeployHealth;
}

/** The first verified deploy upgrades a controller without identity in /health. */
export async function legacyControllerIdentity(dataDir: string, repoRoot: string): Promise<ControllerIdentity> {
  const db = new Database(path.join(dataDir, "seam.db"), { readonly: true, fileMustExist: true });
  const identities = new Map<number, ControllerIdentity>();
  try {
    const owners = db.prepare("SELECT process_json FROM turn_attempt_owners").all() as Array<{ process_json: string }>;
    for (const row of owners) {
      const owner: unknown = JSON.parse(row.process_json);
      if (!isProcessOwner(owner)) continue;
      const current = processOwner(owner.pid);
      if (!current || current.host !== owner.host || current.boot !== owner.boot || current.start !== owner.start) continue;
      try {
        if (await fs.realpath(`/proc/${owner.pid}/cwd`) !== await fs.realpath(repoRoot)) continue;
        const identity = readProcessIdentity(owner.pid);
        if (identity) identities.set(owner.pid, { pid: owner.pid, started: identity.started });
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  } finally { db.close(); }
  if (identities.size !== 1) throw new Error(`cannot identify the existing controller from recorded process owners: ${identities.size} live matches`);
  return [...identities.values()][0]!;
}

export async function waitForDeployResult(options: {
  request: DeployRequest;
  health: () => Promise<DeployHealth>;
  result: () => Promise<CanaryRunResult | undefined>;
  boot: () => Promise<BootObservation | undefined>;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<CanaryRunResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? 2 * DEPLOY_WAIT_MS + 5 * 60_000);
  let health: DeployHealth | undefined;
  let lastError = "new controller has not answered /health";
  while (now() < deadline) {
    const result = await options.result();
    try { health = await options.health(); }
    catch (error) { health = undefined; lastError = error instanceof Error ? error.message : String(error); }
    if (result?.deploy?.requestId === options.request.id && sameController(result.deploy.previous, options.request.previous) &&
      !sameController(result.deploy.controller, options.request.previous)) {
      if (!health?.controller || !sameController(health.controller.identity, result.deploy.controller) || health.status !== "ok") {
        result.rows.push({ host: "controller", agent: "deploy", check: "final health", status: "failed", durationMs: null,
          cause: health ? "final /health does not describe the verified controller" : lastError });
      }
      return result;
    }
    await sleep(Math.min(1000, deadline - now()));
  }
  const boot = health?.controller ?? await options.boot();
  return { id: options.request.id, target: "self", branch: options.request.branch,
    commit: options.request.commit, startedAt: options.request.startedAt,
    finishedAt: new Date(now()).toISOString(),
    ...(boot ? { deploy: { requestId: options.request.id, previous: options.request.previous, controller: boot.identity } } : {}),
    rows: [
      ...(boot && !sameController(boot.identity, options.request.previous)
        ? deployBootRows(options.request, boot, health?.status === "ok") : []),
      { host: "controller", agent: "deploy", status: "failed", durationMs: null,
        cause: `deploy verification did not finish within ${Math.round((options.timeoutMs ?? 2 * DEPLOY_WAIT_MS + 5 * 60_000) / 1000)}s; ${health ? `last controller ${health.controller?.identity.pid ?? "unknown"}, ready ${health.controller?.readyAt ?? "not reached"}` : lastError}` },
    ] };
}

export async function publishDeployCard(result: CanaryRunResult, dataDir: string, channelId: string,
  rest: Pick<REST, "get" | "post" | "put" | "delete">): Promise<CanaryRunResult> {
  return publishCanaryCard({ result, dataDir, channelId, logger,
    adapter: {
      sendLayout: async (channel, layout) => {
        const destination = await rest.get(Routes.channel(channel.id)) as { guild_id?: string };
        const message = await rest.post(Routes.channelMessages(channel.id), { body: {
          flags: MessageFlags.IsComponentsV2, components: [DiscordAdapter.buildContainer(layout).toJSON()],
        } }) as { id: string };
        return { channel, id: message.id, ...discordMessageLink(destination.guild_id, channel.id, message.id) };
      },
      pinMessage: async message => { await rest.put(Routes.channelPin(message.channel.id, message.id)); },
      unpinMessage: async message => { await rest.delete(Routes.channelPin(message.channel.id, message.id)); },
    } });
}

async function publish(result: CanaryRunResult, dataDir: string): Promise<CanaryRunResult> {
  const channelId = process.env.SEAM_CANARY_SELF_CHANNEL_ID ?? process.env.SEAM_CANARY_RESULT_CHANNEL_ID;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!channelId || !token) return { ...result, cardError: "canary destination or DISCORD_BOT_TOKEN is not configured" };
  const rest = new REST({ version: "10" }).setToken(token);
  return publishDeployCard(result, dataDir, channelId, rest);
}

async function main(): Promise<void> {
  const dataDir = path.resolve(process.env.DATA_DIR || "data");
  // Staging automation is separate; keep its existing sentinel-only behaviour.
  if (process.env.SEAM_TEST_DRIVER_ACTOR_ID) {
    writeRestartSentinel(dataDir);
    console.log("Build complete — restart sentinel written (staging; production verification not run)");
    return;
  }
  const revision = readGitIdentity();
  let request: DeployRequest | undefined;
  let result: CanaryRunResult;
  try {
    const health = await readHealth();
    const previous = health.controller?.identity ?? await legacyControllerIdentity(dataDir, process.cwd());
    request = { id: randomUUID(), previous, ...revision, startedAt: new Date().toISOString() };
    await writeDeployFile(dataDir, DEPLOY_REQUEST_FILE, request);
    writeRestartSentinel(dataDir);
    console.log(`Restart sentinel written; verifying ${revision.commit} after controller ${previous.pid} (${previous.started}).`);
    result = await waitForDeployResult({ request, health: readHealth,
      result: () => readDeployFile(dataDir, DEPLOY_RESULT_FILE),
      boot: () => readDeployFile(dataDir, BOOT_OBSERVATION_FILE) });
    // A boot that never completed still names every target not verified.
    if (!result.rows.some(row => row.check === "fleet update")) {
      try {
        const targetsLib = await import(pathToFileURL(path.join(process.cwd(), "scripts/lib/bridge-targets.mjs")).href);
        const rolloutLib = await import(pathToFileURL(path.join(process.cwd(), "scripts/lib/bridge-rollout.mjs")).href);
        const targets = await rolloutLib.loadTargetMap(targetsLib.resolveBridgeTargetsFile(process.cwd())) as Map<string, { rolloutEnabled: boolean; unmanagedReason?: string }>;
        for (const [host, target] of targets) result.rows.push({ host, agent: "reconnect", check: "fleet update", durationMs: null,
          status: target.rolloutEnabled ? "failed" : "skipped",
          cause: target.rolloutEnabled ? "unverified: controller did not report reconnect outcome" : `skipped: ${target.unmanagedReason ?? "rollout excluded"}` });
      } catch (error) {
        result.rows.push({ host: "fleet", agent: "reconnect", status: "failed", durationMs: null,
          cause: `unverified: reconnect target inventory unavailable: ${String(error)}` });
      }
    }
  } catch (error) {
    result = { id: request?.id ?? randomUUID(), target: "self", ...revision,
      startedAt: request?.startedAt ?? new Date().toISOString(), finishedAt: new Date().toISOString(),
      rows: [{ host: "controller", agent: "deploy", status: "failed", durationMs: null,
        cause: error instanceof Error ? error.message : String(error) }] };
  }
  result = await publish(result, dataDir);
  console.log(formatCanaryResult(result));
  await writeDeployFile(dataDir, DEPLOY_RESULT_FILE, result);
  await fs.appendFile(path.join(dataDir, "canary-self-history.jsonl"), JSON.stringify(result) + "\n");
  if (!canaryIsGreen(result)) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
