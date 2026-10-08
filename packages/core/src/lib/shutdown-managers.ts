/**
 * Store-writing manager drains for SIGTERM (#192).
 *
 * Factored out of `index.ts` so tests can run the production drain set without
 * importing `main()`. `index.ts` still decides WHEN this runs (after HTTP
 * ingress drain, before pre-dispose quiesce).
 */
import type { DrainVerdict } from "./shutdown-budget.js";

export interface DrainableManager {
  drain(): Promise<void>;
}

export interface StoreWritingManagers {
  scheduled: DrainableManager;
  wake: DrainableManager;
  watch: DrainableManager;
  parked: DrainableManager;
  modelIntelligence?: DrainableManager;
  plugins?: DrainableManager;
}

export const MANAGER_CALLBACKS_STAGE = "manager-callbacks";
export const MODEL_INTELLIGENCE_REFRESH_STAGE = "model-intelligence-refresh";

/**
 * Await every store-writing manager drain under one bounded group, then
 * report the model-intelligence refresh as its own verdict.
 */
export async function drainStoreWritingManagers(
  managers: StoreWritingManagers,
  runGroup: (label: string, work: () => Promise<unknown>) => Promise<boolean>
): Promise<DrainVerdict[]> {
  let intelligenceOk = false;
  const groupOk = await runGroup("manager callbacks", async () => {
    await Promise.all([
      managers.scheduled.drain(),
      managers.wake.drain(),
      managers.watch.drain(),
      managers.parked.drain(),
      managers.plugins?.drain() ?? Promise.resolve(),
      managers.modelIntelligence?.drain().then(() => {
        intelligenceOk = true;
      }) ?? Promise.resolve(),
    ]);
  });
  return [
    { stage: MANAGER_CALLBACKS_STAGE, drained: groupOk },
    ...(managers.modelIntelligence ? [{ stage: MODEL_INTELLIGENCE_REFRESH_STAGE, drained: groupOk && intelligenceOk }] : []),
  ];
}
