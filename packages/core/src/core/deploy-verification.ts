import fs from "node:fs/promises";
import path from "node:path";
import type { BootObservation, ControllerIdentity } from "../lib/boot-observation.js";
import type { BridgeUpdaterHandle, BridgeReleaseFacts } from "./bridge-updater.js";
import type { CanaryRow, CanaryRunResult } from "./canary.js";

export const DEPLOY_REQUEST_FILE = "deploy-canary-request.json";
export const DEPLOY_RESULT_FILE = "deploy-canary-result.json";
export const DEPLOY_WAIT_MS = 15 * 60_000;

export interface DeployRequest {
  id: string;
  previous: ControllerIdentity;
  branch: string;
  commit: string;
  startedAt: string;
}

export const sameController = (a: ControllerIdentity, b: ControllerIdentity): boolean =>
  a.pid === b.pid && a.started === b.started;

export async function writeDeployFile(dataDir: string, file: string, value: unknown): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  const dest = path.join(dataDir, file);
  const temp = `${dest}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value) + "\n");
  await fs.rename(temp, dest);
}

export async function readDeployFile<T>(dataDir: string, file: string): Promise<T | undefined> {
  try { return JSON.parse(await fs.readFile(path.join(dataDir, file), "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function deployBootRows(request: DeployRequest, boot: BootObservation, health: boolean): CanaryRow[] {
  const row = (check: string, passed: boolean, cause: string): CanaryRow => ({
    host: "controller", agent: "deploy", check, status: passed ? "passed" : "failed", durationMs: null, cause,
  });
  return [
    row("identity", !sameController(request.previous, boot.identity) && boot.identity.started !== "unknown"
      && request.previous.started !== "unknown" && boot.commit === request.commit,
      `${request.previous.pid} (${request.previous.started}) → ${boot.identity.pid} (${boot.identity.started}); revision ${boot.commit} (requested ${request.commit})`),
    row("health", health, health ? "/health: ok" : "/health did not return ok"),
    row("ready", !!boot.readyAt, boot.readyAt ? `seam-acp ready at ${boot.readyAt}` : "seam-acp ready was not reached"),
    row("boot logs", boot.errorCount === 0, boot.errorCount === 0 ? "zero level 50/60 between boot and ready"
      : `${boot.errorCount} level 50/60 logs between boot and ready:\n${boot.errors.join("\n")}`),
  ];
}

/** Observe the reconnect updater; do not launch a second rollout or retry loop. */
export async function deployFleetRows(options: {
  updater: BridgeUpdaterHandle;
  get: (id: string) => BridgeReleaseFacts | undefined;
  commit: string;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<CanaryRow[]> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (options.timeoutMs ?? DEPLOY_WAIT_MS);
  const settled = () => options.updater.targets.every(target => target.excluded ||
    options.updater.observations().some(observed => observed.bridgeId === target.bridgeId &&
      (!["updated", "current"].includes(observed.outcome) ||
        (options.get(target.bridgeId)?.releaseSha === options.commit &&
          options.get(target.bridgeId)?.sessiond?.releaseSha === options.commit))));
  while (!settled() && now() < deadline) await sleep(Math.min(1000, deadline - now()));
  const observations = options.updater.observations();
  const rows: CanaryRow[] = options.updater.targets.map(target => {
    const observed = observations.find(item => item.bridgeId === target.bridgeId);
    const bridge = options.get(target.bridgeId);
    const released = observed && ["updated", "current"].includes(observed.outcome);
    const cause = target.excluded ? `skipped: ${target.excluded}`
      : !bridge || !observed ? "unverified: managed host missing from reconnect inventory"
      : released && (bridge?.releaseSha !== options.commit || bridge?.sessiond?.releaseSha !== options.commit)
        ? `unverified: updater reported ${observed.outcome}, but matching bridge/sessiond reconnect has not arrived`
        : [observed.outcome, observed.cause].filter(Boolean).join(": ");
    return { host: target.bridgeId, agent: "reconnect", check: "fleet update", durationMs: null,
      status: cause.startsWith("skipped:") ? "skipped"
        : cause.startsWith("unverified:") || observed?.cause || observed?.outcome.startsWith("failed") ? "failed" : "passed",
      cause };
  });
  if (options.updater.error) rows.push({ host: "fleet", agent: "reconnect", status: "failed", durationMs: null,
    cause: `unverified: reconnect target inventory unavailable: ${options.updater.error}` });
  return rows;
}

export async function verifyDeploy(options: {
  request: DeployRequest;
  boot: BootObservation;
  health: () => Promise<boolean>;
  fleet: () => Promise<CanaryRow[]>;
  probe: () => Promise<CanaryRunResult>;
}): Promise<CanaryRunResult> {
  const { request, boot } = options;
  let health = false;
  let healthError: string | undefined;
  try { health = await options.health(); }
  catch (error) { healthError = error instanceof Error ? error.message : String(error); }
  const rows = deployBootRows(request, boot, health);
  if (healthError) rows.find(row => row.check === "health")!.cause = healthError;
  try { rows.push(...await options.fleet()); }
  catch (error) { rows.push({ host: "fleet", agent: "reconnect", status: "failed", durationMs: null, cause: String(error) }); }
  try {
    const probed = await options.probe();
    rows.push(...probed.rows);
    if (!probed.rows.some(row => row.status === "passed")) rows.push({ host: "self", agent: "inventory",
      status: "failed", durationMs: null, cause: "no real canary turn passed" });
  } catch (error) {
    rows.push({ host: "self", agent: "canary", status: "failed", durationMs: null, cause: String(error) });
  }
  return { id: request.id, target: "self", branch: boot.branch, commit: boot.commit,
    startedAt: request.startedAt, finishedAt: new Date().toISOString(), rows,
    deploy: { requestId: request.id, previous: request.previous, controller: boot.identity } };
}
