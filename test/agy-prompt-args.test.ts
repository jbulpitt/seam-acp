import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  AGY_NO_SLASH_EXPANSION,
  buildAgyPromptArgs,
  type AgyExecutionPolicy,
} from "../packages/adapters/src/profiles/agy.js";

const STAGING_ROOT = path.join(os.tmpdir(), "seam-attachments");

const CHAT_POLICY: AgyExecutionPolicy = {
  sandbox: false,
  exposeGlobalStaging: true,
  persistModelSelection: true,
};

const base = {
  promptText: "hello",
  useStdin: false,
  modelDisplayName: "Gemini 3.8 Flash (High)",
  logFile: "/tmp/agy-turn.log",
  printTimeoutSeconds: 600,
  cwd: "/workspace",
  execution: CHAT_POLICY,
};

// agy >= 1.1.9 resolves a print-mode prompt whose first token is one of its own
// commands or an installed skill instead of sending it to the model. Verified on
// 1.1.25: `agy -p "/skills do X"` exits 2 with "takes no arguments" and never
// starts a turn — on BOTH the -p and the stdin path. See issue #47.
describe("buildAgyPromptArgs — slash-command expansion opt-out (#47)", () => {
  it("passes --disable-slash-commands on the direct-argument path", () => {
    const args = buildAgyPromptArgs(base);
    expect(args).toContain(AGY_NO_SLASH_EXPANSION);
    expect(args.slice(0, 2)).toEqual(["-p", "hello"]);
  });

  it("passes --disable-slash-commands on the stdin path, which carries no -p", () => {
    const args = buildAgyPromptArgs({ ...base, useStdin: true });
    expect(args).toContain(AGY_NO_SLASH_EXPANSION);
    expect(args).not.toContain("-p");
    expect(args).not.toContain(base.promptText);
  });

  it("emits the flag exactly once so a duplicate can't creep in", () => {
    for (const useStdin of [false, true]) {
      const args = buildAgyPromptArgs({ ...base, useStdin });
      expect(args.filter((a) => a === AGY_NO_SLASH_EXPANSION)).toHaveLength(1);
    }
  });

  it("keeps a slash-prefixed prompt literal instead of letting agy resolve it", () => {
    // The exact shape an injectTurn caller (seam-mcp handoff/forward/send, cron,
    // wake) can produce: no harness preamble, so `/` really is the first token.
    const promptText = "/skills reply with the word BANANA";
    const args = buildAgyPromptArgs({ ...base, promptText });
    expect(args[1]).toBe(promptText);
    expect(args.indexOf(AGY_NO_SLASH_EXPANSION)).toBeGreaterThan(args.indexOf(promptText));
  });
});

describe("buildAgyPromptArgs — no other behavior changed", () => {
  it("produces the pre-fix argv with only the new flag inserted", () => {
    expect(buildAgyPromptArgs({ ...base, cascadeId: "cascade-1" })).toEqual([
      "-p",
      "hello",
      AGY_NO_SLASH_EXPANSION,
      "--model",
      "Gemini 3.8 Flash (High)",
      "--log-file",
      "/tmp/agy-turn.log",
      "--print-timeout",
      "600s",
      "--dangerously-skip-permissions",
      "--add-dir",
      "/workspace",
      "--add-dir",
      STAGING_ROOT,
      "--conversation",
      "cascade-1",
    ]);
  });

  it("removing the flag leaves exactly the previous argument list", () => {
    // Strongest regression guard: the fix is additive. Anything else that moves
    // in this argv fails here rather than silently changing how agy is driven.
    const args = buildAgyPromptArgs({ ...base, cascadeId: "cascade-1" });
    expect(args.filter((a) => a !== AGY_NO_SLASH_EXPANSION)).toEqual([
      "-p",
      "hello",
      "--model",
      "Gemini 3.8 Flash (High)",
      "--log-file",
      "/tmp/agy-turn.log",
      "--print-timeout",
      "600s",
      "--dangerously-skip-permissions",
      "--add-dir",
      "/workspace",
      "--add-dir",
      STAGING_ROOT,
      "--conversation",
      "cascade-1",
    ]);
  });

  it("omits --model when the catalog yielded no model", () => {
    const args = buildAgyPromptArgs({ ...base, modelDisplayName: undefined });
    expect(args).not.toContain("--model");
    expect(args).toContain(AGY_NO_SLASH_EXPANSION);
  });

  it("omits --conversation on the first turn of a session", () => {
    expect(buildAgyPromptArgs(base)).not.toContain("--conversation");
  });

  it("threads the sandboxed one-shot policy through unchanged", () => {
    const args = buildAgyPromptArgs({
      ...base,
      cwd: "/private/image",
      execution: { sandbox: true, exposeGlobalStaging: false, persistModelSelection: false },
    });
    expect(args).toContain("--sandbox");
    expect(args.filter((a) => a === "--add-dir")).toHaveLength(1);
    expect(args).not.toContain(STAGING_ROOT);
    expect(args).toContain(AGY_NO_SLASH_EXPANSION);
  });

  it("formats the print timeout as agy's duration string", () => {
    expect(buildAgyPromptArgs({ ...base, printTimeoutSeconds: 30 })).toContain("30s");
  });
});

describe("buildAgyPromptArgs — structured output is stage-aware", () => {
  it("does not pass --output-format or --json-schema on prose turns", () => {
    const args = buildAgyPromptArgs(base);
    expect(args).not.toContain("--output-format");
    expect(args).not.toContain("--json-schema");
    expect(args).not.toContain("json");
  });

  it("passes BOTH --output-format json and --json-schema when structuredOutput is set", () => {
    const schemaPath = "/tmp/pinned-facts.schema.json";
    const args = buildAgyPromptArgs({
      ...base,
      structuredOutput: { jsonSchema: schemaPath },
    });
    const formatAt = args.indexOf("--output-format");
    const schemaAt = args.indexOf("--json-schema");
    expect(formatAt).toBeGreaterThan(-1);
    expect(args[formatAt + 1]).toBe("json");
    expect(schemaAt).toBeGreaterThan(-1);
    expect(args[schemaAt + 1]).toBe(schemaPath);
    expect(args).toContain(AGY_NO_SLASH_EXPANSION);
    expect(args).toContain("--model");
  });

  it("keeps structured flags on the stdin large-prompt path", () => {
    const args = buildAgyPromptArgs({
      ...base,
      useStdin: true,
      structuredOutput: { jsonSchema: '{"type":"object"}' },
    });
    expect(args).not.toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("--json-schema");
    expect(args[args.indexOf("--output-format") + 1]).toBe("json");
  });
});
