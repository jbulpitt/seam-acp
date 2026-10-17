import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { PubSubPullTransport } from "../packages/core/src/platforms/google-chat/transport.js";
import { seedLegacyChatRecords } from "./helpers/google-chat-legacy-fixture.js";

const logger = pino({ level: "silent" });
const stores: SessionStore[] = [], dirs: string[] = [];
afterEach(() => {
  stores.splice(0).forEach(store => store.close());
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
const ids = { agent: 3, model: 4, repo: 5, effort: 6 };
type Kind = keyof typeof ids;
const user = { name: "users/42", displayName: "Member" };
const originalThread = "spaces/dm/threads/original";
const cardName = "spaces/dm/messages/private-card";
function command(kind: Kind, args = "", threaded = false) {
  return { type: "MESSAGE", space: { name: "spaces/dm", spaceType: threaded ? "DIRECT_MESSAGE" : "SPACE" }, user,
    message: { name: `spaces/dm/messages/${kind}-${args || "open"}`, text: `/${kind} ${args}`.trim(),
      argumentText: args || null, slashCommand: { commandId: ids[kind] },
      ...(threaded ? { thread: { name: originalThread }, threadReply: true } : {}) } };
}
function buttons(cards: any): any[] {
  return cards?.cardsV2?.flatMap((entry: any) => entry.card.sections.flatMap((section: any) =>
    section.widgets.flatMap((widget: any) => widget.buttonList?.buttons ?? []))) ?? [];
}
function choice(cards: any, value: string) {
  const result = buttons(cards).find(button => button.onClick.action.parameters.some((p: any) => p.key === "value" && p.value === value));
  expect(result, `choice ${value}`).toBeDefined(); return result;
}
function control(cards: any, label: string) {
  const result = buttons(cards).find(button => button.text === label);
  expect(result, `button ${label}`).toBeDefined(); return result;
}
function click(button: any, threaded = false) {
  return { type: "CARD_CLICKED", space: { name: "spaces/dm", spaceType: threaded ? "DIRECT_MESSAGE" : "SPACE" }, user,
    // The private reply's thread is deliberately different from the session that opened it.
    message: { name: cardName, thread: { name: "spaces/dm/threads/card-reply" } },
    common: { invokedFunction: button.onClick.action.function },
    action: { actionMethodName: button.onClick.action.function, parameters: button.onClick.action.parameters } };
}
function setup(db = ":memory:", current = { agent: "codex", model: "model-0", effort: "low", cwd: "/remote/old", location: "remote" }) {
  const store = new SessionStore(db); stores.push(store);
  seedLegacyChatRecords(store, ["dm", "dm.original", "other"]);
  const writes: any[] = [];
  const request = vi.fn(async (scope: string, req: any): Promise<any> => {
    if (scope === "chat") writes.push(req);
    return { name: cardName, thread: req.data?.thread ?? { name: "spaces/dm/threads/card-reply" } };
  });
  const describeConfig = vi.fn(() => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, { value }])));
  const models = vi.fn(() => Array.from({ length: 14 }, (_, i) => ({ id: `model-${i}`, displayName: `Model ${i}` })));
  const model = vi.fn((_binding: unknown, id: string) => ({ id }));
  const listProfiles = vi.fn(() => [{ id: "codex", displayName: "Codex" }, { id: "grok", displayName: "Grok" }]);
  const effortChoices = vi.fn(() => ["low", "high"]);
  const listRepos = vi.fn(async () => ["/remote/old", "/remote/repo with spaces"]);
  const applyAgentChange = vi.fn(async (_ch: any, _record: any, value: string, _actor: any, respond: (text: string) => Promise<void>) => {
    current.agent = value; await respond("Agent switched. Session reset."); return { ok: true, message: "native" };
  });
  const applyModelChange = vi.fn(async (_ch: any, _record: any, value: string, _actor: any, respond: (text: string) => Promise<void>) => {
    current.model = value; await respond("Model changed. Runtime reloaded with the same context."); return { ok: true, message: "native" };
  });
  const configure = vi.fn(async (_source: any, _record: any, changes: { effort: string }) => {
    current.effort = changes.effort;
    return { ok: true, applied: changes, sessionReset: false, runtimeReloaded: true, warnings: [] };
  });
  const applyRepoChange = vi.fn(async (_ch: any, _record: any, value: string) => {
    current.cwd = value; return { ok: true, message: "Repo changed. Session reset.", sessionReset: true, resetPending: false };
  });
  const adapter = new GoogleChatAdapter({ api: { request }, subscription: "projects/test/subscriptions/events",
    allowedUserIds: new Set([user.name]), defaultCwd: "/projects", logger, writeIntervalMs: 0 });
  adapter.setCommandDeps({ store, router: { describeConfig, listProfiles, bindRecordLocation: () => current.location },
    mutation: {}, runtimeTransition: { applyAgentChange, applyModelChange, configure },
    configPlan: { listRepos, applyRepoChange }, modelCatalog: { models, model, effortChoices } } as any);
  const normal = vi.fn(async (message: any) => { await message.onAdmitted(); }); adapter.onMessage(normal);
  const transport = new PubSubPullTransport({ api: { request }, subscription: "projects/test/subscriptions/events", logger,
    receive: (event, signal, id) => adapter.receiveEvent(event, signal, id) });
  let sequence = 0;
  const deliver = (event: unknown, id = `event-${++sequence}`) => transport.process({ ackId: `ack-${id}`,
    message: { messageId: id, data: Buffer.from(JSON.stringify(event)).toString("base64") } });
  const latest = () => writes.at(-1)?.data;
  return { adapter, store, current, writes, request, models, model, listProfiles, effortChoices, listRepos,
    applyAgentChange, applyModelChange, configure, applyRepoChange, normal, deliver, latest };
}

describe("private Google Chat config pickers", () => {
  it.each(["agent", "model", "effort", "repo"] as const)("opens /%s privately with the effective current choice and host choices", async kind => {
    const h = setup(); await h.deliver(command(kind));
    expect(h.latest()).toMatchObject({ privateMessageViewer: { name: user.name }, cardsV2: expect.any(Array) });
    const value = kind === "repo" ? h.current.cwd : h.current[kind];
    expect(choice(h.latest(), value).text).toContain("current");
    if (kind === "agent") expect(h.listProfiles).toHaveBeenCalledWith("remote");
    if (kind === "model") expect(h.models).toHaveBeenCalledWith({ agentId: "codex", location: "remote" }, { current: "model-0" });
    if (kind === "effort") {
      expect(h.effortChoices).toHaveBeenCalledWith({ agentId: "codex", location: "remote" }, "model-0");
      choice(h.latest(), "auto");
    }
    if (kind === "repo") expect(h.listRepos).toHaveBeenCalledWith(h.store.getByChannel("google-chat", "dm"));
    expect(h.normal).not.toHaveBeenCalled(); expect(h.applyModelChange).not.toHaveBeenCalled();
  });

  it.each([
    ["agent", "grok", "Agent switched. Session reset."],
    ["model", "model-1", "Model changed. Runtime reloaded with the same context."],
    ["effort", "high", "Effort set to high. Session not reset. Runtime reloaded with the same context."],
    ["repo", "/remote/repo with spaces", "Repo changed. Session reset."],
  ] as const)("applies /%s through its typed operation, then PATCHes the whole private card", async (kind, value, result) => {
    const h = setup(); await h.deliver(command(kind));
    await h.deliver(click(choice(h.latest(), value)));
    const operation = kind === "agent" ? h.applyAgentChange : kind === "model" ? h.applyModelChange
      : kind === "repo" ? h.applyRepoChange : h.configure;
    expect(operation).toHaveBeenCalledOnce();
    if (kind === "effort") expect(operation.mock.calls[0]).toMatchObject([
      h.store.getByChannel("google-chat", "dm"), h.store.getByChannel("google-chat", "dm"), { effort: value }, { id: "42", name: "Member" },
    ]);
    else expect(operation.mock.calls[0]).toMatchObject([
      { platform: "google-chat", id: "dm" }, h.store.getByChannel("google-chat", "dm"), value, { id: "42", name: "Member" },
      ...(kind === "repo" ? [] : [expect.any(Function)]),
    ]);
    expect(h.writes.at(-1)).toMatchObject({ method: "PATCH", url: `https://chat.googleapis.com/v1/${cardName}`, params: { updateMask: "cardsV2" } });
    expect(JSON.stringify(h.latest())).toContain(result);
    expect(choice(h.latest(), value).text).toContain("current");
    expect(h.latest()).not.toHaveProperty("privateMessageViewer");
  });

  it("keeps a DM picker bound to the invoking session instead of the private reply thread", async () => {
    const h = setup(); await h.deliver(command("model", "", true));
    expect(h.latest().thread).toEqual({ name: originalThread });
    await h.deliver(click(choice(h.latest(), "model-1"), true));
    expect(h.applyModelChange.mock.calls[0]![0]).toEqual({ platform: "google-chat", id: "dm.original", parentId: "dm" });
  });

  it("pages long lists and cancels without changing configuration", async () => {
    const h = setup(); await h.deliver(command("model"));
    const original = structuredClone(h.current);
    const first = h.latest();
    await h.deliver(click(control(first, "Next")));
    expect(JSON.stringify(h.latest())).not.toBe(JSON.stringify(first));
    await h.deliver(click(control(h.latest(), "Prev")));
    expect(choice(h.latest(), "model-0").text).toContain("current");
    await h.deliver(click(control(h.latest(), "Cancel")));
    expect(JSON.stringify(h.latest())).toContain("Cancelled"); expect(buttons(h.latest())).toEqual([]);
    expect(h.current).toEqual(original); expect(h.applyModelChange).not.toHaveBeenCalled();
  });

  it("retains the selected page and refreshes the marked model after a switch", async () => {
    const h = setup(); await h.deliver(command("model"));
    await h.deliver(click(control(h.latest(), "Next")));
    await h.deliver(click(choice(h.latest(), "model-7")));
    expect(choice(h.latest(), "model-7").text).toContain("current");
    expect(JSON.stringify(h.latest())).toContain("Page 2/3");
  });

  it("marks the catalog's canonical model when the effective value is an alias", async () => {
    const h = setup(); h.current.model = "default";
    h.model.mockReturnValueOnce({ id: "model-0" });
    await h.deliver(command("model"));
    expect(choice(h.latest(), "model-0").text).toContain("current");
  });

  it("preserves the typed transition's no-op response when the current model is selected", async () => {
    const h = setup(); await h.deliver(command("model"));
    h.applyModelChange.mockImplementationOnce(async (_ch, _record, _value, _actor, respond) => {
      await respond("Already using model-0. Session unchanged."); return { ok: true, message: "native" };
    });
    await h.deliver(click(choice(h.latest(), "model-0")));
    expect(h.applyModelChange).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.latest())).toContain("Already using model-0. Session unchanged.");
  });

  it("keeps the shared operation's refusal and current value visible", async () => {
    const h = setup(); await h.deliver(command("model"));
    h.applyModelChange.mockImplementationOnce(async (_ch, _record, _value, _actor, respond) => {
      await respond("Host rejected model: provider returned unknown_model"); return { ok: false, error: "unknown_model" } as any;
    });
    await h.deliver(click(choice(h.latest(), "model-1")));
    expect(JSON.stringify(h.latest())).toContain("Host rejected model: provider returned unknown_model");
    expect(choice(h.latest(), "model-0").text).toContain("current");
  });

  it("shows the actual host repo-list error privately", async () => {
    const h = setup(); h.listRepos.mockRejectedValueOnce(new Error("bridge remote: listWorkspaces disconnected"));
    await h.deliver(command("repo"));
    expect(h.latest()).toHaveProperty("cardsV2");
    expect(JSON.stringify(h.latest())).toContain("bridge remote: listWorkspaces disconnected");
  });

  it.each(["PATCH", "ACK"])("does not apply twice after a failed %s and durable receipt recovery", async failure => {
    const dir = mkdtempSync(join(tmpdir(), "seam-config-picker-")); dirs.push(dir);
    const db = join(dir, "sessions.db");
    const h = setup(db); await h.deliver(command("model"));
    const event = click(choice(h.latest(), "model-1"));
    if (failure === "PATCH") vi.spyOn(h.adapter, "editPrivateCards").mockRejectedValueOnce(new Error("Chat PATCH connection reset"));
    else {
      let failPatch = true;
      h.request.mockImplementation(async (scope, req) => {
        if (scope === "pubsub") throw new Error("Pub/Sub ACK connection reset");
        if (failPatch) { failPatch = false; throw new Error("Chat PATCH connection reset"); }
        h.writes.push(req); return {};
      });
    }
    await expect(h.deliver(event, "redelivered-click")).rejects.toThrow("connection reset");
    expect(h.applyModelChange).toHaveBeenCalledOnce();
    h.store.close(); stores.splice(stores.indexOf(h.store), 1);
    const recovered = setup(db, h.current);
    await recovered.deliver(event, "redelivered-click");
    expect(recovered.applyModelChange).not.toHaveBeenCalled();
    if (failure === "PATCH") expect(JSON.stringify(recovered.latest())).toContain("Model changed.");
    else expect(recovered.writes).toHaveLength(0);
  });

  it("lets another Space admit a command while a picker config transition is still running", async () => {
    const h = setup(); await h.deliver(command("model"));
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    h.applyModelChange.mockImplementationOnce(async (_ch, _record, _value, _actor, respond) => {
      await pending; await respond("Model switched after reload"); return { ok: true, message: "native" };
    });
    const slow = h.deliver(click(choice(h.latest(), "model-1")));
    await vi.waitFor(() => expect(h.applyModelChange).toHaveBeenCalledOnce());
    try {
      const other = command("effort");
      other.space.name = "spaces/other"; other.message.name = "spaces/other/messages/effort-open";
      await h.deliver(other);
      expect(h.latest()).toHaveProperty("cardsV2");
      expect(h.request.mock.calls.some(([scope, req]) => scope === "pubsub" && req.data.ackIds.includes("ack-event-3"))).toBe(true);
    } finally { release(); await slow; }
  });

  it("keeps typed unlisted model IDs on the original validation path", async () => {
    const h = setup(); await h.deliver(command("model", "provider-new-model"));
    expect(h.applyModelChange.mock.calls[0]![2]).toBe("provider-new-model");
    expect(h.latest().text).toBe("Model changed. Runtime reloaded with the same context.");
    expect(h.models).not.toHaveBeenCalled();
  });
});
