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
  } = {}
): Harness {
  const prompts: string[] = [];
  const connections: Array<{ close(): void }> = [];
  let emitted = false;
  let releaseQuestionTurn = () => {};
  const questionTurnGate = new Promise<void>((resolve) => { releaseQuestionTurn = resolve; });
  const spawn = () => {
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
    const connection = agent({ name: "codex-async-question-fixture" })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
      }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: ACP_SESSION }))
      .onRequest(methods.agent.session.load, ({ params }) => ({ sessionId: params.sessionId }))
      .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        const text = params.prompt.map((block) => "text" in block ? block.text : "").join("");
        prompts.push(text);
        if ((opts.emitQuestion ?? true) && !emitted && text.trimEnd().endsWith("\n\nstart")) {
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
    expect(harness.adapter.cards).toHaveLength(1);
    expect(harness.adapter.cards[0]!.card.panel.title).toBe("Input request unavailable");
    expect(harness.adapter.cards[0]!.card.panel.fields[0]!.value).toMatch(/Sensitive/);
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
    expect(first.store.getElicitation(row.id)?.status).toBe("accepted");
  });
});
