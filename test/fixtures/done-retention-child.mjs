// Owned, zero-provider crash fixture. Imports the actual shipped components;
// the only substitute is a recording delivery sink instead of Discord.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pino } from "pino";

const [repo, dataDir, phase, variant = "src"] = process.argv.slice(2);
const extension = variant === "dist" ? "js" : "ts";
const load = (file) => import(pathToFileURL(path.join(repo, "packages/core", variant, `${file}.${extension}`)).href);
const { SessionStore } = await load("core/session-store");
const { DispatchWatcher } = await load("core/dispatch/watcher");
const { projectAttemptCompletions } = await load("core/dispatch/attempt-recovery");
const { reconcileCompletedDoneFiles } = await load("core/dispatch/done-reconcile");
const { pruneDoneArtifacts } = await load("core/dispatch/done-retention");
const { dispatchDirs } = await load("core/dispatch/types");
const logger = pino({ level: "silent" });
const store = new SessionStore(path.join(dataDir, "seam.db"));
const id = "crash-before-delivery";
const dirs = dispatchDirs(dataDir);
const spec = { id, kind: "wake", target: "disposable-target", session: "live", prompt: "synthetic original task: never replay" };
const outcome = { id, kind: "wake", target: spec.target, status: "completed", output: "captured synthetic output", finishedUtc: new Date().toISOString() };

if (phase === "produce") {
  store.recordDelegation({ id, kind: "wake", status: "running" });
  store.turnAttempts.registerOwner("disposable-producer");
  const a = store.turnAttempts.claim(spec, "fixture", "disposable-producer");
  await mkdir(dirs.pending, { recursive: true });
  await writeFile(path.join(dirs.pending, `${id}.json`), JSON.stringify(spec));
  const watcher = new DispatchWatcher({ dataDir, logger,
    onDispatch: async () => {
      await writeFile(path.join(dataDir, "execution-count"), "1");
      store.turnAttempts.complete(a, outcome);
      return { output: outcome.output, stopReason: "end_turn" };
    },
    onResultPublished: async () => {
      process.send?.({ event: "result-produced" });
      // Hold the actual writer after durable result publication and before
      // any delivery. The parent kills only this owned disposable process.
      await new Promise(() => { setInterval(() => {}, 1000); });
    },
  });
  await watcher.start();
} else {
  await projectAttemptCompletions(dataDir, store.turnAttempts);
  const result = await reconcileCompletedDoneFiles({ dataDir, logger,
    abandonUnprovable: (key, reason) => store.abandonUnprovableDelivery(key, reason),
    getDelegation: (key) => store.getDelegation(key),
    listRecoveryCandidates: (after, limit) => store.listNonTerminalDelegations(after, limit),
    replay: async (saved) => {
      await writeFile(path.join(dataDir, "delivery-sink.json"), JSON.stringify({ id: saved.id, output: saved.output }));
      store.turnAttempts.markDeliveryDone(saved.id);
      store.updateDelegationStatus(saved.id, "completed");
    },
  });
  const pruned = await pruneDoneArtifacts({ dataDir, logger,
    isDeliveryResolved: (key) => store.turnAttempts.get(key)?.deliveryDone === true,
  });
  store.close();
  process.send?.({ event: "recovered", reconciled: result.reconciled, pruned: pruned.pruned,
    executionCount: await readFile(path.join(dataDir, "execution-count"), "utf8") });
  process.disconnect?.();
}
