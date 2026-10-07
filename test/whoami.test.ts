import { describe, expect, it, vi } from "vitest";
import { asLocalAdapter } from "@seam/adapters";
import { dispatchBridgeRpc } from "../packages/bridge/src/rpc.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";

function fixture(agentId: string, location: string, rpcOverride?: () => Promise<unknown>, whoami?: () => Promise<any>) {
  const profile = asLocalAdapter({
    id: agentId, displayName: agentId, defaultModel: "default", whoami,
    spawn: () => { throw new Error("unused spawn"); },
  });
  const rpc = vi.fn(rpcOverride ?? (async () => dispatchBridgeRpc("whoami", {}, agentId, {
    adapters: new Map([[agentId, profile]]), workspaceRoot: "/repo",
  })));
  const orch = Object.assign(Object.create(Orchestrator.prototype), {
    config: { REPOS_ROOT: "/repo" },
    router: {
      ensureSessionRecord: () => ({}),
      describeConfig: () => ({ agent: { value: agentId }, location: { value: location } }),
      getProfile: () => profile,
    },
    bridgeHub: { rpc },
  });
  const interaction = {
    channelId: "thread", channel: { isThread: () => true, parentId: "parent" },
    deferred: true, replied: false, ephemeral: true, editReply: vi.fn(async () => {}),
  };
  return { orch, interaction, rpc };
}

describe("/seam whoami", () => {
  it.each(["codex", "agy", "grok"])("reports %s's absent account-info capability on either host", async agentId => {
    for (const location of ["local", "remote"]) {
      const { orch, interaction, rpc } = fixture(agentId, location);
      await orch.cmdWhoami(interaction);
      expect(rpc).toHaveBeenCalledWith(location, "whoami", {}, agentId);
      expect(interaction.editReply).toHaveBeenCalledWith({
        content: `Agent \`${agentId}\` (${agentId}) does not expose account info.`,
      });
    }
  });

  it.each(["codex", "agy", "grok"])("retains the true cause for %s on an old bridge returning null", async agentId => {
    const { orch, interaction } = fixture(agentId, "remote", async () => null);
    await orch.cmdWhoami(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: `Agent \`${agentId}\` (${agentId}) does not expose account info.`,
    });
  });

  it("keeps Copilot's signed-in and signed-out results distinct", async () => {
    const signedIn = fixture("copilot", "remote", undefined, async () => ({ login: "test-user", host: "github.com" }));
    await signedIn.orch.cmdWhoami(signedIn.interaction);
    expect(signedIn.interaction.editReply).toHaveBeenCalledWith({
      content: "Agent `copilot` (copilot) is signed in as **test-user** (github.com).",
    });
    const signedOut = fixture("copilot", "remote", undefined, async () => null);
    await signedOut.orch.cmdWhoami(signedOut.interaction);
    expect(signedOut.interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("no logged-in account found"),
    });
  });

  it("passes a host RPC failure through instead of replacing it with login advice", async () => {
    const { orch, interaction } = fixture("copilot", "remote", async () => { throw new Error("EACCES: account file unreadable"); });
    await orch.cmdWhoami(interaction);
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "EACCES: account file unreadable" });
  });
});
