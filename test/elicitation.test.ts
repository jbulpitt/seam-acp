import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ClientCapabilities,
  type CreateElicitationRequest,
} from "@agentclientprotocol/sdk";
import type { AgentProfile } from "@seam/adapters";
import {
  ACP_CLIENT_CAPABILITIES,
  AgentRuntime,
} from "../packages/core/src/agents/agent-runtime.js";
import {
  ElicitationManager,
  validateFormRequest,
  validateUrlRequest,
} from "../packages/core/src/core/elicitation/manager.js";
import {
  elicitationCustomId,
  parseElicitationCustomId,
  type ElicitationRow,
} from "../packages/core/src/core/elicitation/types.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type {
  ChatAdapter,
  ComponentEvent,
  ElicitationCardPost,
  MessageRef,
} from "../packages/core/src/platforms/chat-adapter.js";
import { classifyDiscordInteraction } from "../packages/core/src/platforms/discord/adapter.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const logger = pino({ level: "silent" }) as unknown as Logger;

class FakeAdapter {
  sent: Array<{ ref: MessageRef; card: ElicitationCardPost }> = [];
  edits: Array<{ ref: MessageRef; card: ElicitationCardPost }> = [];
  nextMessage = 1;
  failPost = false;

  async sendElicitationCard(
    channel: MessageRef["channel"],
    card: ElicitationCardPost
  ): Promise<MessageRef> {
    if (this.failPost) throw new Error("post failed");
    const ref = { channel, id: String(this.nextMessage++) };
    this.sent.push({ ref, card });
    return ref;
  }

  async editElicitationCard(ref: MessageRef, card: ElicitationCardPost): Promise<void> {
    this.edits.push({ ref, card });
  }
}

const record: SessionRecord = {
  id: "discord:thread-1",
  platform: "discord",
  channelRef: "thread-1",
  parentRef: "parent-1",
  agentId: "test",
  acpSessionId: "acp-1",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: "2026-09-04T00:00:00.000Z",
  updatedUtc: "2026-09-04T00:00:00.000Z",
};

const form = (
  properties: Record<string, unknown>,
  required = Object.keys(properties)
): CreateElicitationRequest => ({
  mode: "form",
  sessionId: "acp-1",
  message: "Please answer before I continue.",
  requestedSchema: {
    type: "object",
    title: "A few details",
    properties,
    required,
  },
});

const urlRequest = (): CreateElicitationRequest => ({
  mode: "url",
  sessionId: "acp-1",
  message: "Complete sign-in on the provider page.",
  elicitationId: "external-1",
  url: "https://example.test/authorize?opaque=abc",
});

let dir: string;
let store: SessionStore;
let adapter: FakeAdapter;
let now: number;
let manager: ElicitationManager;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-elicit-"));
  store = new SessionStore(path.join(dir, "state.db"));
  store.upsert(record);
  adapter = new FakeAdapter();
  now = Date.parse("2026-09-04T12:00:00.000Z");
  manager = new ElicitationManager({
    store,
    adapter: adapter as unknown as ChatAdapter,
    logger,
    currentUserId: () => "user-1",
    now: () => now,
  });
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function pendingRow(): ElicitationRow {
  const rows = store.listOpenElicitations();
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

function event(
  customId: string,
  overrides: Partial<ComponentEvent> = {}
): ComponentEvent & { modal: ReturnType<typeof vi.fn>; replies: string[] } {
  const modal = vi.fn(async () => {});
  const replies: string[] = [];
  return {
    interactionId: randomId(),
    customId,
    userId: "user-1",
    userName: "User",
    channel: { platform: "discord", id: "thread-1", parentId: "parent-1" },
    messageId: pendingRow().messageId ?? "",
    kind: customId.includes(":submit:") ? "modal" : "button",
    replyEphemeral: async (value) => { replies.push(value); },
    followUpEphemeral: async (value) => { replies.push(value); },
    editReplyEphemeral: async (value) => { replies.push(value); },
    replyEphemeralView: async () => "view",
    updateEphemeralView: async () => {},
    followUpEphemeralFile: async () => {},
    deferUpdate: async () => {},
    showModal: modal,
    ...overrides,
    modal,
    replies,
  };
}

let serial = 0;
function randomId(): string {
  return `interaction-${++serial}`;
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("ACP v1 elicitation validation and capability", () => {
  it("advertises stable form and URL support while keeping filesystem disabled", () => {
    expect(ACP_CLIENT_CAPABILITIES).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      elicitation: { form: {}, url: {} },
    });
  });

  it("routes only the dedicated persistent custom-id prefix", () => {
    const base = {
      isAutocomplete: () => false,
      isChatInputCommand: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      isStringSelectMenu: () => false,
    };
    expect(classifyDiscordInteraction({
      ...base,
      customId: elicitationCustomId("cancel", "abc"),
    })).toBe("elicitation");
    expect(classifyDiscordInteraction({ ...base, customId: "seam-elicitx:cancel:abc" })).toBe("none");
  });

  it("accepts 20 ordered fields as four pages and rejects 21", () => {
    const twenty = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`field_${index}`, { type: "string" }])
    );
    const accepted = validateFormRequest(form(twenty) as Parameters<typeof validateFormRequest>[0]);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.value.pages.map((page) => page.length)).toEqual([5, 5, 5, 5]);
    const rejected = validateFormRequest(
      form({ ...twenty, extra: { type: "string" } }) as Parameters<typeof validateFormRequest>[0]
    );
    expect(rejected).toMatchObject({ ok: false });
  });

  it("rejects sensitive/unsupported/oversized forms and unsafe URLs", () => {
    expect(validateFormRequest(form({ password: { type: "string" } }) as never)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/URL elicitation/),
    });
    expect(validateFormRequest(form({ payload: { type: "object" } }) as never)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/unsupported/),
    });
    expect(validateFormRequest(form({ x: { type: "string", maxLength: 4001 } }) as never))
      .toMatchObject({ ok: false });
    expect(validateUrlRequest({ ...urlRequest(), url: "http://example.test" } as never))
      .toMatchObject({ ok: false });
    expect(validateUrlRequest({ ...urlRequest(), url: "https://u:p@example.test" } as never))
      .toMatchObject({ ok: false });
    expect(validateUrlRequest({ ...urlRequest(), message: "bad\u0000message" } as never))
      .toMatchObject({ ok: false });
  });

  it("parses only exact, bounded component actions", () => {
    expect(parseElicitationCustomId("seam-elicit:bool:id:1")).toEqual({
      kind: "boolean", id: "id", value: true,
    });
    expect(parseElicitationCustomId("seam-elicit:choice:id:01")).toEqual({
      kind: "choice", id: "id", index: 1,
    });
    expect(parseElicitationCustomId("seam-elicit:choice:id:1:extra")).toBeNull();
    expect(parseElicitationCustomId("seam-elicit:bool:id:yes")).toBeNull();
  });

  it("handles create and complete on the installed stable-v1 SDK transport", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      stderr,
      pid: undefined,
      killed: false,
      kill() {
        this.killed = true;
        this.emit("exit", 0, null);
        return true;
      },
    });
    let capabilities: ClientCapabilities | undefined;
    let agentSaw: unknown;
    const transportAgent = agent({ name: "elicitation-test-agent" })
      .onRequest(methods.agent.initialize, ({ params }) => {
        capabilities = params.clientCapabilities;
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false },
        };
      })
      .onRequest(methods.agent.session.new, () => ({ sessionId: "wire-session" }))
      .onRequest(methods.agent.session.prompt, async ({ client }) => {
        agentSaw = await client.request(methods.client.elicitation.create, {
          mode: "form",
          sessionId: "wire-session",
          message: "Pick",
          requestedSchema: {
            type: "object",
            properties: { ok: { type: "boolean" } },
            required: ["ok"],
          },
        });
        await client.notify(methods.client.elicitation.complete, { elicitationId: "done-1" });
        return { stopReason: "end_turn" };
      })
      .onNotification(methods.agent.session.cancel, () => {});
    const agentConnection = transportAgent.connect(
      ndJsonStream(
        Writable.toWeb(stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(stdin) as ReadableStream<Uint8Array>
      )
    );
    const createHandler = vi.fn(async () => ({ action: "accept" as const, content: { ok: true } }));
    const completeHandler = vi.fn(async () => {});
    const profile = {
      id: "wire",
      defaultModel: "default",
      spawn: () => child,
    } as unknown as AgentProfile;
    const runtime = new AgentRuntime({
      profile,
      logger,
      elicitationHandler: createHandler,
      completeElicitationHandler: completeHandler,
    });
    await runtime.start();
    await runtime.newSession({ cwd: "/tmp" });
    await expect(runtime.prompt("go")).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(capabilities).toMatchObject(ACP_CLIENT_CAPABILITIES);
    expect(agentSaw).toEqual({ action: "accept", content: { ok: true } });
    expect(createHandler).toHaveBeenCalledTimes(1);
    expect(createHandler.mock.calls[0]![1].signal.aborted).toBe(false);
    expect(completeHandler).toHaveBeenCalledWith({ elicitationId: "done-1" });
    await runtime.dispose();
    agentConnection.close();
  });
});

describe("Discord elicitation lifecycle", () => {
  it("posts the explanation first and completes a boolean on direct card buttons", async () => {
    const controller = new AbortController();
    const result = manager.create(
      record,
      form({ proceed: { type: "boolean", title: "Proceed?" } }),
      { requestId: 7, signal: controller.signal }
    );
    await tick();
    const row = pendingRow();
    expect(adapter.sent[0]!.card.panel.description).toContain("Please answer");
    expect(adapter.sent[0]!.card.buttons?.map((button) => button.label)).toEqual([
      "Yes", "No", "Cancel",
    ]);
    await manager.handleComponent(event(elicitationCustomId("bool", row.id, "1")));
    await expect(result).resolves.toEqual({ action: "accept", content: { proceed: true } });
    expect(store.getElicitation(row.id)?.status).toBe("accepted");
    expect(store.getElicitation(row.id)?.valuesJson).toBe("{}");
    expect(adapter.edits.at(-1)!.card.buttons).toBeUndefined();
  });

  it("maps titled choices to canonical values and rejects altered component aliases", async () => {
    const result = manager.create(record, form({
      color: {
        type: "string",
        oneOf: [
          { title: "Friendly Blue", const: "blue" },
          { title: "Friendly Green", const: "green" },
        ],
      },
    }), { requestId: 8, signal: new AbortController().signal });
    await tick();
    const row = pendingRow();
    expect(adapter.sent[0]!.card.buttons?.[0]?.label).toBe("Friendly Blue");
    await manager.handleComponent(event(elicitationCustomId("choice", row.id, "0")));
    await expect(result).resolves.toEqual({ action: "accept", content: { color: "blue" } });
    expect(parseElicitationCustomId(elicitationCustomId("choice", row.id, "blue"))).toBeNull();
  });

  it("lets an optional direct decision be explicitly skipped", async () => {
    const result = manager.create(
      record,
      form({ proceed: { type: "boolean" } }, []),
      { requestId: 81, signal: new AbortController().signal }
    );
    await tick();
    const row = pendingRow();
    expect(adapter.sent[0]!.card.buttons?.map((button) => button.label)).toContain("Skip");
    await manager.handleComponent(event(elicitationCustomId("skip", row.id)));
    await expect(result).resolves.toEqual({ action: "accept", content: {} });
  });

  it("uses one modal for 2-5 fields; X-close stays resumable and revokes stale modals", async () => {
    const result = manager.create(record, form({
      name: { type: "string", minLength: 2 },
      count: { type: "integer", minimum: 1, maximum: 9 },
    }), { requestId: 9, signal: new AbortController().signal });
    await tick();
    const row = pendingRow();
    expect(adapter.sent[0]!.card.buttons?.[0]?.label).toBe("Answer");

    const openedThenClosed = event(elicitationCustomId("answer", row.id));
    await manager.handleComponent(openedThenClosed);
    const staleModalId = openedThenClosed.modal.mock.calls[0]![0].customId as string;
    expect(store.getElicitation(row.id)?.status).toBe("open");

    const reopened = event(elicitationCustomId("answer", row.id));
    await manager.handleComponent(reopened);
    const currentModalId = reopened.modal.mock.calls[0]![0].customId as string;
    expect(currentModalId).not.toBe(staleModalId);

    const stale = event(staleModalId, { fields: { f0: "Ada", f1: "3" }, kind: "modal" });
    await manager.handleComponent(stale);
    expect(stale.replies.join(" ")).toMatch(/stale/);
    expect(store.getElicitation(row.id)?.status).toBe("open");

    const submit = event(currentModalId, { fields: { f0: "Ada", f1: "3" }, kind: "modal" });
    await manager.handleComponent(submit);
    await expect(result).resolves.toEqual({
      action: "accept",
      content: { name: "Ada", count: 3 },
    });
  });

  it("atomically erases partial answers when a form is cancelled", async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`f${index}`, { type: "string" }])
    );
    const result = manager.create(
      record,
      form(properties),
      { requestId: 91, signal: new AbortController().signal }
    );
    await tick();
    const row = pendingRow();
    const open = event(elicitationCustomId("answer", row.id));
    await manager.handleComponent(open);
    const modalId = open.modal.mock.calls[0]![0].customId as string;
    const submit = event(modalId, {
      fields: { f0: "private-a", f1: "private-b", f2: "private-c", f3: "private-d", f4: "private-e" },
    });
    await manager.handleComponent(submit);
    expect(store.getElicitation(row.id)?.valuesJson).toContain("private-a");
    await manager.handleComponent(event(elicitationCustomId("cancel", row.id)));
    await expect(result).resolves.toEqual({ action: "cancel" });
    expect(store.getElicitation(row.id)?.valuesJson).toBe("{}");
  });

  it("saves, revisits, and completes four ordered pages without exposing values", async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `field_${index}`,
        { type: "string", title: `Field ${index}` },
      ])
    );
    const result = manager.create(
      record, form(properties), { requestId: 10, signal: new AbortController().signal }
    );
    await tick();
    const row = pendingRow();

    const submitCurrent = async (prefix: string): Promise<void> => {
      const open = event(elicitationCustomId("answer", row.id));
      await manager.handleComponent(open);
      const modalId = open.modal.mock.calls[0]![0].customId as string;
      const submit = event(modalId, {
        kind: "modal",
        fields: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`f${i}`, `${prefix}-${i}`])),
      });
      await manager.handleComponent(submit);
    };

    await submitCurrent("p1");
    expect(store.getElicitation(row.id)?.currentPage).toBe(1);
    expect(adapter.edits.at(-1)!.card.panel.fields[1]!.value).toContain("✓ Page 1");
    expect(JSON.stringify(adapter.edits.at(-1)!.card)).not.toContain("p1-0");

    await manager.handleComponent(event(elicitationCustomId("prev", row.id)));
    expect(store.getElicitation(row.id)?.currentPage).toBe(0);
    await submitCurrent("edited");
    await submitCurrent("p2");
    await submitCurrent("p3");
    await submitCurrent("p4");
    const response = await result;
    expect(response.action).toBe("accept");
    if (response.action === "accept") {
      expect(response.content?.field_0).toBe("edited-0");
      expect(response.content?.field_19).toBe("p4-4");
    }
    expect(store.getElicitation(row.id)?.status).toBe("accepted");
  });

  it("settles cancel, request-abort, expiry, and supersession exactly once", async () => {
    const cancelResult = manager.create(
      record, form({ value: { type: "string" } }), { requestId: 11, signal: new AbortController().signal }
    );
    await tick();
    let row = pendingRow();
    const cancelEvent = event(elicitationCustomId("cancel", row.id));
    const duplicateCancelEvent = event(elicitationCustomId("cancel", row.id));
    await Promise.all([
      manager.handleComponent(cancelEvent),
      manager.handleComponent(duplicateCancelEvent),
    ]);
    await expect(cancelResult).resolves.toEqual({ action: "cancel" });
    expect(store.getElicitation(row.id)?.status).toBe("cancelled");

    const abort = new AbortController();
    const abortedResult = manager.create(
      record, form({ value: { type: "string" } }), { requestId: 12, signal: abort.signal }
    );
    await tick();
    row = pendingRow();
    abort.abort();
    await expect(abortedResult).resolves.toEqual({ action: "cancel" });
    expect(store.getElicitation(row.id)?.status).toBe("cancelled");

    const expiredResult = manager.create(
      record, form({ value: { type: "string" } }), { requestId: 13, signal: new AbortController().signal }
    );
    await tick();
    row = pendingRow();
    now += 16 * 60_000;
    await expect(manager.sweep()).resolves.toMatchObject({ expired: 1 });
    await expect(expiredResult).resolves.toEqual({ action: "cancel" });
    expect(store.getElicitation(row.id)?.status).toBe("expired");

    const first = manager.create(
      record, form({ first: { type: "string" } }), { requestId: 14, signal: new AbortController().signal }
    );
    await tick();
    const firstId = pendingRow().id;
    const second = manager.create(
      record, form({ second: { type: "string" } }), { requestId: 15, signal: new AbortController().signal }
    );
    await tick();
    await expect(first).resolves.toEqual({ action: "cancel" });
    expect(store.getElicitation(firstId)?.status).toBe("superseded");
    await manager.cancelForSession(record.id, "superseded", "new normal turn");
    await expect(second).resolves.toEqual({ action: "cancel" });
  });

  it("does not publish an already-aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(manager.create(
      record,
      form({ value: { type: "string" } }),
      { requestId: 131, signal: controller.signal }
    )).resolves.toEqual({ action: "cancel" });
    expect(adapter.sent).toEqual([]);
    expect(store.listOpenElicitations()).toEqual([]);
  });

  it("enforces user, channel, message, and session correlation without leaking state", async () => {
    const wrongSession = await manager.create(
      record,
      { ...form({ x: { type: "string" } }), sessionId: "other" } as CreateElicitationRequest,
      { requestId: 16, signal: new AbortController().signal }
    );
    expect(wrongSession).toEqual({ action: "decline" });
    expect(store.listOpenElicitations()).toEqual([]);

    const result = manager.create(
      record, form({ x: { type: "string" } }), { requestId: 17, signal: new AbortController().signal }
    );
    await tick();
    const row = pendingRow();
    const unauthorized = event(elicitationCustomId("answer", row.id), { userId: "other-user" });
    await manager.handleComponent(unauthorized);
    expect(unauthorized.replies.join(" ")).toMatch(/Only the person/);
    expect(store.getElicitation(row.id)?.status).toBe("open");
    await manager.cancelForSession(record.id, "cancelled", "cleanup");
    await expect(result).resolves.toEqual({ action: "cancel" });
  });

  it("keeps URL answers out of band and accepts only a correlated completion signal", async () => {
    const result = manager.create(
      record, urlRequest(), { requestId: 18, signal: new AbortController().signal }
    );
    await tick();
    const row = pendingRow();
    const card = adapter.sent[0]!.card;
    expect(card.panel.fields[0]!.value).toMatch(/does not collect/);
    expect(card.buttons?.[0]).toMatchObject({
      label: "Open secure page",
      url: "https://example.test/authorize?opaque=abc",
    });
    expect(await manager.completeUrl("external-1", "discord:other")).toBe(false);
    expect(store.getElicitation(row.id)?.status).toBe("open");
    expect(await manager.completeUrl("external-1", record.id)).toBe(true);
    await expect(result).resolves.toEqual({ action: "accept" });
    expect(JSON.stringify(adapter.edits.at(-1)!.card)).not.toContain("opaque=abc");
  });

  it("strips opaque metadata before persistence and freezes abandoned rows on boot recovery", async () => {
    const result = manager.create(
      record,
      {
        ...form({ answer: { type: "string", _meta: { internal: "do-not-store" } } }),
        _meta: { bearer: "top-secret" },
      } as CreateElicitationRequest,
      { requestId: 19, signal: new AbortController().signal }
    );
    await tick();
    const row = pendingRow();
    expect(store.getElicitation(row.id)?.requestJson).not.toMatch(/top-secret|do-not-store|_meta/);

    const restarted = new ElicitationManager({
      store,
      adapter: adapter as unknown as ChatAdapter,
      logger,
      currentUserId: () => "user-1",
      now: () => now,
    });
    expect(await restarted.recoverOpen()).toBe(1);
    expect(store.getElicitation(row.id)?.status).toBe("interrupted");
    expect(adapter.edits.at(-1)!.card.buttons).toBeUndefined();
    // The original process's waiter cannot survive a restart. Abort is harmless
    // against the already-terminal durable row.
    void result;
  });

  it("declines cleanly when the card cannot be posted", async () => {
    adapter.failPost = true;
    await expect(manager.create(
      record, form({ answer: { type: "string" } }),
      { requestId: 20, signal: new AbortController().signal }
    )).resolves.toEqual({ action: "decline" });
    expect(store.listOpenElicitations()).toEqual([]);
  });
});
