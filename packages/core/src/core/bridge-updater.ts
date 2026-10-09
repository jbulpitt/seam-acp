import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { BridgeHub } from "./bridge-hub.js";

const runFile = promisify(execFile);

export interface BridgeReleaseFacts {
  releaseSha: string | null;
  sessiond?: { releaseSha: string | null } | null;
}

export interface BridgeUpdateObservation { bridgeId: string; outcome: string; cause?: string }
export interface BridgeUpdaterHandle {
  (): void;
  idle(): Promise<void>;
  targets: Array<{ bridgeId: string; excluded?: string }>;
  observations(): BridgeUpdateObservation[];
  error?: string;
}

export function createBridgeUpdater(options: {
  currentSha: string;
  get: (id: string) => BridgeReleaseFacts | undefined;
  managed: (id: string) => string | undefined;
  older: (sha: string) => Promise<boolean>;
  rollout: (id: string) => Promise<void>;
  report: (id: string, outcome: string, error?: unknown) => void;
}) {
  let pending: Promise<void> = Promise.resolve();
  const updating = new Set<string>();
  const observations = new Map<string, BridgeUpdateObservation>();
  const report = (bridgeId: string, outcome: string, error?: unknown): void => {
    observations.set(bridgeId, { bridgeId, outcome,
      ...(error === undefined ? {} : { cause: error instanceof Error ? error.message : String(error) }) });
    if (error === undefined) options.report(bridgeId, outcome);
    else options.report(bridgeId, outcome, error);
  };
  function onReady(id: string): void {
    if (updating.has(id)) return;
    const excluded = options.managed(id);
    if (excluded) { report(id, `skipped: ${excluded}`); return; }
    observations.delete(id);
    updating.add(id);
    pending = pending.then(async () => {
      const bridge = options.get(id);
      if (!bridge) { report(id, "skipped: disconnected"); return; }
      if (bridge.releaseSha === options.currentSha && bridge.sessiond?.releaseSha === options.currentSha) {
        report(id, "current"); return;
      }
      // Hosts roll before the controller; neither process should roll back.
      for (const [component, sha] of [["bridge", bridge.releaseSha], ["sessiond", bridge.sessiond?.releaseSha]] as const) {
        if (sha && sha !== options.currentSha && !await options.older(sha)) {
          report(id, `skipped: ${component} release is not older than the controller`); return;
        }
      }
      await options.rollout(id);
      report(id, "updated");
    }).catch(error => report(id, "failed; retry on next connection", error))
      .finally(() => updating.delete(id));
  }
  return { onReady, idle: () => pending, observations: () => [...observations.values()] };
}

export async function installBridgeUpdater(hub: BridgeHub, logger: Logger, repoRoot = process.cwd()): Promise<BridgeUpdaterHandle> {
  let targets: Map<string, { rolloutEnabled: boolean; unmanagedReason?: string }>;
  let currentSha: string;
  try {
    const targetLib = await import(pathToFileURL(path.join(repoRoot, "scripts/lib/bridge-targets.mjs")).href);
    const rolloutLib = await import(pathToFileURL(path.join(repoRoot, "scripts/lib/bridge-rollout.mjs")).href);
    targets = await rolloutLib.loadTargetMap(targetLib.resolveBridgeTargetsFile(repoRoot));
    currentSha = (await runFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
  } catch (err) {
    logger.warn({ err }, "bridge reconnect updater could not read the release/target map");
    return Object.assign(() => {}, { idle: async () => {}, targets: [], observations: () => [],
      error: err instanceof Error ? err.message : String(err) });
  }
  const updater = createBridgeUpdater({
    currentSha,
    get: id => hub.get(id),
    managed: id => {
      const target = targets.get(id);
      return !target ? "no managed target" : target.rolloutEnabled ? undefined : target.unmanagedReason ?? "rollout excluded";
    },
    older: async sha => {
      try {
        await runFile("git", ["merge-base", "--is-ancestor", sha, currentSha], { cwd: repoRoot });
        return true;
      } catch (error) {
        if ((error as { code?: number }).code === 1) return false;
        throw error;
      }
    },
    rollout: id => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        path.join(repoRoot, "scripts/bridge-rollout.mjs"), "--target", id, "--rollout", "--apply", "--auto-enroll",
      ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      child.stdout.on("data", line => logger.info({ bridgeId: id, output: line.toString().trimEnd() }, "bridge rollout"));
      child.stderr.on("data", line => {
        stderr = (stderr + line.toString()).slice(-65_536);
        logger.warn({ bridgeId: id, output: line.toString().trimEnd() }, "bridge rollout");
      });
      child.once("error", reject);
      child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`bridge rollout exited: code=${code}, signal=${signal}: ${stderr.trimEnd()}`)));
    }),
    report: (bridgeId, outcome, err) => {
      if (err) logger.warn({ bridgeId, err, outcome }, "bridge reconnect update");
      else logger.info({ bridgeId, outcome }, "bridge reconnect update");
    },
  });
  const stop = hub.onBridgeReady(updater.onReady);
  for (const bridge of hub.listConnected()) updater.onReady(bridge.bridgeId);
  return Object.assign(stop, { idle: updater.idle, observations: updater.observations,
    targets: [...targets].map(([bridgeId, target]) => ({ bridgeId,
      ...(!target.rolloutEnabled ? { excluded: target.unmanagedReason ?? "rollout excluded" } : {}) })) });
}
