import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { DispatchStatusPanel } from "../packages/core/src/core/dispatch-status-panel.js";
import { TurnStatus, renderStatusPanel } from "../packages/core/src/core/status-panel.js";
import type { StructuredPanel } from "../packages/core/src/core/types.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import { renderGoogleChatPanel, type GoogleChatCardsMessage } from "../packages/core/src/platforms/google-chat/card-renderer.js";

function status() {
  const turn = new TurnStatus({ model: "default", repoDisplay: "seam-acp", effort: "high",
    brandIconURL: "https://example.com/agent.png" });
  turn.resolvedModel = "gpt-6-astra";
  turn.context = "30k / 1m (3%)";
  turn.contextUsedHighWater = 30_000;
  turn.contextWindowSize = 1_000_000;
  for (const tool of ["Read old.ts", "Search old symbols", "Edit current.ts", "Run checks", "git diff"]) {
    turn.pushActivity(tool);
  }
  turn.pushThinkingChunk("first complete\nsecond complete\nlast complete\nstill arriving");
  turn.setAction("Tool: git diff");
  return turn;
}

function panel(turn: TurnStatus) {
  return renderStatusPanel(discordRenderer, turn.toInput(), turn.startedUtc + 12_000);
}

function card(turn: TurnStatus) {
  return renderGoogleChatPanel(panel(turn), "status").cardsV2[0]!.card;
}

function paragraphs(message: GoogleChatCardsMessage): string[] {
  return message.cardsV2[0]!.card.sections.flatMap(section => section.widgets)
    .flatMap(widget => "textParagraph" in widget ? [widget.textParagraph.text] : []);
}

function text(turn: TurnStatus) {
  return paragraphs(renderGoogleChatPanel(panel(turn), "status")).join("\n");
}

describe("Google Chat compact status cards", () => {
  it("shows only the last three tool calls, without shrinking the shared activity buffer", () => {
    const turn = status();
    const output = text(turn);
    expect(output).not.toContain("Read old.ts");
    expect(output).not.toContain("Search old symbols");
    expect(output).toContain("Edit current.ts");
    expect(output).toContain("Run checks");
    expect(output).toContain("git diff");
    expect(turn.toInput().activity).toHaveLength(5);
    for (let i = 0; i < 30; i++) turn.pushActivity(`Read ${i}.ts`);
    expect(turn.toInput().activity).toHaveLength(20);
    expect(turn.toInput().activity?.[0]).toBe("Read 10.ts");
  });

  it("shows the last complete thought plus the line still arriving", () => {
    const output = text(status());
    expect(output).not.toContain("first complete");
    expect(output).not.toContain("second complete");
    expect(output).toContain("💡 last complete<br>💡 still arriving");
    expect(output.match(/💡/g)).toHaveLength(2);
  });

  it("exposes the visible pending line without changing the combined thinking window", () => {
    const turn = status();
    expect(turn.toInput()).toMatchObject({ thinkingPending: "still arriving",
      thinking: ["first complete", "second complete", "last complete", "still arriving"] });
    turn.pushThinkingChunk("\n");
    expect(turn.toInput()).not.toHaveProperty("thinkingPending");
    expect(turn.toInput().thinking).toEqual(["first complete", "second complete", "last complete", "still arriving"]);
  });

  it("shows just the latest complete line when nothing is arriving", () => {
    const turn = status();
    turn.pushThinkingChunk("\n");
    const output = text(turn);
    expect(output).not.toContain("last complete");
    expect(output).toContain("💡 still arriving");
    expect(output.match(/💡/g)).toHaveLength(1);
  });

  it("promotes the pending line and keeps it beside the next arriving line", () => {
    const turn = status();
    turn.pushThinkingChunk(" now complete\nnext partial");
    const output = text(turn);
    expect(output).not.toContain("last complete");
    expect(output).toContain("💡 still arriving now complete<br>💡 next partial");
    expect(output.match(/💡/g)).toHaveLength(2);
  });

  it("keeps pending and completed thoughts distinct across snapshot restore", () => {
    const turn = status();
    const restored = TurnStatus.restore(JSON.parse(JSON.stringify(turn.snapshot())));
    expect(text(restored)).toContain("💡 last complete<br>💡 still arriving");
    expect(text(restored).match(/💡/g)).toHaveLength(2);
    restored.pushThinkingChunk(" now complete\nnext partial");
    expect(text(restored)).toContain("💡 still arriving now complete<br>💡 next partial");
    expect(text(restored)).not.toContain("💡 now complete");
  });

  it("keeps legacy snapshots with only complete thinking lines readable", () => {
    const snapshot = status().snapshot();
    snapshot.input.thinking = ["old complete", "last complete"];
    Reflect.deleteProperty(snapshot.input, "thinkingPending");
    const output = text(TurnStatus.restore(snapshot));
    expect(output).not.toContain("old complete");
    expect(output).toContain("💡 last complete");
    expect(output.match(/💡/g)).toHaveLength(1);
  });

  it("keeps the five-line shared thinking window and the existing instruction filtering", () => {
    const turn = new TurnStatus({ model: "m", repoDisplay: "r" });
    turn.pushThinkingChunk("one\ntwo\nthree\nfour\nfive\nsix\npartial");
    expect(turn.thinkingWindow()).toEqual(["three", "four", "five", "six", "partial"]);
    expect(text(turn)).toContain("💡 six<br>💡 partial");
    turn.pushThinkingChunk(" tool specificity");
    expect(turn.toInput()).not.toHaveProperty("thinkingPending");
    expect(text(turn)).toContain("💡 six");
    expect(text(turn).match(/💡/g)).toHaveLength(1);
  });

  it("preserves the 200-character thinking trim", () => {
    const turn = new TurnStatus({ model: "m", repoDisplay: "r" });
    turn.pushThinkingChunk(`${"a".repeat(201)}\n${"b".repeat(201)}`);
    const output = text(turn);
    expect(output).toContain(`💡 ${"a".repeat(200)}…<br>💡 ${"b".repeat(200)}…`);
    expect(output).not.toContain("a".repeat(201));
    expect(output).not.toContain("b".repeat(201));
  });

  it("drops Action but keeps Repo, resolved-model author, state title, and brand", () => {
    const output = card(status());
    expect(output.header).toEqual({ title: "Working", subtitle: "gpt-6-astra (default)",
      imageUrl: "https://example.com/agent.png" });
    const fields = output.sections.flatMap(section => section.widgets)
      .flatMap(widget => "decoratedText" in widget ? [widget.decoratedText] : []);
    expect(fields).toEqual([{ topLabel: "Repo", text: "seam-acp", wrapText: true }]);
  });

  it("uses compact elapsed/context/effort labels and leaves the fast-mode segment unchanged", () => {
    const turn = status();
    turn.fastMode = "on";
    const output = text(turn);
    expect(output).toContain("⏱ 12s • 🪟 3% • 🧠 high • ⚡ fast on");
    expect(output).not.toContain("elapsed");
    expect(output).not.toContain("effort");
    expect(output).not.toContain("30k");
    expect(output).not.toContain("1m");
    turn.fastMode = "requested, not applied";
    expect(text(turn)).toContain("⚡ fast requested, not applied");
  });

  it("omits unknown context rather than inventing a percentage, and keeps default effort", () => {
    const turn = new TurnStatus({ model: "m", repoDisplay: "r" });
    turn.context = "30k / unknown";
    expect(text(turn)).toBe("⏱ 12s • 🧠 default");
  });

  it("keeps dispatch provenance and real-cause notices", () => {
    const turn = status();
    turn.titlePrefix = "📨 Handoff";
    turn.origin = { threadName: "Worker", promptExcerpt: "Check the card" };
    turn.notice = "Provider rejected the request: Invalid params (code -32602)";
    expect(card(turn).header?.title).toBe("📨 Handoff · Working");
    expect(JSON.stringify(card(turn))).toContain("Invalid params (code -32602)");
    expect(JSON.stringify(card(turn))).toContain("Check the card");
    expect(JSON.stringify(card(turn))).toContain("Worker");
  });

  it("does not remove an Action field from non-status panels", () => {
    const plain: StructuredPanel = { color: 0, title: "Information",
      fields: [{ name: "Action", value: "Approve" }] };
    expect(renderGoogleChatPanel(plain, "info").cardsV2[0]!.card.sections[0]!.widgets)
      .toEqual([{ decoratedText: { topLabel: "Action", text: "Approve", wrapText: true } }]);
  });

  it("sends and edits the compact card through the real Google Chat adapter", async () => {
    const { GoogleChatAdapter } = await import("../packages/core/src/platforms/google-chat/adapter.js");
    const request = vi.fn(async () => ({ name: "spaces/DM/messages/card", thread: { name: "spaces/DM/threads/T" } }));
    const adapter = new GoogleChatAdapter({ api: { request }, subscription: "projects/test/subscriptions/events",
      allowedUserIds: new Set(), defaultCwd: "/projects", logger: pino({ level: "silent" }), writeIntervalMs: 0 });
    const channel = { platform: "google-chat", id: "DM.T", parentId: "DM" };
    const turn = status();
    const ref = await adapter.sendPanel(channel, panel(turn));
    turn.pushThinkingChunk("\n");
    turn.setState("Done");
    await adapter.editPanel(ref, panel(turn));
    const calls = request.mock.calls as unknown as Array<[string, { method: string; data: GoogleChatCardsMessage }]>;
    expect(calls.map(([, request]) => request.method)).toEqual(["POST", "PATCH"]);
    expect(calls[0]![1].data.cardsV2[0]!.card.header?.title).toBe("Working");
    expect(paragraphs(calls[0]![1].data).join("\n").match(/💡/g)).toHaveLength(2);
    expect(calls[1]![1].data.cardsV2[0]!.card.header?.title).toBe("Done");
    expect(paragraphs(calls[1]![1].data).join("\n").match(/💡/g)).toHaveLength(1);
    for (const [, request] of calls) expect(JSON.stringify(request.data)).not.toContain('"topLabel":"Action"');
  });

  it("uses the same compact path for a restored dispatched status card", async () => {
    const cards: GoogleChatCardsMessage[] = [];
    const turn = TurnStatus.restore(status().snapshot());
    const dispatched = new DispatchStatusPanel(discordRenderer, turn, {
      post: async (panel) => { cards.push(renderGoogleChatPanel(panel, "dispatch")); return "card"; },
      edit: async (_ref, panel) => { cards.push(renderGoogleChatPanel(panel, "dispatch")); },
    });
    await dispatched.start();
    await dispatched.finalize("Done", "Completed");
    expect(cards.at(-1)?.cardsV2[0]!.card.header?.title).toBe("Done");
    expect(paragraphs(cards.at(-1)!).join("\n").match(/💡/g)).toHaveLength(2);
    expect(JSON.stringify(cards.at(-1))).not.toContain('"topLabel":"Action"');
  });
});
