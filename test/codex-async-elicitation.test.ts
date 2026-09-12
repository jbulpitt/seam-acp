import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import { pino } from "pino";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { AgentProfile } from "@seam/adapters";
import {
  codexAsyncUserInputFromUpdate,
  type AsyncUserInputQuestion,
} from "../packages/core/src/agents/agent-runtime.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { discordRenderer } from "../packages/core/src/platforms/discord/renderer.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type {
  ChannelRef,
  ChatAdapter,
  ComponentEvent,
  ElicitationCardPost,
  IncomingMessage,
  MessageRef,
} from "../packages/core/src/platforms/chat-adapter.js";
import { fixtureModelCatalog } from "./model-catalog-fixture.js";
import { ElicitationManager, type CodexAsyncRefusalReason } from "../packages/core/src/core/elicitation/manager.js";
import { parseDispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import ts from "typescript";

const silent = pino({ level: "silent" }) as unknown as Logger;
const THREAD = "700000000000000001";
const PARENT = "700000000000000002";
const USER = "700000000000000003";
const ACP_SESSION = "codex-thread-original";

class FakeChatAdapter implements ChatAdapter {
  readonly platform = "discord";
  readonly cards: Array<{ ref: MessageRef; card: ElicitationCardPost }> = [];
  readonly edits: Array<{ ref: MessageRef; card: ElicitationCardPost }> = [];
  readonly messages: string[] = [];
  private messageHandler?: (message: IncomingMessage) => void | Promise<void>;
  private componentHandler?: (event: ComponentEvent) => void | Promise<void>;

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onMessage(handler: (message: IncomingMessage) => void | Promise<void>): void {
    this.messageHandler = handler;
  }
  onComponent(handler: (event: ComponentEvent) => void | Promise<void>): void {
    this.componentHandler = handler;
  }
  async sendMessage(channel: ChannelRef, text: string): Promise<MessageRef> {
    this.messages.push(text);
    return { channel, id: `message-${this.messages.length}` };
  }
  async editMessage(): Promise<void> {}
  async sendPanel(channel: ChannelRef): Promise<MessageRef> {
    return { channel, id: "status-card" };
  }
  async editPanel(): Promise<void> {}
  async sendElicitationCard(channel: ChannelRef, card: ElicitationCardPost): Promise<MessageRef> {
    const ref = { channel, id: `question-card-${this.cards.length + 1}` };
    this.cards.push({ ref, card });
    return ref;
  }
  async editElicitationCard(ref: MessageRef, card: ElicitationCardPost): Promise<void> {
    this.edits.push({ ref, card });
  }

  async message(text = "start"): Promise<void> {
    await this.messageHandler?.({
      messageId: "800000000000000001",
      channel: { platform: "discord", id: THREAD, parentId: PARENT },
      authorId: USER,
      authorName: "Owner",
      authorIsBot: false,
      text,
      raw: {},
    });
  }

  async component(input: {
    customId: string;
    interactionId: string;
    userId?: string;
    kind?: "button" | "select" | "modal";
    fields?: Record<string, string>;
    values?: string[];
    messageId?: string;
  }): Promise<{ replies: string[]; modal: unknown }> {
    const replies: string[] = [];
    let modal: unknown;
    await this.componentHandler?.({
      interactionId: input.interactionId,
      customId: input.customId,
      userId: input.userId ?? USER,
      userName: "Owner",
      channel: { platform: "discord", id: THREAD, parentId: PARENT },
      messageId: input.messageId ?? this.cards[0]!.ref.id,
      kind: input.kind ?? "button",
      ...(input.fields ? { fields: input.fields } : {}),
      ...(input.values ? { values: input.values } : {}),
      replyEphemeral: async (text) => { replies.push(text); },
      followUpEphemeral: async (text) => { replies.push(text); },
      editReplyEphemeral: async (text) => { replies.push(text); },
      replyEphemeralView: async () => "ephemeral-view",
      updateEphemeralView: async () => {},
      followUpEphemeralFile: async () => {},
      deferUpdate: async () => {},
      showModal: async (value) => { modal = value; },
    });
    return { replies, modal };
  }
}

interface Harness {
  adapter: FakeChatAdapter;
  orchestrator: Orchestrator;
  router: SessionRouter;
  store: SessionStore;
  prompts: string[];
  promptSessionIds: string[];
  newSessionIds: string[];
  loadedSessionIds: string[];
  releaseQuestionTurn(): void;
  close(): Promise<void>;
}

function asyncUpdate(questions: AsyncUserInputQuestion[], over: Record<string, unknown> = {}): SessionUpdate {
  return {
    sessionUpdate: "agent_message_chunk",
    messageId: "async-item-1",
    content: { type: "text", text: "" },
    _meta: {
      codex: {
        phase: "final_answer",
        asyncUserInput: {
          delivery: "async",
          threadId: ACP_SESSION,
          turnId: "turn-question",
          itemId: "async-item-1",
          questions,
          ...over,
        },
      },
    },
  } as SessionUpdate;
}

function makeHarness(
  dir: string,
  questions: AsyncUserInputQuestion[],
  opts: {
    store?: SessionStore;
    duplicateUpdate?: boolean;
    emitQuestion?: boolean;
    holdQuestionTurn?: boolean;
    dispatchQuestion?: boolean;
  } = {}
): Harness {
  const prompts: string[] = [];
  const promptSessionIds: string[] = [];
  const newSessionIds: string[] = [];
  const loadedSessionIds: string[] = [];
  const connections: Array<{ close(): void }> = [];
  let emitted = false;
  let releaseQuestionTurn = () => {};
  const questionTurnGate = new Promise<void>((resolve) => { releaseQuestionTurn = resolve; });
  const spawn = () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdin,
      stdout,
      stderr,
      pid: undefined,
      killed: false,
      kill() {
        this.killed = true;
        emitter.emit("exit", 0, null);
        return true;
      },
    });
    const connection = agent({ name: "codex-async-question-fixture" })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
      }))
      .onRequest(methods.agent.session.new, () => {
        const sessionId = newSessionIds.length ? `unexpected-fresh-${newSessionIds.length}` : ACP_SESSION;
        newSessionIds.push(sessionId);
        return { sessionId };
      })
      .onRequest(methods.agent.session.load, ({ params }) => { loadedSessionIds.push(params.sessionId); return {}; })
      .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        const text = params.prompt.map((block) => "text" in block ? block.text : "").join("");
        prompts.push(text);
        promptSessionIds.push(params.sessionId);
        if ((opts.emitQuestion ?? true) && !emitted && (opts.dispatchQuestion || text.trimEnd().endsWith("\n\nstart"))) {
          emitted = true;
          await client.notify(methods.client.session.update, {
            sessionId: ACP_SESSION,
            update: asyncUpdate(questions),
          });
          if (opts.duplicateUpdate) {
            await client.notify(methods.client.session.update, {
              sessionId: ACP_SESSION,
              update: asyncUpdate(questions),
            });
          }
          if (opts.holdQuestionTurn) await questionTurnGate;
        }
        return { stopReason: "end_turn" };
      })
      .onNotification(methods.agent.session.cancel, () => {})
      .connect(ndJsonStream(
        Writable.toWeb(stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(stdin) as ReadableStream<Uint8Array>
      ));
    connections.push(connection);
    return child;
  };
  const profile = {
    id: "codex",
    displayName: "Codex",
    defaultModel: "gpt-fixture",
    effort: { mechanism: "none", levels: [] },
    spawn,
  } as unknown as AgentProfile;
  const store = opts.store ?? new SessionStore(path.join(dir, "state.db"));
  const catalog = fixtureModelCatalog([profile]);
  const router = new SessionRouter({
    logger: silent,
    store,
    profiles: [profile],
    modelCatalog: catalog,
    defaultAgentId: "codex",
    defaultModel: "gpt-fixture",
    defaultPermissionMode: "ask",
    defaultCwd: dir,
  });
  const adapter = new FakeChatAdapter();
  const orchestrator = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: dir,
      TURN_TIMEOUT_SECONDS: 15,
      DEFAULT_MODEL: "gpt-fixture",
      DEFAULT_AGENT: "codex",
      SEAM_DISPATCH_STATUS_PANEL: false,
      CHANNEL_PRESETS_FILE: path.join(dir, "channel-presets.json"),
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      channelPresets: new Map(),
      threadPresets: new Map(),
      bridgePresets: new Map(),
      REPO_EMOJIS: new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([USER]),
    } as never,
    adapter,
    modelCatalog: catalog,
    router,
    store,
    renderer: discordRenderer,
  });
  orchestrator.install();
  return {
    adapter,
    orchestrator,
    router,
    store,
    prompts,
    promptSessionIds,
    newSessionIds,
    loadedSessionIds,
    releaseQuestionTurn,
    async close() {
      await router.disposeAll();
      for (const connection of connections) connection.close();
    },
  };
}

function promptBodies(harness: Harness): string[] {
  return harness.prompts.map((prompt) => prompt.split("</seam-harness>\n\n").at(-1)!);
}

let dir: string;
const harnesses: Harness[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-codex-async-input-"));
  fs.writeFileSync(path.join(dir, "channel-presets.json"), "{\"channels\":{},\"threads\":{}}");
});

afterEach(async () => {
  const active = harnesses.splice(0);
  for (const harness of active) await harness.close();
  const stores = new Set(active.map((harness) => harness.store));
  for (const store of stores) store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Codex async user-input bridge", () => {
  // Protects the real dispatch event route, frozen owner, and conversation/queue
  // identity; removing any of these either loses the card or redirects an answer.
  it.each([false, true])("dispatch question and answer preserve original ACP identity (held=%s)", async (held) => {
    const h = makeHarness(dir, [{ title: "Proceed?", options: ["Yes", "No"] }], {
      dispatchQuestion: true, holdQuestionTurn: held, duplicateUpdate: true,
    });
    harnesses.push(h);
    const spec = parseDispatchSpec("dispatch-question", JSON.stringify({ target: THREAD, session: "live", kind: "handoff",
      responderUserId: USER, prompt: "start", stream: false, createdUtc: new Date().toISOString() }));
    const running = h.orchestrator.dispatchInjectTurn(spec);
    try {
      await vi.waitFor(() => expect(h.adapter.cards).toHaveLength(1));
      if (!held) await running;
      const row = h.store.listOpenElicitations()[0]!;
      expect(row.authorizedUserId).toBe(USER);
      expect(row.acpSessionId).toBe(ACP_SESSION);
      expect(h.store.turnAttempts.get(spec.id)?.spec.responderUserId).toBe(USER);
      const record = h.store.get(`discord:${THREAD}`)!;
      expect(h.orchestrator.dispatchResponderUserId(record)).toBe(held ? USER : undefined);
      expect(h.orchestrator.dispatchResponderUserId({ ...record, acpSessionId: "replaced-caller" })).toBeUndefined();
      const yes = h.adapter.cards[0]!.card.buttons!.find(button => button.label === "Yes")!;
      const denied = await h.adapter.component({ customId: yes.customId!, interactionId: "850000000000000001", userId: "someone-else" });
      expect(denied.replies.join(" ")).toMatch(/Only the person/);
      await h.adapter.component({ customId: yes.customId!, interactionId: "850000000000000002" });
      expect(h.store.getInbound("850000000000000002")).toMatchObject({
        expectedAcpSessionId: ACP_SESSION, authorId: USER, preemptive: false,
      });
      expect(h.store.getElicitation(row.id)?.terminalDetail).toContain(held ? "behind the running turn" : "queued for delivery");
      if (held) {
        expect(h.prompts).toHaveLength(1);
        expect(h.store.getInbound("850000000000000002")?.state).toBe("pending");
      }
    } finally { h.releaseQuestionTurn(); await running; }
    await vi.waitFor(() => expect(h.prompts).toHaveLength(2));
    expect(h.promptSessionIds).toEqual([ACP_SESSION, ACP_SESSION]);
    expect(h.newSessionIds).toEqual([ACP_SESSION]);
    expect(h.prompts[1]).toMatch(/\n\nYes$/);
  });

  // Protects ownerless legacy turns from silent loss without blocking their work.
  it("ownerless dispatch names its refusal and still completes", async () => {
    const h = makeHarness(dir, [{ title: "Proceed?", options: ["Yes", "No"] }], { dispatchQuestion: true });
    harnesses.push(h);
    await expect(h.orchestrator.dispatchInjectTurn({ id: "ownerless", target: THREAD, session: "live", kind: "handoff",
      prompt: "start", stream: false, createdUtc: new Date().toISOString() })).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(h.adapter.cards).toHaveLength(0);
    expect(h.adapter.messages.join(" ")).toContain("[missing_responder]");
  });

  // Protects against delivering an old dispatch's answer to a replacement
  // conversation; losing this assertion can silently continue the wrong work.
  it("dispatch answer refuses a replacement conversation without prompting it", async () => {
    const h = makeHarness(dir, [{ title: "Proceed?", options: ["Yes", "No"] }], { dispatchQuestion: true });
    harnesses.push(h);
    await h.orchestrator.dispatchInjectTurn({ id: "replace-dispatch", target: THREAD, session: "live", kind: "handoff",
      responderUserId: USER, prompt: "start", createdUtc: new Date().toISOString() });
    expect(h.store.compareAndSwapAcpSession(`discord:${THREAD}`, ACP_SESSION, "replacement")).toBe(true);
    const yes = h.adapter.cards[0]!.card.buttons!.find(button => button.label === "Yes")!;
    const refused = await h.adapter.component({ customId: yes.customId!, interactionId: "850000000000000003" });
    expect(refused.replies.join(" ")).toMatch(/originating Codex conversation is no longer available/);
    expect(h.promptSessionIds).toEqual([ACP_SESSION]);
    expect(h.store.getInbound("850000000000000003")).toBeNull();
  });

  // Each guard refuses just the question, with a typed reason plus a visible
  // notice and redacted log; deleting a guard/diagnostic loses that explanation.
  it.each<CodexAsyncRefusalReason>(["missing_responder", "invalid_responder", "missing_acp_session", "card_send_unsupported", "card_edit_unsupported",
    "session_mismatch", "isolated_session", "invalid_form", "card_post_failed"])("names async refusal %s", async reason => {
    const h = makeHarness(dir, [{ title: "unused", options: null }]);
    harnesses.push(h);
    const record = h.router.ensureSessionRecord({ platform: "discord", channelRef: THREAD, cwd: dir });
    record.acpSessionId = reason === "missing_acp_session" ? "" : ACP_SESSION;
    h.store.upsert(record);
    const logs: unknown[] = [];
    const logger = pino({ level: "warn" }, { write: line => { logs.push(JSON.parse(line)); } }) as unknown as Logger;
    const adapter = h.adapter as unknown as Partial<ChatAdapter>;
    if (reason === "card_send_unsupported") adapter.sendElicitationCard = undefined;
    if (reason === "card_edit_unsupported") adapter.editElicitationCard = undefined;
    if (reason === "card_post_failed") adapter.sendElicitationCard = async () => { throw Error("private-provider-body"); };
    const manager = new ElicitationManager({ store: h.store, adapter: adapter as ChatAdapter, logger,
      currentUserId: () => "ambient-user-must-not-authorize-dispatch" });
    const result = await manager.createCodexAsync(record, { itemId: "item", turnId: "turn",
      threadId: reason === "session_mismatch" ? "replacement" : ACP_SESSION,
      questions: [{ title: reason === "invalid_form" ? "API key" : "Proceed?", options: null }] }, {
      responderUserId: reason === "missing_responder" ? undefined : reason === "invalid_responder" ? "not-a-user" : USER,
      session: reason === "isolated_session" ? "isolated" : "live",
    });
    expect(result).toEqual({ ok: false, reason });
    expect(h.adapter.messages.join(" ")).toContain(`[${reason}]`);
    expect(logs).toContainEqual(expect.objectContaining({ reason, msg: "async elicitation refused" }));
    expect(JSON.stringify(logs)).not.toMatch(/API key|private-provider-body|Proceed\?/);
  });

  // Structural backstop: adding any bare boolean refusal bypasses the named
  // result contract, even if a fixture does not yet reach that new branch.
  it("async admission has no bare boolean return", () => {
    const source = ts.createSourceFile("manager.ts", fs.readFileSync(new URL("../packages/core/src/core/elicitation/manager.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    let found = false;
    function visit(node: ts.Node): void {
      if (ts.isMethodDeclaration(node) && node.name.getText(source) === "createCodexAsync") {
        found = true;
        const check = (child: ts.Node): void => {
          if (ts.isReturnStatement(child)) expect(child.expression?.kind).not.toBe(ts.SyntaxKind.FalseKeyword);
          ts.forEachChild(child, check);
        };
        check(node);
      }
      ts.forEachChild(node, visit);
    }
    visit(source); expect(found).toBe(true);
  });

  it("strictly accepts the reviewed metadata shape and rejects sensitive/ambiguous additions", () => {
    expect(codexAsyncUserInputFromUpdate(asyncUpdate([
      { title: "Proceed?", options: ["Yes", "No"] },
    ]))).toEqual({
      itemId: "async-item-1",
      threadId: ACP_SESSION,
      turnId: "turn-question",
      questions: [{ title: "Proceed?", options: ["Yes", "No"] }],
    });
    expect(codexAsyncUserInputFromUpdate(asyncUpdate(
      [{ title: "Proceed?", options: ["Yes", "No"] }],
      { isSecret: true }
    ))).toBeNull();
    expect(codexAsyncUserInputFromUpdate({
      ...asyncUpdate([{ title: "Proceed?", options: ["Yes", "No"] }]),
      messageId: "different-item",
    } as SessionUpdate)).toBeNull();
    expect(codexAsyncUserInputFromUpdate(asyncUpdate([
      { title: "Proceed?", options: ["Only one"] },
    ]))).toBeNull();
  });

  it("uses the real update→Discord→durable inbound path, deduplicates, and routes one answer to the same session", async () => {
    const harness = makeHarness(dir, [{ title: "Proceed?", options: ["Yes", "No"] }], {
      duplicateUpdate: true,
    });
    harnesses.push(harness);
    const persist = vi.spyOn(harness.store, "replaceOpenElicitation");
    await harness.adapter.message();
    expect(promptBodies(harness)).toEqual(["start"]);
    expect(harness.adapter.cards).toHaveLength(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(harness.adapter.cards[0]!.card.buttons?.map((button) => button.label))
      .toEqual(["Yes", "No", "Cancel"]);
    const elicitationId = harness.store.listOpenElicitations()[0]!.id;

    const yes = harness.adapter.cards[0]!.card.buttons!.find((button) => button.label === "Yes")!;
    const stale = await harness.adapter.component({
      customId: yes.customId!,
      interactionId: "810000000000000000",
      messageId: "wrong-card",
    });
    expect(stale.replies.join(" ")).toMatch(/no longer available/);
    const invalid = await harness.adapter.component({
      customId: yes.customId!.replace(/:\d+$/u, ":99"),
      interactionId: "810000000000000004",
    });
    expect(invalid.replies.join(" ")).toMatch(/not valid/);
    const unauthorized = await harness.adapter.component({
      customId: yes.customId!,
      interactionId: "810000000000000001",
      userId: "someone-else",
    });
    expect(unauthorized.replies.join(" ")).toMatch(/Only the person/);
    expect(promptBodies(harness)).toEqual(["start"]);

    await harness.adapter.component({
      customId: yes.customId!,
      interactionId: "810000000000000002",
    });
    await vi.waitFor(() => expect(promptBodies(harness)).toEqual(["start", "Yes"]));
    const admission = harness.store.getInbound("810000000000000002");
    expect(admission).toMatchObject({
      text: "Yes",
      expectedAcpSessionId: ACP_SESSION,
      preemptive: false,
      sessionRecordId: `discord:${THREAD}`,
    });
    expect(harness.store.getElicitation(elicitationId)?.status).toBe("accepted");

    const duplicate = await harness.adapter.component({
      customId: yes.customId!,
      interactionId: "810000000000000003",
    });
    expect(duplicate.replies.join(" ")).toMatch(/already been settled/);
    expect(harness.store.getInbound("810000000000000003")).toBeNull();
    expect(promptBodies(harness)).toEqual(["start", "Yes"]);
  });

  it("collects multiple questions including free text and sends one labelled user message", async () => {
    const harness = makeHarness(dir, [
      { title: "Channel", options: ["Stable", "Preview"] },
      { title: "Rationale", options: null },
    ]);
    harnesses.push(harness);
    await harness.adapter.message();
    const answer = harness.adapter.cards[0]!.card.buttons!.find((button) => button.label === "Answer")!;
    const opened = await harness.adapter.component({
      customId: answer.customId!,
      interactionId: "820000000000000001",
    });
    const modal = opened.modal as { customId: string; inputs: Array<{ label: string }> };
    expect(modal.inputs.map((input) => input.label)).toEqual([
      "Channel (required)",
      "Rationale (required)",
    ]);
    await harness.adapter.component({
      customId: modal.customId,
      interactionId: "820000000000000002",
      kind: "modal",
      fields: { f0: "Stable", f1: "Keep compatibility" },
    });
    await vi.waitFor(() => expect(promptBodies(harness)).toEqual([
      "start",
      "Answers to your questions:\n- Channel: Stable\n- Rationale: Keep compatibility",
    ]));
  });

  it("queues an answer behind a continuing originating turn without cancelling it", async () => {
    const harness = makeHarness(dir, [{ title: "Proceed?", options: ["Yes", "No"] }], {
      holdQuestionTurn: true,
    });
    harnesses.push(harness);
    const running = harness.adapter.message();
    await vi.waitFor(() => expect(harness.adapter.cards).toHaveLength(1));
    // Human-originated dispatches inherit that authenticated human, not an ambient target user.
    expect(harness.orchestrator.dispatchResponderUserId(harness.store.get(`discord:${THREAD}`)!)).toBe(USER);
    const yes = harness.adapter.cards[0]!.card.buttons!.find((button) => button.label === "Yes")!;
    await harness.adapter.component({
      customId: yes.customId!,
      interactionId: "825000000000000001",
    });
    expect(promptBodies(harness)).toEqual(["start"]);
    expect(harness.store.getInbound("825000000000000001")).toMatchObject({
      state: "pending",
      preemptive: false,
    });
    harness.releaseQuestionTurn();
    await running;
    await vi.waitFor(() => expect(promptBodies(harness)).toEqual(["start", "Yes"]));
  });

  it("rejects credential-shaped async questions on the real consumer path", async () => {
    const harness = makeHarness(dir, [{ title: "API key", options: null }]);
    harnesses.push(harness);
    await harness.adapter.message();
    expect(harness.store.listOpenElicitations()).toEqual([]);
    expect(harness.adapter.cards).toHaveLength(0);
    expect(harness.adapter.messages.join(" ")).toContain("[invalid_form]");
    expect(harness.adapter.messages.join(" ")).not.toContain("API key");
  });

  it("cancels without a provider turn and refuses a replacement session", async () => {
    const cancelHarness = makeHarness(dir, [{ title: "Proceed?", options: ["Yes", "No"] }]);
    harnesses.push(cancelHarness);
    await cancelHarness.adapter.message();
    const cancel = cancelHarness.adapter.cards[0]!.card.buttons!.find((button) => button.label === "Cancel")!;
    await cancelHarness.adapter.component({
      customId: cancel.customId!,
      interactionId: "830000000000000001",
    });
    expect(promptBodies(cancelHarness)).toEqual(["start"]);
    expect(cancelHarness.store.listOpenElicitations()).toEqual([]);

    const otherDir = path.join(dir, "replacement");
    fs.mkdirSync(otherDir);
    fs.writeFileSync(path.join(otherDir, "channel-presets.json"), "{\"channels\":{},\"threads\":{}}");
    const replaced = makeHarness(otherDir, [{ title: "Proceed?", options: ["Yes", "No"] }]);
    harnesses.push(replaced);
    await replaced.adapter.message();
    expect(replaced.store.compareAndSwapAcpSession(
      `discord:${THREAD}`, ACP_SESSION, "replacement-session"
    )).toBe(true);
    const yes = replaced.adapter.cards[0]!.card.buttons!.find((button) => button.label === "Yes")!;
    const refused = await replaced.adapter.component({
      customId: yes.customId!,
      interactionId: "830000000000000002",
    });
    expect(refused.replies.join(" ")).toMatch(/originating Codex conversation is no longer available/);
    expect(promptBodies(replaced)).toEqual(["start"]);
  });

  it("keeps an unanswered async card across restart and resumes only the original ACP session", async () => {
    const first = makeHarness(dir, [{ title: "Proceed?", options: ["Yes", "No"] }]);
    harnesses.push(first);
    await first.adapter.message();
    const row = first.store.listOpenElicitations()[0]!;
    const yesCustomId = first.adapter.cards[0]!.card.buttons!.find((button) => button.label === "Yes")!.customId!;

    const restarted = makeHarness(dir, [{ title: "unused", options: ["A", "B"] }], {
      store: first.store,
      emitQuestion: false,
    });
    harnesses.push(restarted);
    expect(await restarted.orchestrator.recoverElicitations()).toBe(1);
    expect(first.store.getElicitation(row.id)?.status).toBe("open");
    restarted.adapter.cards.push(first.adapter.cards[0]!);
    await restarted.adapter.component({
      customId: yesCustomId,
      interactionId: "840000000000000001",
    });
    await vi.waitFor(() => expect(promptBodies(restarted)).toEqual(["Yes"]));
    expect(restarted.newSessionIds).toEqual([]);
    expect(restarted.loadedSessionIds).toEqual([ACP_SESSION]);
    expect(first.store.getElicitation(row.id)?.status).toBe("accepted");
  });
});
