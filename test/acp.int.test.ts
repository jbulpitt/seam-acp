import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { AgentRuntime } from "../src/agents/agent-runtime.js";
import { makeCopilotProfile } from "../src/agents/profiles/copilot.js";
import { logger } from "../src/lib/logger.js";

const copilotInstalled =
  spawnSync("which", ["copilot"], { encoding: "utf8" }).status === 0;

const maybe = copilotInstalled ? describe : describe.skip;

maybe("AgentRuntime against `copilot --acp` (integration)", () => {
  it(
    "init → newSession → prompt → cancel → dispose",
    async () => {
      const runtime = new AgentRuntime({
        profile: makeCopilotProfile({ defaultModel: "gpt-5.4" }),
        logger,
      });

      const events: string[] = [];
      runtime.onEvent((e) => {
        events.push(e.kind);
      });

      try {
        await runtime.start();

        const info = await runtime.newSession({
          cwd: process.cwd(),
        });
        expect(info.sessionId).toBeTruthy();
        expect(info.availableModels.length).toBeGreaterThan(0);

        const result = await runtime.prompt(
          'Reply with the single word "ok" and nothing else.'
        );
        expect(["end_turn", "cancelled", "max_tokens"]).toContain(
          result.stopReason
        );
        expect(events.some((k) => k === "agent-text")).toBe(true);
      } finally {
        await runtime.dispose();
      }
    },
    60_000
  );
});
