/**
 * Choosing and launching the agent process for a slot (#468, #453).
 *
 * Lives outside `index.ts` because that file is the CLI entrypoint and
 * `process.exit(1)`s on import, so nothing left inline there can be reached by
 * a test. #442, #444 and #456 each shipped with a mutation surviving for that
 * reason. The refusal has to be thrown from here, or deleting it stays green.
 *
 * Every held agent, including copilot, launches through `adapter.spawn`.
 * The binary, base argv, and install detection live on the adapter. Model,
 * effort, MCP servers, cwd, and env arrive as slot data. There is no
 * agent-id branch and no second copilot launcher.
 */
import type { ChildProcess } from "node:child_process";
import type { AgentAdapter } from "@seam/adapters";
import type { SlotSpawnConfig } from "./rpc.js";
import {
  resolveSlotAdapter,
  UnknownAgentError,
  UnspecifiedAgentError,
} from "./resolve-adapter.js";

export function spawnAgent(
  adapters: Map<string, AgentAdapter>,
  slotCfg?: SlotSpawnConfig
): ChildProcess {
  const resolution = resolveSlotAdapter(adapters, slotCfg);
  // #468: a stated agentId this bridge cannot serve used to fall through to
  // a copilot launcher. The requested agent never ran, nothing failed, and
  // copilot did the work. Refuse instead: one dead slot an operator can see
  // beats a turn that silently came from the wrong agent.
  if (resolution.kind === "unknown") {
    throw new UnknownAgentError(resolution.agentId, resolution.available);
  }
  // #453: no id, and not exactly one adapter, used to exec copilot — even on
  // a host that had not loaded it. That is the same silent substitution.
  if (resolution.kind === "unspecified") {
    throw new UnspecifiedAgentError(resolution.available);
  }
  const adapter = resolution.adapter;
  const model = slotCfg?.model;
  const effort = slotCfg?.effort;
  console.error(
    `[bridge] Spawning adapter ${adapter.id}` +
      (model ? ` model=${model}` : "") +
      (effort ? ` effort=${effort}` : "")
  );
  return adapter.spawn(model, effort, slotCfg?.mcpServers, {
    cwd: slotCfg?.cwd,
    env: slotCfg?.env,
  });
}
