import { describe, it, expect } from "vitest";
import {
  ISOLATED_SAFE_CLAUDE_MODELS,
  ingestMintStoredModel,
  isClaudeAgentId,
  isolatedClaudeModelRefusal,
  refuseIsolatedClaudeModel,
} from "../packages/core/src/core/choice/ingest-model.js";

describe("isClaudeAgentId", () => {
  it("matches claude and claude-* extra profiles", () => {
    expect(isClaudeAgentId("claude")).toBe(true);
    expect(isClaudeAgentId("claude-opus")).toBe(true);
    expect(isClaudeAgentId("claude@local")).toBe(true);
    expect(isClaudeAgentId("claude-opus@remote")).toBe(true);
  });

  it("does not match other agents", () => {
    expect(isClaudeAgentId("gemini")).toBe(false);
    expect(isClaudeAgentId("copilot")).toBe(false);
    expect(isClaudeAgentId("agy")).toBe(false);
  });
});

describe("refuseIsolatedClaudeModel", () => {
  it("allows advertised aliases", () => {
    expect(refuseIsolatedClaudeModel("claude", "default")).toBeNull();
    expect(refuseIsolatedClaudeModel("claude", "sonnet")).toBeNull();
    expect(refuseIsolatedClaudeModel("claude", "haiku")).toBeNull();
  });

  it("allows sonnet/haiku full ids that are alias targets", () => {
    expect(refuseIsolatedClaudeModel("claude", "claude-sonnet-5")).toBeNull();
    expect(refuseIsolatedClaudeModel("claude", "claude-sonnet-4-6")).toBeNull();
    expect(refuseIsolatedClaudeModel("claude", "claude-haiku-4-5")).toBeNull();
  });

  it("rejects claude-opus-5 and other Opus full ids", () => {
    const err = refuseIsolatedClaudeModel("claude", "claude-opus-5");
    expect(err).toBeTruthy();
    expect(err).toContain('Use "default" for latest Opus');
    expect(err).toContain('this account cannot set "claude-opus-5" on isolated ingest');
    expect(refuseIsolatedClaudeModel("claude", "claude-opus-4-8")).not.toBeNull();
    expect(refuseIsolatedClaudeModel("claude", "claude-fable-5")).not.toBeNull();
  });

  it("does not gate non-Claude agents", () => {
    expect(refuseIsolatedClaudeModel("gemini", "claude-opus-5")).toBeNull();
    expect(refuseIsolatedClaudeModel("copilot", "gpt-5")).toBeNull();
    expect(refuseIsolatedClaudeModel("agy", "whatever")).toBeNull();
  });

  it("does not gate a missing pin", () => {
    expect(refuseIsolatedClaudeModel("claude", null)).toBeNull();
    expect(refuseIsolatedClaudeModel("claude", undefined)).toBeNull();
    expect(refuseIsolatedClaudeModel("claude", "")).toBeNull();
    expect(refuseIsolatedClaudeModel(null, "claude-opus-5")).toBeNull();
  });

  it("gates claude-* extra profiles the same way", () => {
    expect(refuseIsolatedClaudeModel("claude-opus", "default")).toBeNull();
    expect(refuseIsolatedClaudeModel("claude@local", "claude-opus-5")).not.toBeNull();
  });
});

describe("isolatedClaudeModelRefusal", () => {
  it("tells the caller to use default for latest Opus", () => {
    const text = isolatedClaudeModelRefusal("claude-opus-5");
    expect(text).toMatch(/Isolated ingest cannot set Claude model "claude-opus-5"/);
    expect(text).toMatch(/ACP advertises default\/sonnet\/haiku/);
    expect(text).toMatch(/Use "default" for latest Opus/);
    expect(text).toMatch(/this account cannot set "claude-opus-5" on isolated ingest/);
  });
});

describe("ingestMintStoredModel", () => {
  it("stores an explicit pin and does not inherit a session model", () => {
    expect(ingestMintStoredModel("default")).toBe("default");
    expect(ingestMintStoredModel("claude-opus-5")).toBe("claude-opus-5");
    expect(ingestMintStoredModel(undefined)).toBeNull();
    expect(ingestMintStoredModel(null)).toBeNull();
    expect(ingestMintStoredModel("")).toBeNull();
    expect(ingestMintStoredModel("  ")).toBeNull();
  });

  it("an omitted pin is not refused even when the live thread is opus-5", () => {
    const stored = ingestMintStoredModel(undefined);
    expect(refuseIsolatedClaudeModel("claude", stored)).toBeNull();
    expect(refuseIsolatedClaudeModel("claude", ingestMintStoredModel("claude-opus-5"))).not.toBeNull();
  });
});

describe("ISOLATED_SAFE_CLAUDE_MODELS", () => {
  it("is a small explicit allow-list (aliases + sonnet/haiku full ids only)", () => {
    expect([...ISOLATED_SAFE_CLAUDE_MODELS].sort()).toEqual(
      [
        "claude-haiku-4-5",
        "claude-sonnet-4-6",
        "claude-sonnet-5",
        "default",
        "haiku",
        "sonnet",
      ].sort()
    );
    expect(ISOLATED_SAFE_CLAUDE_MODELS.has("claude-opus-5")).toBe(false);
  });
});
