import type { AgyLaunchRuntime } from "@seam/adapters";
import type { Orchestrator } from "../platforms/discord/orchestrator.js";

/** Startup publication path for the locally admitted native AGY runtime. */
export function publishLocalAgyRuntimeProvenance(
  orchestrator: Pick<Orchestrator, "getConfigMutation">,
  runtime: AgyLaunchRuntime | undefined,
): void {
  if (!runtime) return;
  orchestrator.getConfigMutation().recordRuntimeProvenance({
    agentId: "agy",
    location: "local",
    runtime: runtime.descriptor,
  });
}
