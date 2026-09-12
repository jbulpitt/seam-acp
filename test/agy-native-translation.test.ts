import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AgyNativeTranslator,
  type AgyNativeEvent,
  type AgyTranslationBatch,
} from "../packages/adapters/src/agy-native-translation.js";
import type { AgyStep, AgyStreamUpdate } from "../packages/adapters/src/agy-stream.js";

const fixtures = fileURLToPath(new URL("./fixtures/agy-native-capabilities/", import.meta.url));

interface Trace {
  updates: AgyStreamUpdate[];
}

function trace(name: string): Trace {
  return JSON.parse(fs.readFileSync(`${fixtures}/${name}`, "utf8")) as Trace;
}

function translateTrace(
  name: string,
  options: { sessionId?: string; replayThrough?: number } = {},
): AgyTranslationBatch[] {
  const translator = new AgyNativeTranslator({
    sessionId: options.sessionId ?? "session-a",
    replayThrough: options.replayThrough ?? -1,
    maxTokens: 4_096,
  });
  const batches: AgyTranslationBatch[] = [];
  for (const update of trace(name).updates) {
    const steps = update.mainTrajectoryUpdate?.stepsUpdate;
    if (!steps?.indices || !steps.steps) continue;
    for (let index = 0; index < steps.indices.length; index += 1) {
      const stepIndex = steps.indices[index];
      const step = steps.steps[index];
      if (stepIndex !== undefined && step !== undefined) {
        batches.push(translator.translate(stepIndex, step));
      }
    }
  }
  return batches;
}

function events(batches: AgyTranslationBatch[], delivery = "live"): AgyNativeEvent[] {
  return batches.filter((batch) => batch.delivery === delivery).flatMap((batch) => batch.events);
}

describe("AGY R6 native translation", () => {
  it("deterministically translates the observed trace without duplicate thought or tool polls", () => {
    const first = events(translateTrace("turn-one.json"));
    const second = events(translateTrace("turn-one.json"));
    expect(second).toEqual(first);

    expect(first.filter((event) => event.kind === "usage").map((event) => event.used)).toEqual([
      128,
      160,
      200,
    ]);
    expect(first.filter((event) => event.kind === "content").map((event) => [
      event.role,
      event.operation,
      event.text,
    ])).toEqual([
      ["thought", "append", "Inspect fixture 🧭"],
      ["message", "append", "Res"],
      ["thought", "append", "\nPlan"],
      ["message", "append", "ult "],
      ["thought", "append", " safely\n"],
      ["message", "append", "one."],
    ]);

    const tools = first.filter((event) => event.kind === "tool-start" || event.kind === "tool-update");
    expect(tools.map((event) => [event.kind, event.toolCallId, event.status])).toEqual([
      ["tool-start", "agy-step-2", "in_progress"],
      ["tool-update", "agy-step-2", "completed"],
      ["tool-start", "agy-step-3", "pending"],
      ["tool-update", "agy-step-3", "completed"],
      ["tool-start", "agy-step-4", "in_progress"],
      ["tool-update", "agy-step-4", "failed"],
    ]);
    expect(tools.filter((event) => event.kind === "tool-start").map((event) => event.toolKind)).toEqual([
      "read",
      "edit",
      "execute",
    ]);
    expect(tools.find((event) => event.toolCallId === "agy-step-3")).toMatchObject({
      metadata: { edit: true, nativeType: "CORTEX_STEP_TYPE_EDIT_FILE" },
    });
    expect(tools.at(-1)).toMatchObject({
      metadata: { terminal: true, error: true, nativeStatus: "CORTEX_STEP_STATUS_ERROR" },
    });
    expect(first.filter((event) => event.kind === "content").map((event) => event.text).join(""))
      .not.toContain("run command");
  });

  it("classifies resumed history without exposing it as a new live response", () => {
    const batches = translateTrace("turn-two-resume.json", { replayThrough: 4 });
    const historical = events(batches, "historical");
    const live = events(batches);
    expect(historical.filter((event) => event.kind === "content").map((event) => event.text)).toEqual([
      "STALE REPLAY THINKING",
      "STALE REPLAY MESSAGE",
    ]);
    expect(live.filter((event) => event.kind === "content").map((event) => event.text).join(""))
      .not.toContain("STALE REPLAY");
    expect(live.filter((event) => event.kind === "content").map((event) => [event.role, event.text])).toEqual([
      ["thought", "Resume 🚀"],
      ["message", "Second"],
      ["thought", "\nKept context\n"],
      ["message", " result."],
    ]);
  });

  it("keeps text and thinking high water independent and labels corrections and truncations", () => {
    const translator = new AgyNativeTranslator({
      sessionId: "session-correction",
      replayThrough: -1,
      maxTokens: 4_096,
    });
    const planner = (thinking: string, modifiedResponse: string): AgyStep => ({
      type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
      status: "CORTEX_STEP_STATUS_GENERATING",
      plannerResponse: { thinking, modifiedResponse },
    });
    expect(translator.translate(7, planner("think", "answer")).events).toEqual([
      expect.objectContaining({ kind: "content", role: "thought", operation: "append", text: "think" }),
      expect.objectContaining({ kind: "content", role: "message", operation: "append", text: "answer" }),
    ]);
    expect(translator.translate(7, planner("thinking", "alter!")).events).toEqual([
      expect.objectContaining({ kind: "content", role: "thought", operation: "append", text: "ing" }),
      expect.objectContaining({ kind: "content", role: "message", operation: "replace", text: "alter!" }),
    ]);
    expect(translator.translate(7, planner("tho", "alter!")).events).toEqual([
      expect.objectContaining({ kind: "content", role: "thought", operation: "replace", text: "tho" }),
    ]);
  });

  it("does not bleed partial snapshots or tool identities across sessions", () => {
    const step: AgyStep = {
      type: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
      plannerResponse: { thinking: "fresh thought", modifiedResponse: "fresh text" },
    };
    const left = new AgyNativeTranslator({ sessionId: "left", replayThrough: -1, maxTokens: 4_096 });
    const right = new AgyNativeTranslator({ sessionId: "right", replayThrough: -1, maxTokens: 4_096 });
    left.translate(1, step);
    expect(right.translate(1, step).events).toEqual([
      expect.objectContaining({ sessionId: "right", kind: "content", role: "thought", text: "fresh thought" }),
      expect.objectContaining({ sessionId: "right", kind: "content", role: "message", text: "fresh text" }),
    ]);

    const tool: AgyStep = { type: "CORTEX_STEP_TYPE_RUN_COMMAND", status: "CORTEX_STEP_STATUS_RUNNING" };
    expect(left.translate(2, tool).events).toHaveLength(1);
    expect(left.translate(2, tool).events).toEqual([]);
    expect(right.translate(2, tool).events).toEqual([
      expect.objectContaining({ sessionId: "right", kind: "tool-start", toolCallId: "agy-step-2" }),
    ]);
    expect(right.translate(3, {
      type: "CORTEX_STEP_TYPE_TASK",
      status: "CORTEX_STEP_STATUS_ERROR",
    }).events).toEqual([
      expect.objectContaining({
        kind: "tool-start",
        status: "failed",
        metadata: { task: true, error: true, terminal: true, nativeType: "CORTEX_STEP_TYPE_TASK", nativeStatus: "CORTEX_STEP_STATUS_ERROR", edit: false },
      }),
    ]);
  });
});
