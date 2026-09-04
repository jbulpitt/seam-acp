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
  modelMetadata: DrainableManager;
  modelValue: DrainableManager;
}

export const MANAGER_CALLBACKS_STAGE = "manager-callbacks";
export const MODEL_METADATA_REFRESH_STAGE = "model-metadata-refresh";
export const MODEL_VALUE_REFRESH_STAGE = "model-value-refresh";

/**
 * Await every store-writing manager drain under one bounded group, then
 * report the model refreshes as their own verdicts so a missed metadata or
 * value drain cannot hide inside a combined "managers" success.
 */
export async function drainStoreWritingManagers(
  managers: StoreWritingManagers,
  runGroup: (label: string, work: () => Promise<unknown>) => Promise<boolean>
): Promise<DrainVerdict[]> {
  let metadataOk = false;
  let valueOk = false;
  const groupOk = await runGroup("manager callbacks", async () => {
    await Promise.all([
      managers.scheduled.drain(),
      managers.wake.drain(),
      managers.watch.drain(),
      managers.parked.drain(),
      managers.modelMetadata.drain().then(() => {
        metadataOk = true;
      }),
      managers.modelValue.drain().then(() => {
        valueOk = true;
      }),
    ]);
  });
  return [
    { stage: MANAGER_CALLBACKS_STAGE, drained: groupOk },
    { stage: MODEL_METADATA_REFRESH_STAGE, drained: groupOk && metadataOk },
    { stage: MODEL_VALUE_REFRESH_STAGE, drained: groupOk && valueOk },
  ];
}
