import { describe, expect, it } from "vitest";
import { parseChoiceSpec, renderChoicePanel, type ChoiceCard } from "../packages/core/src/core/choice/types.js";
import { planChoiceDispatch, planChoiceMultiDispatch } from "../packages/core/src/core/choice/emit.js";
import { buildChoiceCardComponents, DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import { renderGoogleChatChoiceCard } from "../packages/core/src/platforms/google-chat/card-renderer.js";
import type { ChoiceCardPost } from "../packages/core/src/platforms/chat-adapter.js";

const longLabel = "Review the complete migration plan with the operator before changing the controller, bridge or session daemon, keeping every live turn running throughout the rollout.";
function card(labels = [longLabel, "Keep the existing configuration"]): ChoiceCard {
  return { id: "long-pick", platform: "discord", channelRef: "111", parentRef: "222", messageId: null,
    title: "Choose the next step", body: "No work starts until you choose.", maxClicks: 1, targetUserId: null,
    defaultTarget: { type: "live" }, options: labels.map(label => ({ label, kind: "prompt", payload: `Act on ${label}` })),
    clickCount: 0, status: "open", lastClickerId: null, lastClickerName: null, lastOptionIndex: null,
    createdBy: "discord:111", createdUtc: "2026-10-13T00:00:00Z", ingestTokenHash: null,
    ingestOptionIndex: null, resultSchema: null, ingestWrapper: null, ingestCors: null };
}
function post(c = card()): ChoiceCardPost {
  return { choiceId: c.id, panel: renderChoicePanel(c), options: c.options, ...(c.select ? { select: c.select } : {}) };
}
function transport() {
  const sent: any[] = [], edited: any[] = [];
  const channel = { guildId: "333", send: async (payload: any) => {
    sent.push(payload); return { id: `message-${sent.length}` };
  }, messages: { fetch: async () => ({ edit: async (payload: any) => { edited.push(payload); } }) } };
  const adapter = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
  (adapter as any).fetchSendableChannel = async () => channel;
  return { adapter, sent, edited, channel: { platform: "discord", id: "111" } };
}

describe("long choice labels", () => {
  it.each([81, 100, 500])("accepts a %i-character frozen label without changing it", length => {
    const label = "L".repeat(length);
    const parsed = parseChoiceSpec({ title: "Pick", options: [{ label, kind: "prompt", payload: "Continue" }] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.spec.options[0]!.label).toBe(label);
  });

  it("still rejects empty labels and names the 500-character Seam bound", () => {
    const empty = parseChoiceSpec({ title: "Pick", options: [{ label: "   ", kind: "prompt", payload: "Continue" }] });
    expect(empty.ok).toBe(false);
    const oversized = parseChoiceSpec({ title: "Pick", options: [{ label: "L".repeat(501), kind: "prompt", payload: "Continue" }] });
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.error).toMatch(/Seam.*500|500.*Seam/);
  });

  it("names Discord's option-count limit rather than refusing a long valid label", () => {
    const parsed = parseChoiceSpec({ title: "Pick", options: card(Array(26).fill("Keep")).options });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("Discord");
  });

  it("uses numbered word-boundary ellipses within the Discord button limit", () => {
    const c = card();
    const before = JSON.stringify(c.options);
    const controls = buildChoiceCardComponents(post(c)).flatMap(row => row.toJSON().components) as any[];
    expect(controls[0].label).toMatch(/^1\. .*…$/);
    expect(controls[0].label.length).toBeLessThanOrEqual(80);
    const visible = controls[0].label.replace(/^1\. /, "").slice(0, -1);
    expect(longLabel).toContain(`${visible} `);
    expect(controls[0].custom_id).toBe("choice:long-pick:0");
    expect(JSON.stringify(c.options)).toBe(before);
  });

  it("keeps Unicode controls within the code-unit cap without splitting characters", () => {
    const controls = buildChoiceCardComponents(post(card(["🧠".repeat(80)]))).flatMap(row => row.toJSON().components) as any[];
    expect(controls[0].label.length).toBeLessThanOrEqual(80);
    expect(controls[0].label).toMatch(/…$/);
    expect(Array.from(controls[0].label).some((c: string) => c.length === 1 && /[\uD800-\uDFFF]/.test(c))).toBe(false);
  });

  it.each([false, true])("uses a 100-character select label and useful overflow description (explicit=%s)", explicit => {
    const c = card(explicit ? [longLabel, "Keep"] : [longLabel, ...Array.from({ length: 15 }, (_, i) => `Option ${i + 2}`)]);
    if (explicit) c.select = { min: 1, max: 2 };
    const controls = buildChoiceCardComponents(post(c)).flatMap(row => row.toJSON().components) as any[];
    const option = controls[0].options[0];
    expect(option.label).toMatch(/^1\. .*…$/);
    expect(option.label.length).toBeLessThanOrEqual(100);
    expect(option.description).toBeTruthy();
    expect(option.description.length).toBeLessThanOrEqual(100);
    const prefix = option.label.replace(/^1\. /, "").slice(0, -1);
    const overflow = option.description.replace(/…$/, "");
    expect(longLabel).toContain(`${prefix} ${overflow}`);
    expect(option.value).toBe("0");
  });

  it("publishes every full numbered label in the Discord card body", async () => {
    const h = transport(), c = card();
    const ref = await h.adapter.sendChoiceCard(h.channel, post(c));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].content).toContain(`1. ${longLabel}`);
    expect(h.sent[0].content).toContain(`2. ${c.options[1]!.label}`);
    expect(ref.id).toBe("message-1");
    expect(h.sent[0].embeds[0].toJSON().description).toBe(c.body);
  });

  it("continues a maximum-size full list without dropping options or exceeding message limits", async () => {
    const c = card(Array.from({ length: 25 }, (_, i) => `${i + 1}: ${"word ".repeat(100)}`.slice(0, 500)));
    c.select = { min: 1, max: 25 };
    const h = transport();
    const ref = await h.adapter.sendChoiceCard(h.channel, post(c));
    expect(h.sent.length).toBeGreaterThan(1);
    for (const payload of h.sent) expect(payload.content.length).toBeLessThanOrEqual(2000);
    for (const [i, option] of c.options.entries()) {
      expect(h.sent.filter(payload => payload.content.includes(`${i + 1}. ${option.label}`))).toHaveLength(1);
    }
    expect(h.sent.slice(0, -1).every(payload => !payload.components?.length)).toBe(true);
    expect(h.sent.at(-1).components).toHaveLength(2);
    expect(ref.id).toBe(`message-${h.sent.length}`);
  });

  it("retains the same full-label body on edit and does not repost continuation messages", async () => {
    const h = transport(), c = card();
    const ref = await h.adapter.sendChoiceCard(h.channel, post(c));
    const sent = h.sent.length;
    await h.adapter.editChoiceCard(ref, { ...post(c), hideButtons: true });
    expect(h.edited[0].content).toContain(longLabel);
    expect(h.edited[0].content).toBe(h.sent.at(-1).content);
    expect(h.edited[0].components).toEqual([]);
    expect(h.sent).toHaveLength(sent);
  });

  it("leaves ordinary short-label button cards unchanged", async () => {
    const c = card(["Keep", "Change"]), h = transport();
    await h.adapter.sendChoiceCard(h.channel, post(c));
    expect(h.sent[0].content ?? "").toBe("");
    const controls = buildChoiceCardComponents(post(c)).flatMap(row => row.toJSON().components) as any[];
    expect(controls.map(c => c.label)).toEqual(["Keep", "Change"]);
  });

  it.each([false, true])("keeps full labels in Google Chat controls and numbered card text (select=%s)", select => {
    const c = card(); if (select) c.select = { min: 1, max: 2 };
    const widgets = renderGoogleChatChoiceCard(post(c)).cardsV2[0]!.card.sections[0]!.widgets as any[];
    expect(widgets.some(widget => widget.textParagraph?.text.includes(`1. ${longLabel}`))).toBe(true);
    if (select) expect(widgets.find(w => w.selectionInput).selectionInput.items[0]).toMatchObject({ text: longLabel, value: "0" });
    else expect(widgets.find(w => w.buttonList).buttonList.buttons[0].text).toBe(longLabel);
  });

  it("emits the full chosen label and payload, never the displayed button excerpt", () => {
    const c = card();
    const planned = planChoiceDispatch({ card: c, optionIndex: 0, actor: { id: "1", name: "Alex" }, payload: c.options[0]!.payload!, authoringSession: null, enqueue: async () => {} });
    expect(planned.ok).toBe(true);
    if (planned.ok) {
      expect(planned.spec.prompt).toContain(`option "${longLabel}"`);
      expect(planned.spec.prompt).toContain(c.options[0]!.payload);
      expect(planned.spec.originPrompt).toBe(c.options[0]!.payload);
    }
  });

  it("emits full labels for a combined selection", () => {
    const c = card([longLabel, `${longLabel} Again.`]); c.select = { min: 1, max: 2 };
    const planned = planChoiceMultiDispatch({ card: c, optionIndices: [0, 1], actor: { id: "1", name: "Alex" }, authoringSession: null, enqueue: async () => {} });
    expect(planned.ok).toBe(true);
    if (planned.ok) for (const option of c.options) {
      expect(planned.spec.prompt).toContain(option.label);
      expect(planned.spec.prompt).toContain(option.payload);
    }
  });
});
