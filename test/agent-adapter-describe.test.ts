import { describe, it, expect } from "vitest";
import {
  AGENT_ADAPTER_VERSION,
  makeAgyProfile,
  makeClaudeProfile,
  makeCodexProfile,
  makeCopilotProfile,
  makeGrokProfile,
  makeOpencodeProfile,
} from "@seam/adapters";

describe("AgentAdapter.describe()", () => {
  it("claude reports meta effort and static models (with contextLimit)", () => {
    const profile = makeClaudeProfile({
      defaultModel: "default",
      staticModels: [
        { modelId: "default", name: "Opus latest" },
        { modelId: "claude-sonnet-4-6", name: "Sonnet 4.6" },
      ],
    });
    const d = profile.describe();
    expect(d.version).toBe(AGENT_ADAPTER_VERSION);
    expect(d.effort.mechanism).toBe("meta");
    expect(d.effort.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(d.models).toEqual([
      { modelId: "default", name: "Opus latest", contextLimit: 1_000_000 },
      { modelId: "claude-sonnet-4-6", name: "Sonnet 4.6", contextLimit: 200_000 },
    ]);
  });

  it("claude variants round-trip their effort override (zai / ollama-cloud = none)", () => {
    const zai = makeClaudeProfile({
      id: "zai",
      defaultModel: "glm-5",
      effort: { mechanism: "none", levels: [] },
    });
    expect(zai.id).toBe("zai");
    expect(zai.describe().effort.mechanism).toBe("none");
    expect(zai.describe().effort.levels).toEqual([]);

    const vertex = makeClaudeProfile({
      id: "claude-vertex",
      defaultModel: "default",
    });
    expect(vertex.describe().effort.mechanism).toBe("meta");
  });

  it("copilot reports configOption + reasoning_effort", () => {
    const d = makeCopilotProfile({ defaultModel: "gpt-5" }).describe();
    expect(d.effort.mechanism).toBe("configOption");
    expect(d.effort.configId).toBe("reasoning_effort");
    expect(d.effort.levels).toEqual(["low", "medium", "high"]);
  });

  it("agy reports modelBaked", () => {
    const d = makeAgyProfile().describe();
    expect(d.effort.mechanism).toBe("modelBaked");
    expect(d.effort.levels).toEqual([]);
  });

  it("opencode reports none by default and falls back to defaultModel", () => {
    const d = makeOpencodeProfile({ defaultModel: "lmstudio-remote/gemma" }).describe();
    expect(d.effort.mechanism).toBe("none");
    expect(d.models).toEqual([
      { modelId: "lmstudio-remote/gemma", name: "lmstudio-remote/gemma" },
    ]);
  });

  it("codex reports configOption + reasoning_effort", () => {
    const d = makeCodexProfile({ defaultModel: "o3" }).describe();
    expect(d.effort.mechanism).toBe("configOption");
    expect(d.effort.configId).toBe("reasoning_effort");
  });

  it("grok reports spawnArgs so describe() round-trips the CLI-flag mechanism", () => {
    const d = makeGrokProfile({
      defaultModel: "grok-4.6",
      staticModels: [{ modelId: "grok-4.6", name: "Grok 4.6", contextLimit: 500_000 }],
    }).describe();
    expect(d.effort.mechanism).toBe("spawnArgs");
    expect(d.effort.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(d.models).toEqual([
      { modelId: "grok-4.6", name: "Grok 4.6", contextLimit: 500_000 },
    ]);
  });
});

describe("AgentAdapter local stubs + session delegates", () => {
  it("does not install, enumerate workspaces, or ferry attachments", async () => {
    const grok = makeGrokProfile({ defaultModel: "grok-4.6" });
    expect(grok.prepare()).toEqual([]);
    expect(grok.install()).toEqual({ supported: false });
    expect(grok.listWorkspaces()).toEqual([]);
    await expect(grok.readAttachment("/tmp", "x.txt")).resolves.toBeNull();
    await expect(grok.writeAttachment("/tmp", "x.txt", "Zg==")).resolves.toBeNull();
  });

  it("usage() is null without sessionManager.getUsage (opencode, codex)", async () => {
    await expect(
      makeOpencodeProfile({ defaultModel: "x" }).usage("/tmp")
    ).resolves.toBeNull();
    await expect(makeCodexProfile({ defaultModel: "o3" }).usage("/tmp")).resolves.toBeNull();
  });

  it("session verbs no-op when there is no sessionManager", async () => {
    const p = makeOpencodeProfile({ defaultModel: "x" });
    await expect(p.listSessions("/tmp")).resolves.toEqual([]);
    await expect(p.getTranscript("/tmp", "s")).resolves.toBe("");
    await expect(p.cloneSession("/tmp", "a", "b")).resolves.toBeUndefined();
    await expect(p.deleteSession("/tmp", "s")).resolves.toBeUndefined();
  });

  it("keeps spawn(modelOverride?, effortOverride?) as the runtime signature", () => {
    const grok = makeGrokProfile({ defaultModel: "grok-4.6" });
    expect(typeof grok.spawn).toBe("function");
    expect(grok.spawn.length).toBe(2);
  });
});
