import { afterEach } from "vitest";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { ScheduledExecutionIdentity } from "../packages/core/src/core/scheduled-prompts/occurrence-store.js";

const stores: SessionStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
/** Manager-only tests still exercise real SQLite admission, without resolving
 * an installed provider or treating a no-op callback as durable completion. */
export function scheduledAdmissionFixture() {
  const store = new SessionStore(":memory:"); stores.push(store);
  return store.scheduledOccurrences;
}
export function syntheticScheduleExecution(): ScheduledExecutionIdentity {
  return { agentId: "synthetic", location: "local", model: "synthetic", effort: null,
    cwd: "/synthetic", fingerprint: "synthetic-not-a-provider-identity" };
}
