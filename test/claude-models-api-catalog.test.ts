import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAnthropicModelsApi,
  makeClaudeProfile,
} from "@seam/adapters";
import { validateCandidate } from "../packages/core/src/core/model-catalog/service.js";

const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-claude-agent-acp.mjs", import.meta.url));
const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function apiRow(id: string, displayName: string, maxInputTokens = 1_000_000) {
  return {
    type: "model",
    id,
    display_name: displayName,
    created_at: "2026-09-23T00:00:00Z",
    max_input_tokens: maxInputTokens,
    max_tokens: 64_000,
    capabilities: {
      effort: {
        supported: true,
        low: { supported: true },
        medium: { supported: true },
        high: { supported: true },
        xhigh: { supported: true },
        max: { supported: true },
      },
      image_input: { supported: true },
    },
  };
}

describe("Anthropic Models API catalog", () => {
  it("pages through the entire inventory with the dedicated credential", async () => {
    const calls: Array<{ url: URL; headers: Headers }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ url, headers: new Headers(init?.headers) });
      const second = url.searchParams.get("after_id") === "cursor-1";
      return new Response(JSON.stringify(second
        ? { data: [apiRow("claude-sonnet-5-5", "Claude Sonnet 5.5")], has_more: false, last_id: "cursor-2" }
        : { data: [apiRow("claude-opus-5-5", "Claude Opus 5.5")], has_more: true, last_id: "cursor-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const models = await fetchAnthropicModelsApi({
      apiKey: "synthetic-catalog-key",
      workspaceId: "wrkspc_synthetic",
      fetchImpl,
    });

    expect(models.map((model) => model.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.searchParams.get("limit")).toBe("1000");
    expect(calls[1]!.url.searchParams.get("after_id")).toBe("cursor-1");
    expect(calls[0]!.headers.get("x-api-key")).toBe("synthetic-catalog-key");
    expect(calls[0]!.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(calls[0]!.headers.get("anthropic-workspace-id")).toBe("wrkspc_synthetic");
  });

  it("does not expose credentials or an upstream response body in errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      "upstream echoed synthetic-catalog-key and another private diagnostic",
      { status: 401 }
    )) as typeof fetch;
    const failure = await fetchAnthropicModelsApi({
      apiKey: "synthetic-catalog-key",
      fetchImpl,
    }).catch((error: unknown) => error as Error);
    expect(failure.message).toBe("Anthropic Models API returned HTTP 401");
    expect(failure.message).not.toContain("synthetic-catalog-key");
    expect(failure.message).not.toContain("private diagnostic");
  });

  it("rejects a non-advancing cursor instead of looping forever", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [apiRow("claude-opus-5-5", "Claude Opus 5.5")],
      has_more: true,
      last_id: "same-cursor",
    }), { status: 200 })) as typeof fetch;
    await expect(fetchAnthropicModelsApi({ apiKey: "synthetic", fetchImpl }))
      .rejects.toThrow("pagination did not advance");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("publishes new API models, retains default, and bypasses the ACP catalog", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [apiRow("claude-opus-5-5", "Claude Opus 5.5")],
      has_more: false,
      last_id: "claude-opus-5-5",
    }), { status: 200 })) as typeof fetch;
    const catalogProbe = vi.fn(async () => { throw new Error("ACP catalog must not run"); });
    const profile = makeClaudeProfile({
      cliPath: "false",
      directAnthropic: true,
      defaultModel: "default",
      staticModels: [{ modelId: "default", name: "Opus latest" }],
      catalogApiKey: "synthetic",
      catalogApiFetch: fetchImpl,
      catalogProbe,
    });

    const candidate = await profile.catalog.fetch();
    validateCandidate(candidate);
    expect(candidate.source).toBe("anthropic-models-api");
    expect(candidate.scope.sharing).toBe("shared");
    expect(candidate.sourceVersion).toBe("anthropic-api-2023-06-01");
    expect(candidate.models.map((model) => model.id)).toEqual(["default", "claude-opus-5-5"]);
    expect(candidate.models.find((model) => model.id === "claude-opus-5-5")).toMatchObject({
      runtimeId: "claude-opus-5-5",
      displayName: "Claude Opus 5.5",
      context: { native: 1_000_000, maximum: 1_000_000, effective: 1_000_000 },
      visionMode: "native",
      effort: { mechanism: "meta", selectionDefault: "default" },
    });
    expect(candidate.models.some((model) => model.id === "claude-opus-5")).toBe(false);
    expect(catalogProbe).not.toHaveBeenCalled();
  });
});

describe("canonical model transport through the production profile", () => {
  it("forwards an API model id exactly even when the wrapper list does not recognize it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "seam-claude-api-transport-"));
    roots.push(root);
    const log = path.join(root, "acp.jsonl");
    const model = "claude-opus-99-1";
    const profile = makeClaudeProfile({
      cliPath: FAKE_ACP,
      directAnthropic: true,
      defaultModel: "default",
      extraEnv: {
        FAKE_ACP_LOG: log,
        CLAUDE_CATALOG_API_KEY: "synthetic-catalog-key",
        CLAUDE_CATALOG_WORKSPACE_ID: "wrkspc_synthetic",
      },
    });
    const child = profile.spawn(model);
    await vi.waitFor(() => expect(fs.existsSync(log)).toBe(true));
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await exited;

    const rows = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const invocation = rows.find((row) => "anthropicModel" in row);
    expect(invocation?.anthropicModel).toBe(model);
    expect(invocation?.catalogApiKeyPresent).toBe(false);
    expect(invocation?.catalogWorkspacePresent).toBe(false);
  });
});
