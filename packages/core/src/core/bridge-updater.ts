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
  function onReady(id: string): void {
    if (updating.has(id)) return;
    const excluded = options.managed(id);
    if (excluded) { options.report(id, `skipped: ${excluded}`); return; }
    updating.add(id);
    pending = pending.then(async () => {
      const bridge = options.get(id);
      if (!bridge) { options.report(id, "skipped: disconnected"); return; }
      if (bridge.releaseSha === options.currentSha && bridge.sessiond?.releaseSha === options.currentSha) {
        options.report(id, "current"); return;
      }
      // Bridges roll before the controller; a newer bridge must not roll back.
      if (bridge.releaseSha && bridge.releaseSha !== options.currentSha && !await options.older(bridge.releaseSha)) {
        options.report(id, "skipped: bridge release is not older than the controller"); return;
      }
      await options.rollout(id);
      options.report(id, "updated");
    }).catch(error => options.report(id, "failed; retry on next connection", error))
      .finally(() => updating.delete(id));
  }
  return { onReady, idle: () => pending };
}

export async function installBridgeUpdater(hub: BridgeHub, logger: Logger, repoRoot = process.cwd()): Promise<() => void> {
  let targets: Map<string, { rolloutEnabled: boolean; unmanagedReason?: string }>;
  let currentSha: string;
  try {
    const targetLib = await import(pathToFileURL(path.join(repoRoot, "scripts/lib/bridge-targets.mjs")).href);
    const rolloutLib = await import(pathToFileURL(path.join(repoRoot, "scripts/lib/bridge-rollout.mjs")).href);
    targets = await rolloutLib.loadTargetMap(targetLib.resolveBridgeTargetsFile(repoRoot));
    currentSha = (await runFile("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
  } catch (err) {
    logger.warn({ err }, "bridge reconnect updater could not read the release/target map");
    return () => {};
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
  return stop;
}
