import { spawn } from "node:child_process";
import type { AgentProfile } from "../agent-profile.js";

/**
 * GitHub Copilot CLI as an ACP server (`copilot --acp`).
 *
 * Start the ACP server with `--allow-all` so the bot can run end-to-end
 * without needing a permission UI. (The agent will still call
 * `session/request_permission`; we auto-approve those — see AgentRuntime.)
 */
export function makeCopilotProfile(opts: {
  cliPath?: string;
  defaultModel: string;
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "copilot";

  return {
    id: "copilot",
    displayName: "GitHub Copilot",
    defaultModel: opts.defaultModel,
    spawn() {
      // stdio: stdin → pipe (we write requests),
      //        stdout → pipe (we read responses),
      //        stderr → pipe (we surface errors via logger).
      return spawn(cli, ["--acp"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  };
}
