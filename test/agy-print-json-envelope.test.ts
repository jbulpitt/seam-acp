import { describe, expect, it } from "vitest";
import {
  parseAgyPrintJsonEnvelope,
  readAgyJsonSchemaMeta,
  SEAM_AGY_JSON_SCHEMA_META,
} from "../packages/adapters/src/profiles/agy.js";
import {
  coercePinnedFacts,
  isPinnedFacts,
  PINNED_FACTS_JSON_SCHEMA,
} from "../packages/core/src/core/compaction/prompts.js";

const pinned = {
  corrections: ["never skip tests"],
  constraints: ["fail closed"],
  decisions: ["use structured_output"],
  openTodos: [],
  activePaths: ["packages/adapters/src/profiles/agy.ts"],
  rules: [],
};

describe("parseAgyPrintJsonEnvelope", () => {
  it("returns structured_output from a SUCCESS envelope", () => {
    const stdout = JSON.stringify({
      conversation_id: "c1",
      status: "SUCCESS",
      response: `${JSON.stringify(pinned)}\n${JSON.stringify({
        ...pinned,
        toolAction: "Completing task",
        toolSummary: "Finish task",
      })}`,
      structured_output: pinned,
      json_schema: PINNED_FACTS_JSON_SCHEMA,
    });
    expect(parseAgyPrintJsonEnvelope(stdout)).toEqual({
      status: "SUCCESS",
      structuredOutput: pinned,
    });
  });

  it("does not treat concatenated response JSON as success", () => {
    const stdout = JSON.stringify({
      status: "SUCCESS",
      response: JSON.stringify({
        ok: true,
        note: "hello-schema",
        toolAction: "Completing task",
        toolSummary: "Finish task",
      }),
    });
    expect(() => parseAgyPrintJsonEnvelope(stdout)).toThrow(/missing structured_output/);
  });

  it("rejects ERROR envelopes including timeouts", () => {
    const stdout = JSON.stringify({
      status: "ERROR",
      response: "",
      error: "timeout waiting for response",
      json_schema: PINNED_FACTS_JSON_SCHEMA,
    });
    expect(() => parseAgyPrintJsonEnvelope(stdout)).toThrow(
      /status ERROR \(timeout waiting for response\)/
    );
  });

  it("rejects empty stdout and progress-only prose", () => {
    expect(() => parseAgyPrintJsonEnvelope("")).toThrow(/empty stdout/);
    expect(() =>
      parseAgyPrintJsonEnvelope("I'll extract the pinned facts next.\nWorking…")
    ).toThrow(/stdout is not JSON/);
  });
});

describe("PinnedFacts schema contract", () => {
  it("matches the TypeScript PinnedFacts keys exactly", () => {
    expect(PINNED_FACTS_JSON_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "corrections",
        "constraints",
        "decisions",
        "openTodos",
        "activePaths",
        "rules",
      ],
    });
  });

  it("rejects progress-only or extra-field objects that parse as JSON", () => {
    expect(isPinnedFacts({ toolAction: "Completing task", toolSummary: "Finish task" })).toBe(
      false
    );
    expect(isPinnedFacts({ ok: true, note: "hello-schema" })).toBe(false);
    expect(isPinnedFacts({ ...pinned, extra: "nope" })).toBe(false);
    expect(() => coercePinnedFacts({ toolAction: "Completing task" })).toThrow(
      /PinnedFacts contract/
    );
    expect(coercePinnedFacts(pinned)).toEqual(pinned);
  });
});

describe("readAgyJsonSchemaMeta", () => {
  it("is absent for interactive turns with no meta", () => {
    expect(readAgyJsonSchemaMeta(undefined)).toBeUndefined();
    expect(readAgyJsonSchemaMeta({})).toBeUndefined();
  });

  it("returns the schema object from the reserved meta key", () => {
    expect(
      readAgyJsonSchemaMeta({ [SEAM_AGY_JSON_SCHEMA_META]: PINNED_FACTS_JSON_SCHEMA })
    ).toEqual(PINNED_FACTS_JSON_SCHEMA);
  });

  it("fails closed on a non-object schema value", () => {
    expect(() =>
      readAgyJsonSchemaMeta({ [SEAM_AGY_JSON_SCHEMA_META]: "not-an-object" })
    ).toThrow(/json schema meta must be a JSON object/);
  });
});
