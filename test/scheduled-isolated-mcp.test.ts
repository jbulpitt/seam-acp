import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";

interface ScheduledRunnerThis {
  config: { TURN_TIMEOUT_SECONDS: number };
  router: { reuseMcpServers: (sessionId: string) => unknown[] };
  injectTurn: (...args: unknown[]) => Promise<{ text: string; error?: string }>;
}

interface ScheduledRunnerArgs {
  profile: unknown;
  record: { id: string };
  cwd: string;
  model?: string;
  effort?: string;
  channel: unknown;
  promptText: string;
  attachments: unknown[];
}

describe("scheduled isolated Seam-MCP wiring", () => {
  it("reuses the authoring session MCP token for tool-mediated attachments", async () => {
    const mcpServers = [{ name: "seam-mcp", url: "http://127.0.0.1/mcp" }];
    const reuseMcpServers = vi.fn(() => mcpServers);
    const injectTurn = vi.fn(async () => ({ text: "inspected" }));
    const runner = (
      Orchestrator.prototype as unknown as {
        runIsolatedScheduledJob(
          this: ScheduledRunnerThis,
          args: ScheduledRunnerArgs
        ): Promise<{ text: string; error?: string }>;
      }
    ).runIsolatedScheduledJob;

    await expect(
      runner.call(
        {
          config: { TURN_TIMEOUT_SECONDS: 120 },
          router: { reuseMcpServers },
          injectTurn,
        },
        {
          profile: { id: "ollama-cloud" },
          record: { id: "discord:scheduled-owner" },
          cwd: "/tmp",
          model: "glm-5.3:cloud",
          channel: { id: "discord:target" },
          promptText: "Inspect the staged image.",
          attachments: [],
        }
      )
    ).resolves.toEqual({ text: "inspected" });

    expect(reuseMcpServers).toHaveBeenCalledWith("discord:scheduled-owner");
    expect(injectTurn).toHaveBeenCalledWith(
      { id: "discord:scheduled-owner" },
      "Inspect the staged image.",
      expect.objectContaining({
        session: "isolated",
        mcpServers,
        model: "glm-5.3:cloud",
      })
    );
  });
});
