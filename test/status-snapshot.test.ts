import { describe, expect, it } from "vitest";
import {
  STATUS_TEXT_TAIL_MAX,
  StatusSnapshotCard,
  renderStatusSnapshot,
  type StatusObservation,
} from "../packages/core/src/core/status-snapshot.js";

const observation = (over: Partial<StatusObservation> = {}): StatusObservation => ({
  state: "Working",
  action: "Tool: Read file.ts",
  model: "grok",
  contextUsed: 50_000,
  latestTool: "Read file.ts",
  textTail: "planning the edit",
  startedAt: 1_000,
  ...over,
});

describe("status snapshot (#445)", () => {
  it("re-rendering the same state keeps one record and does not move elapsed", () => {
    const card = new StatusSnapshotCard();
    const first = card.publish(observation(), 200_000, 6_000);
    card.bind();
    const body = card.renderedBody();

    const again = card.publish(observation(), 200_000, 26_000);
    expect(again).toEqual(first);
    expect(again.elapsedSeconds).toBe(5);
    expect(card.renderedBody()).toBe(body);
    expect(card.plan()).toEqual({ action: "skip", body });
    expect(card.plan()).toEqual({ action: "skip", body });
    expect(card.current()).not.toHaveProperty("contextWindow");
  });

  it("a real change edits the same card and does not ask for a second message", () => {
    const card = new StatusSnapshotCard();
    card.publish(observation(), null, 6_000);
    card.bind();
    card.publish(observation({ state: "Done", action: "Completed" }), null, 11_000);
    const plan = card.plan();
    expect(plan.action).toBe("edit");
    expect(plan.body).toBe(card.renderedBody());
    expect(card.current()).toMatchObject({ state: "Done", elapsedSeconds: 10 });
    card.acknowledge();
    expect(card.plan().action).toBe("skip");
  });

  it("keeps the catalog window out of the record and out of a same-state re-render", () => {
    const card = new StatusSnapshotCard();
    const snapshot = card.publish(observation({ contextUsed: 12 }), 200_000, 1_000);
    expect(snapshot.contextUsed).toBe(12);
    expect(Object.keys(snapshot)).not.toContain("contextWindow");
    const withWindow = renderStatusSnapshot(snapshot, 200_000);
    const without = renderStatusSnapshot(snapshot, null);
    expect(withWindow).toContain("12/200000");
    expect(without).not.toContain("200000");
    expect(renderStatusSnapshot(snapshot, 200_000)).toBe(withWindow);

    card.bind();
    card.publish(observation({ contextUsed: 12 }), 200_000, 9_000);
    expect(card.plan().action).toBe("skip");
    expect(card.renderedBody()).toBe(withWindow);
  });

  it("bounds the text tail to the end of the latest text, not the stream", () => {
    const stream = `start ${"m".repeat(STATUS_TEXT_TAIL_MAX)} END`;
    const card = new StatusSnapshotCard();
    const snapshot = card.publish(observation({ textTail: stream }), null, 1_000);
    expect(snapshot.textTail.length).toBe(STATUS_TEXT_TAIL_MAX);
    expect(snapshot.textTail.endsWith("END")).toBe(true);
    expect(snapshot.textTail.startsWith("start")).toBe(false);
  });

  it("a catalog window change can edit the card without rewriting the snapshot", () => {
    const card = new StatusSnapshotCard();
    const first = card.publish(observation(), null, 6_000);
    card.bind();
    const second = card.publish(observation(), 200_000, 26_000);
    expect(second).toEqual(first);
    expect(card.plan().action).toBe("edit");
    expect(card.renderedBody()).toContain("50000/200000");
  });
});
