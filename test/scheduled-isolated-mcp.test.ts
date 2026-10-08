import { testSessionRouter } from "./helpers/session-fixture.js";
import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { withHarnessPreamble } from "../packages/core/src/core/agent-conventions.js";
import { localBridgeHub } from "./local-bridge-fixture.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";

interface ScheduledRunnerThis {
  config: { TURN_TIMEOUT_SECONDS: number; channelPresets: Map<string, { rider: { value: string } }>; threadPresets: Map<string, { rider: { value: string } }> };
  router: { reuseMcpServers: (sessionId: string) => unknown[]; describeConfig: () => { location: { value: string } } };
  injectTurn: (...args: unknown[]) => Promise<{ text: string; error?: string }>;
  bridgeHub: unknown;
  modelCatalog: ReturnType<typeof fixtureModelCatalog>;
}

interface ScheduledRunnerArgs {
  profile: unknown;
  record: { id: string; platform: string; channelRef: string; parentRef: string };
  cwd: string;
  model?: string;
  effort?: string;
  channel: unknown;
  promptText: string;
}

describe("scheduled isolated Seam-MCP wiring", () => {
  it("reuses the authoring session MCP token and sends no attachments (#158)", async () => {
    const riders = ["SCHEDULE_CHANNEL_RIDER", "SCHEDULE_THREAD_RIDER"];
    const mcpServers = [{ name: "seam-mcp", url: "http://127.0.0.1/mcp" }];
    const reuseMcpServers = vi.fn(() => mcpServers);
    const injectTurn = vi.fn(async () => ({ text: "inspected" }));
    const profile = { id: "ollama-cloud", defaultModel: "glm-5.3:cloud" } as any;
    const bridgeHub = localBridgeHub([profile], "/tmp");
    vi.spyOn(bridgeHub, "mcpServersForBridgeSpawn").mockReturnValue(mcpServers[0] as any);
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
          config: { TURN_TIMEOUT_SECONDS: 120,
            channelPresets: new Map([["parent", { rider: { value: riders[0]! } }]]),
            threadPresets: new Map([["scheduled-owner", { rider: { value: riders[1]! } }]]) },
          router: testSessionRouter({ reuseMcpServers, describeConfig: () => ({ location: { value: "local" } }) }),
          injectTurn,
          bridgeHub,
          modelCatalog: fixtureModelCatalog([profile]),
        },
        {
          profile,
          record: { id: "discord:scheduled-owner", platform: "discord", channelRef: "scheduled-owner", parentRef: "parent" },
          cwd: "/tmp",
          model: "glm-5.3:cloud",
          channel: { id: "discord:target" },
          promptText: "Follow docs/runbooks/nightly.md.",
        }
      )
    ).resolves.toEqual({ text: "inspected" });

    expect(reuseMcpServers).toHaveBeenCalledWith("discord:scheduled-owner");
    expect(injectTurn).toHaveBeenCalledWith(
      { id: "discord:scheduled-owner", platform: "discord", channelRef: "scheduled-owner", parentRef: "parent" },
      withHarnessPreamble("Follow docs/runbooks/nightly.md.", riders),
      expect.objectContaining({
        session: "isolated",
        mcpServers,
        model: "glm-5.3:cloud",
      })
    );
    const submitted = String(injectTurn.mock.calls[0]![1]);
    expect(submitted.indexOf(riders[0]!)).toBeLessThan(submitted.indexOf(riders[1]!));
    // #158: a scheduled fire never carries files — not even an empty array.
    expect(injectTurn.mock.calls[0]![2]).not.toHaveProperty("attachments");
  });
});
