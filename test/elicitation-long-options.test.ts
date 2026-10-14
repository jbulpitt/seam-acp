import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { ElicitationManager, validateFormRequest } from "../packages/core/src/core/elicitation/manager.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { ChatAdapter, ComponentEvent, ElicitationCardPost, MessageRef } from "../packages/core/src/platforms/chat-adapter.js";
import { DiscordAdapter } from "../packages/core/src/platforms/discord/adapter.js";
import { renderGoogleChatElicitationCard } from "../packages/core/src/platforms/google-chat/card-renderer.js";
import { parseGoogleChatCardClick } from "../packages/core/src/platforms/google-chat/card-click.js";
import { formatGoogleChatCardText } from "../packages/core/src/platforms/google-chat/card-text.js";

const label = "Use the existing Gemini account with its normal sign-in flow and preserve the current project configuration until the operator confirms the next step.";
const description = "Sign in with the existing account rather than creating another one. Keep the complete explanation visible so the user can compare the choices before answering.";
const original = `  native-value,${"unchanged-".repeat(14)}🧠  `;
const form = (property: Record<string, unknown>): CreateElicitationRequest => ({
  mode: "form", sessionId: "acp-1", message: "How should the app log in to Gemini?",
  requestedSchema: { type: "object", properties: { question_0: property }, required: ["question_0"] },
});
const checked = (request: CreateElicitationRequest) => validateFormRequest(request as Parameters<typeof validateFormRequest>[0]);
const titled = (title = label, value = original, detail = description) => ({ title, const: value, description: detail });

const cases = [
  { name: "single short label with long description", property: { type: "string", oneOf: [titled("Existing account", "existing", description), titled("Keep", "keep", "Keep the existing setup.")] },
    options: [{ label: "Existing account", description }, { label: "Keep", description: "Keep the existing setup." }], indices: ["0"], answer: "existing" },
  { name: "single oneOf buttons", property: { type: "string", oneOf: [titled(), titled("Keep", "keep", "Keep the existing setup.")] },
    options: [{ label, description }, { label: "Keep", description: "Keep the existing setup." }], indices: ["0"], answer: original },
  { name: "single enum select", property: { type: "string", enum: [original, "two", "three", "four", "five"] },
    options: [original, "two", "three", "four", "five"].map(label => ({ label })), indices: ["0"], answer: original },
  { name: "multi items.anyOf select", property: { type: "array", items: { anyOf: [titled(), titled("Keep", "keep", "Keep the existing setup.")] }, minItems: 1, maxItems: 2 },
    options: [{ label, description }, { label: "Keep", description: "Keep the existing setup." }], indices: ["1", "0"], answer: ["keep", original] },
  { name: "multi items.enum select", property: { type: "array", items: { type: "string", enum: [original, "keep"] }, minItems: 1, maxItems: 2 },
    options: [{ label: original }, { label: "keep" }], indices: ["0", "1"], answer: [original, "keep"] },
];

describe("elicitation option limits", () => {
  it.each(cases)("accepts long original options in $name without rewriting the schema", ({ property }) => {
    const request = form(property), before = JSON.stringify(request);
    expect(checked(request).ok).toBe(true);
    expect(JSON.stringify(request)).toBe(before);
  });

  it.each(["title", "const", "description"])("accepts the 500-character sanity bound for %s", field => {
    expect(checked(form({ type: "string", oneOf: [{ ...titled("Pick", "pick", "Details"), [field]: "L".repeat(500) }] })).ok).toBe(true);
  });

  it.each(["title", "const", "description"])("names the 500-character Seam bound for oversized %s", field => {
    const result = checked(form({ type: "string", oneOf: [{ ...titled("Pick", "pick", "Details"), [field]: "L".repeat(501) }] }));
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/Seam.*500|500.*Seam/) });
  });

  it("still names the 25-option limit and rejects duplicate original values", () => {
    expect(checked(form({ type: "string", enum: Array.from({ length: 26 }, (_, i) => `option-${i}`) })))
      .toMatchObject({ ok: false, error: expect.stringContaining("25") });
    expect(checked(form({ type: "string", oneOf: [titled("A", original), titled("B", original)] })))
      .toMatchObject({ ok: false, error: expect.stringContaining("duplicate choice values") });
  });

  it("names the 65536-byte wire limit independently of control text limits", () => {
    const request = { ...form({ type: "string", enum: ["one"] }), _meta: { opaque: "x".repeat(65536) } };
    expect(checked(request)).toMatchObject({ ok: false, error: expect.stringMatching(/65536.*byte|byte.*65536/) });
  });
});

let dir: string;
let store: SessionStore;
let managers: ElicitationManager[];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-elicit-long-"));
  store = new SessionStore(path.join(dir, "state.db"));
  managers = [];
});
afterEach(() => {
  for (const manager of managers) manager.detach();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function harness(platform = "discord") {
  const channel = { platform, id: "thread-1", parentId: "parent-1" };
  const record: SessionRecord = {
    id: `${platform}:thread-1`, platform, channelRef: channel.id, parentRef: channel.parentId,
    agentId: "test", acpSessionId: "acp-1", repoPath: "/repo", configJson: "{}",
    createdUtc: "2026-10-14T00:00:00.000Z", updatedUtc: "2026-10-14T00:00:00.000Z",
  };
  store.upsert(record);
  const sent: any[] = [], edited: any[] = [], cards: ElicitationCardPost[] = [];
  const discord = Object.create(DiscordAdapter.prototype) as DiscordAdapter;
  (discord as any).fetchSendableChannel = async () => ({ guildId: "guild-1",
    send: async (payload: any) => { sent.push(payload); return { id: `message-${sent.length}` }; },
    messages: { fetch: async () => ({ edit: async (payload: any) => { edited.push(payload); } }) },
  });
  const adapter = {
    sendElicitationCard: async (channel: MessageRef["channel"], card: ElicitationCardPost) => {
      cards.push(card);
      if (platform === "discord") return discord.sendElicitationCard(channel, card);
      sent.push(renderGoogleChatElicitationCard(card, "elicitation"));
      return { channel, id: "spaces/dm/messages/card" };
    },
    editElicitationCard: async (ref: MessageRef, card: ElicitationCardPost) => {
      cards.push(card);
      if (platform === "discord") return discord.editElicitationCard(ref, card);
      edited.push(renderGoogleChatElicitationCard(card, "elicitation"));
    },
  };
  const manager = new ElicitationManager({ store, adapter: adapter as unknown as ChatAdapter,
    logger: pino({ level: "silent" }) as unknown as Logger, currentUserId: () => "user-1" });
  managers.push(manager);
  const event = (customId: string, overrides: Partial<ComponentEvent> = {}): ComponentEvent => ({
    interactionId: "click-1", customId, userId: "user-1", userName: "User", channel,
    messageId: store.listOpenElicitations()[0]?.messageId ?? "", kind: "button",
    replyEphemeral: vi.fn(async () => {}), followUpEphemeral: vi.fn(async () => {}),
    editReplyEphemeral: vi.fn(async () => {}), replyEphemeralView: vi.fn(async () => "view"),
    updateEphemeralView: vi.fn(async () => {}), followUpEphemeralFile: vi.fn(async () => {}),
    deferUpdate: vi.fn(async () => {}), showModal: vi.fn(async () => {}), ...overrides,
  });
  const create = async (request: CreateElicitationRequest) => {
    const result = manager.create(record, request, { requestId: 1, signal: new AbortController().signal });
    await new Promise(resolve => setImmediate(resolve));
    expect(store.listOpenElicitations()).toHaveLength(1);
    return { result, row: store.listOpenElicitations()[0]! };
  };
  return { manager, sent, edited, cards, event, create };
}

function discordControls(payload: any): any[] {
  return payload.components.flatMap((row: any) => row.toJSON().components);
}
function googleWidgets(payload: any): any[] {
  return payload.cardsV2.flatMap((card: any) => card.card.sections.flatMap((section: any) => section.widgets));
}
function fullEntry(option: { label: string; description?: string }, index: number): string {
  return `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`;
}

describe("Discord elicitation full text and original answers", () => {
  it.each(cases)("renders and answers $name with the exact original value", async ({ property, options, indices, answer }) => {
    const h = harness(), { result, row } = await h.create(form(property));
    const payload = h.sent.at(-1), controls = discordControls(payload);
    for (const [i, option] of options.entries()) expect(h.sent.map(p => p.content ?? "").join("\n\n")).toContain(fullEntry(option, i));
    const select = controls.find(control => control.type === 3);
    if (select) {
      expect(select.options.map((option: any) => option.value)).toEqual(options.map((_, i) => String(i)));
      for (const [i, option] of select.options.entries()) {
        expect(option.label).toMatch(new RegExp(`^${i + 1}\\. `));
        expect(option.label.length).toBeLessThanOrEqual(100);
        if (options[i]!.label.length > 100) expect(option.label).toMatch(/…$/);
        if (option.description) expect(option.description.length).toBeLessThanOrEqual(100);
        if ("description" in options[i]! && options[i]!.description!.length > 100) {
          expect(option.description).toMatch(/…$/);
          expect(options[i]!.description).toContain(`${option.description.slice(0, -1)} `);
        }
      }
      await h.manager.handleComponent(h.event(select.custom_id, { kind: "select", values: indices }));
    } else {
      const choices = controls.filter(control => control.custom_id.includes(":choice:"));
      for (const [i, button] of choices.entries()) {
        expect(button.label).toMatch(new RegExp(`^${i + 1}\\. `));
        expect(button.label.length).toBeLessThanOrEqual(80);
      }
      if (options[0]!.label.length > 80) {
        expect(choices[0].label).toMatch(/…$/);
        const prefix = choices[0].label.slice(3, -1);
        expect(options[0]!.label).toContain(`${prefix} `);
      }
      await h.manager.handleComponent(h.event(choices[0].custom_id));
    }
    expect(controls.find(control => control.custom_id?.includes(":cancel:")).label).toBe("Cancel");
    await expect(result).resolves.toEqual({ action: "accept", content: { question_0: answer } });
    expect(store.getElicitation(row.id)?.valuesJson).toBe("{}");
    expect(h.edited.at(-1).components).toEqual([]);
    expect(h.edited.at(-1).content).toBe(payload.content);
    expect(h.sent).toHaveLength(1);
  });

  it("lists even short options and descriptions, with matching numbered buttons", async () => {
    const h = harness();
    const { result } = await h.create(form({ type: "string", oneOf: [titled("Existing account", "existing", "Keep the current setup."), titled("New account", "new", "Use a separate setup.")] }));
    expect(h.sent[0].content).toBe("1. Existing account — Keep the current setup.\n\n2. New account — Use a separate setup.");
    const controls = discordControls(h.sent[0]);
    expect(controls.map(button => button.label)).toEqual(["1. Existing account", "2. New account", "Cancel"]);
    await h.manager.handleComponent(h.event(controls[0].custom_id));
    await expect(result).resolves.toEqual({ action: "accept", content: { question_0: "existing" } });
  });

  it("publishes all 25 full 500-character labels and descriptions in bounded continuations, without reposting on settlement", async () => {
    const options = Array.from({ length: 25 }, (_, i) => titled(`${i + 1} ${"label word ".repeat(50)}`.slice(0, 500), `native-${i}`, `${i + 1} ${"description word ".repeat(40)}`.slice(0, 500)));
    const h = harness(), { result } = await h.create(form({ type: "array", items: { anyOf: options }, minItems: 1, maxItems: 25 }));
    expect(h.sent.length).toBeGreaterThan(1);
    for (const payload of h.sent) {
      expect(payload.content.length).toBeLessThanOrEqual(2000);
      expect(payload.allowedMentions).toEqual({ parse: [] });
    }
    for (const [i, option] of options.entries()) {
      const entry = fullEntry({ label: option.title, description: option.description }, i);
      expect(h.sent.filter(payload => payload.content.includes(entry))).toHaveLength(1);
    }
    expect(h.sent.slice(0, -1).every(payload => !payload.components?.length)).toBe(true);
    const select = discordControls(h.sent.at(-1))[0], count = h.sent.length;
    await h.manager.handleComponent(h.event(select.custom_id, { kind: "select", values: ["24", "0"] }));
    await expect(result).resolves.toEqual({ action: "accept", content: { question_0: ["native-24", "native-0"] } });
    expect(h.sent).toHaveLength(count);
    expect(h.edited.at(-1).content).toBe(h.sent.at(-1).content);
  });

  it("does not split emoji while excerpting controls and descriptions", async () => {
    const h = harness(), { result } = await h.create(form({ type: "array", items: { anyOf: [titled("🧠".repeat(80), "brain", "🧠".repeat(80))] }, minItems: 1, maxItems: 1 }));
    const select = discordControls(h.sent[0])[0], option = select.options[0];
    for (const text of [option.label, option.description]) {
      expect(text.length).toBeLessThanOrEqual(100);
      expect(text).toMatch(/…$/);
      expect(Array.from(text as string).some(char => char.length === 1 && /[\uD800-\uDFFF]/u.test(char))).toBe(false);
    }
    await h.manager.handleComponent(h.event(select.custom_id, { kind: "select", values: ["0"] }));
    await expect(result).resolves.toEqual({ action: "accept", content: { question_0: ["brain"] } });
  });

  it("keeps boolean and sign-in controls unnumbered", async () => {
    const h = harness(), boolean = await h.create(form({ type: "boolean" }));
    const controls = discordControls(h.sent[0]);
    expect(controls.map(button => button.label)).toEqual(["Yes", "No", "Cancel"]);
    expect(h.sent[0].content ?? "").toBe("");
    await h.manager.handleComponent(h.event(controls[0].custom_id));
    await expect(boolean.result).resolves.toEqual({ action: "accept", content: { question_0: true } });
    const signIn = await h.create({ mode: "url", sessionId: "acp-1", message: "Sign in on the provider page.", elicitationId: "external", url: "https://example.test/authorize" });
    const signInControls = discordControls(h.sent.at(-1));
    expect(signInControls.map(button => button.label)).toEqual(["Open secure page", "Cancel"]);
    await h.manager.handleComponent(h.event(signInControls[1].custom_id));
    await expect(signIn.result).resolves.toEqual({ action: "cancel" });
  });

  it("includes complete options from multi-question forms without numbering the modal controls", async () => {
    const h = harness();
    const property = { type: "string", oneOf: [titled(), titled("Keep", "keep", "Keep the existing setup.")] };
    const request: CreateElicitationRequest = { ...form(property), requestedSchema: {
      type: "object", properties: {
        question_0: property,
        note: { type: "string" },
      }, required: ["question_0", "note"],
    } };
    const { result } = await h.create(request);
    expect(h.sent.map(p => p.content ?? "").join("\n\n")).toContain(label);
    expect(h.sent.map(p => p.content ?? "").join("\n\n")).toContain(description);
    const controls = discordControls(h.sent.at(-1));
    expect(controls.map(button => button.label)).toEqual(["Answer", "Cancel"]);
    const open = h.event(controls[0].custom_id);
    await h.manager.handleComponent(open);
    const modal = vi.mocked(open.showModal).mock.calls[0]![0];
    await h.manager.handleComponent(h.event(modal.customId, { kind: "modal", fields: { f0: original, f1: "Keep moving" } }));
    await expect(result).resolves.toEqual({ action: "accept", content: { question_0: original, note: "Keep moving" } });
  });
});

describe("Google Chat elicitation full text and original answers", () => {
  it.each(cases)("renders and round-trips $name to the original response", async ({ property, options, indices, answer }) => {
    const h = harness("google-chat"), { result } = await h.create(form(property));
    const widgets = googleWidgets(h.sent[0]);
    for (const [i, option] of options.entries()) {
      expect(widgets.some(widget => widget.textParagraph?.text.includes(formatGoogleChatCardText(fullEntry(option, i))))).toBe(true);
    }
    const select = widgets.find(widget => widget.selectionInput)?.selectionInput;
    let action;
    if (select) {
      expect(select.items.map((item: any) => item.value)).toEqual(options.map((_, i) => String(i)));
      for (const [i, item] of select.items.entries()) {
        expect(item.text).toMatch(new RegExp(`^${i + 1}\\. `));
        expect(item.text.length).toBeLessThanOrEqual(100);
        if (options[i]!.label.length > 100) expect(item.text).toMatch(/…$/);
      }
      action = select.onChangeAction;
    } else {
      const buttons = widgets.find(widget => widget.buttonList).buttonList.buttons;
      expect(buttons[0].text).toMatch(/^1\. /);
      expect(buttons[0].text.length).toBeLessThanOrEqual(80);
      if (options[0]!.label.length > 80) {
        expect(buttons[0].text).toMatch(/…$/);
        expect(options[0]!.label).toContain(`${buttons[0].text.slice(3, -1)} `);
      }
      expect(buttons.at(-1).text).toBe("Cancel");
      action = buttons[0].onClick.action;
    }
    const parsed = parseGoogleChatCardClick({ type: "CARD_CLICKED", user: { name: "user-1", displayName: "User" },
      message: { name: "spaces/dm/messages/card" }, action: { actionMethodName: action.function, parameters: action.parameters },
      ...(select ? { common: { formInputs: { elicitationSelection: { stringInputs: { value: indices } } } } } : {}),
    }, { channel: { platform: "google-chat", id: "thread-1", parentId: "parent-1" }, interactionId: "pubsub-click" });
    expect(parsed?.type).toBe("component");
    if (parsed?.type !== "component") throw new Error("Expected an elicitation component");
    await h.manager.handleComponent(h.event(parsed.interaction.customId, parsed.interaction));
    await expect(result).resolves.toEqual({ action: "accept", content: { question_0: answer } });
    const settled = googleWidgets(h.edited.at(-1));
    expect(settled.some(widget => widget.buttonList || widget.selectionInput)).toBe(false);
    for (const [i, option] of options.entries()) expect(settled.some(widget => widget.textParagraph?.text.includes(formatGoogleChatCardText(fullEntry(option, i))))).toBe(true);
  });
});
