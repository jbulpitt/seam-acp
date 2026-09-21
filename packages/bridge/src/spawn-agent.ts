/**
 * Choosing and launching the agent process for a slot (#468).
 *
 * Lives outside `index.ts` because that file is the CLI entrypoint and
 * `process.exit(1)`s on import, so nothing left inline there can be reached by
 * a test. #442, #444 and #456 each shipped with a mutation surviving for that
 * reason; here the surviving mutation was *the refusal never being thrown* —
 * this story's entire fix, silently undone, with a green suite.
 *
 * Every dependency below is external to `index.ts`, so the move is a lift with
 * no behaviour change.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { buildCopilotMcpConfigJson, type AgentAdapter } from "@seam/adapters";
import type { SlotSpawnConfig } from "./rpc.js";
import { resolveCopilotHostLaunch } from "./inventory.js";
import { resolveSlotAdapter, UnknownAgentError } from "./resolve-adapter.js";

export function spawnAgent(
  adapters: Map<string, AgentAdapter>,
  copilotCmd: string,
  localCwd: string,
  slotCfg?: SlotSpawnConfig
): ChildProcess {
  const resolution = resolveSlotAdapter(adapters, slotCfg);
  // #468: a stated agentId this bridge cannot serve used to fall through to
  // the copilot legacy branch below — the requested agent never ran, nothing
  // failed, and copilot did the work. Refuse instead: one dead slot an
  // operator can see beats a turn that silently came from the wrong agent,
  // and this is the layer that actually knows the inventory.
  if (resolution.kind === "unknown") {
    throw new UnknownAgentError(resolution.agentId, resolution.available);
  }
  const adapter = resolution.kind === "adapter" ? resolution.adapter : undefined;
  if (adapter && adapter.id !== "copilot") {
    console.error(
      `[bridge] Spawning adapter ${adapter.id}` +
        (slotCfg?.model ? ` model=${slotCfg.model}` : "") +
        (slotCfg?.effort ? ` effort=${slotCfg.effort}` : "")
    );
    return adapter.spawn(slotCfg?.model, slotCfg?.effort);
  }

  const cwd = slotCfg?.cwd || localCwd;
  const launch = resolveCopilotHostLaunch(copilotCmd, cwd, slotCfg?.env);
  const cmdArgs = [...launch.args];
  const mcpJson = buildCopilotMcpConfigJson(
    Array.isArray(slotCfg?.mcpServers) ? slotCfg.mcpServers : []
  );
  if (mcpJson) {
    cmdArgs.push("--additional-mcp-config", mcpJson);
  }
  const tokenLabel = launch.env.GH_TOKEN ? "present" : "missing";
  console.error(`[bridge] Spawning agent: ${launch.cliPath} ${cmdArgs.filter((a) => a !== mcpJson).join(" ")} (GH_TOKEN: ${tokenLabel})`);
  return spawn(launch.cliPath, cmdArgs, {
    cwd: launch.cwd,
    stdio: ["pipe", "pipe", "inherit"],
    env: launch.env,
  });
}
