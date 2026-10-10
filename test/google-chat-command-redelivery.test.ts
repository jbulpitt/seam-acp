import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { PubSubPullTransport } from "../packages/core/src/platforms/google-chat/transport.js";

const logger = pino({ level: "silent" });
const stores = new Set<SessionStore>();
const dirs: string[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const event = (id: number, text: string) => ({ type: "MESSAGE", space: { name: "spaces/dm" },
  user: { name: "users/42", displayName: "Tester" }, message: {
    name: `spaces/dm/messages/command-${id}`, text, argumentText: text, slashCommand: { commandId: id },
    thread: { name: "spaces/dm/threads/invocation" },
  } });
const admissionId = (id: number) => `gchat_${createHash("sha256").update(event(id, "").message.name).digest("base64url")}`;

function setup(db = ":memory:") {
  const store = new SessionStore(db); stores.add(store);
  let creates = 0;
  const request = vi.fn(async (scope: string, r: any): Promise<any> => scope === "pubsub" ? {} : ({
    name: `spaces/dm/messages/app-${++creates}`, thread: r.data?.thread ?? { name: `spaces/dm/threads/new-${creates}` },
  }));
  const adapter = new GoogleChatAdapter({ api: { request }, logger, subscription: "projects/test/subscriptions/events",
    defaultCwd: "/projects", allowedUserIds: new Set(["users/42"]), writeIntervalMs: 0 });
  const ensureSessionRecord = vi.fn((r: any) => ({ id: `google-chat:${r.channelRef}`, platform: "google-chat",
    channelRef: r.channelRef, parentRef: r.parentRef, agentId: "claude", acpSessionId: "saved-session" }));
  const applyAgentChange = vi.fn(async (_ch, _record, _arg, _actor, respond) => {
    await respond("Agent switched to codex"); return { ok: true, message: "Agent switched to codex" };
  });
  const applyModelChange = vi.fn(async (_ch, _record, _arg, _actor, respond) => {
    await respond("Model changed"); return { ok: true, message: "Model changed" };
  });
  const cancelChannel = vi.fn(async () => ({ parked: null, cancelled: { cancelled: true, starting: false },
    outcome: "idle", queue: { state: "idle", queued: 0 } }));
  adapter.setCommandDeps({ store, router: { ensureSessionRecord,
    describeConfig: () => ({ agent: { value: "claude" }, model: { value: "claude-default" } }) },
    runtimeTransition: { applyAgentChange, applyModelChange }, cancelChannel } as any);
  const transport = new PubSubPullTransport({ api: { request }, logger, subscription: "projects/test/subscriptions/events",
    receive: (...args) => adapter.receiveEvent(...args) });
  const deliver = (raw: unknown, publication = "first") => transport.process({ ackId: `ack-${publication}`,
    message: { messageId: publication, data: Buffer.from(JSON.stringify(raw)).toString("base64") } });
  return { store, adapter, request, ensureSessionRecord, applyAgentChange, applyModelChange, cancelChannel, deliver };
}

describe("durable Google Chat command effects before reply delivery", () => {
  it("redelivered /new with a different publication id creates and binds exactly one thread", async () => {
    const h = setup();
    await h.deliver(event(1, "/new Another task"));
    await h.deliver(event(1, "/new Another task"), "redelivery");
    expect(h.request.mock.calls.filter(([scope]) => scope === "chat")).toHaveLength(1);
    expect(h.ensureSessionRecord).toHaveBeenCalledExactlyOnceWith({ platform: "google-chat", channelRef: "dm.new-1",
      parentRef: "dm", cwd: "/projects" });
    expect(h.request.mock.calls.filter(([scope]) => scope === "pubsub")).toHaveLength(2);
    expect(h.store.getInbound(admissionId(1))?.state).toBe("completed");
  });

  it("an ACK failure and a reopened SQLite store do not repeat /new", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gchat-command-receipt-")); dirs.push(dir);
    const db = path.join(dir, "seam.db");
    const h = setup(db);
    const ackFailure = Object.assign(new Error("Pub/Sub acknowledge unavailable"), { response: { status: 503 } });
    h.request.mockImplementation(async (scope, r) => {
      if (scope === "pubsub") throw ackFailure;
      return { name: "spaces/dm/messages/new", thread: { name: "spaces/dm/threads/new" } };
    });
    await expect(h.deliver(event(1, "/new Another task"))).rejects.toBe(ackFailure);
    h.store.close(); stores.delete(h.store);
    const restarted = setup(db);
    await restarted.deliver(event(1, "/new Another task"), "after-restart");
    expect(restarted.request.mock.calls.map(([scope]) => scope)).toEqual(["pubsub"]);
    expect(restarted.ensureSessionRecord).not.toHaveBeenCalled();
  });

  it("ACKs a deterministic reply failure once with its real cause, without repeating cancel or the failed reply", async () => {
    const h = setup();
    const cause = Object.assign(new Error("NOT_FOUND: command thread is not replyable"), { response: { status: 404 } });
    const error = vi.spyOn(logger, "error");
    h.request.mockImplementation(async scope => { if (scope === "chat") throw cause; return {}; });
    await h.deliver(event(2, "/cancel"));
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ err: cause, messageId: admissionId(2), command: "cancel" }),
      "Google Chat command reply rejected after execution; acknowledging event");
    expect(h.cancelChannel).toHaveBeenCalledOnce();
    expect(h.request.mock.calls.map(([scope]) => scope)).toEqual(["chat", "pubsub"]);
    await h.deliver(event(2, "/cancel"), "duplicate");
    expect(h.cancelChannel).toHaveBeenCalledOnce();
    expect(h.request.mock.calls.map(([scope]) => scope)).toEqual(["chat", "pubsub", "pubsub"]);
  });

  it("a committed model switch is not repeated when Pub/Sub ACK is retried", async () => {
    const h = setup();
    const cause = new Error("network dropped during Pub/Sub ACK");
    h.request.mockImplementation(async (scope, r) => {
      if (scope === "pubsub") throw cause;
      return { name: "spaces/dm/messages/reply", thread: r.data.thread };
    });
    await expect(h.deliver(event(4, "/model reviewed-model"))).rejects.toBe(cause);
    h.request.mockImplementation(async (_scope, r) => ({ name: "spaces/dm/messages/reply", thread: r.data?.thread }));
    await h.deliver(event(4, "/model reviewed-model"), "again");
    expect(h.applyModelChange).toHaveBeenCalledOnce();
    expect(h.request.mock.calls.filter(([scope]) => scope === "chat")).toHaveLength(1);
  });

  it.each([429, 503, undefined])("retries transient reply status %s through the write queue, not the command", async status => {
    const h = setup();
    const cause = Object.assign(new Error("transient Google write failure"), status ? { response: { status } } : {});
    let writes = 0;
    h.request.mockImplementation(async (scope, r) => {
      if (scope === "pubsub") return {};
      if (!writes++) throw cause;
      return { name: "spaces/dm/messages/reply", thread: r.data.thread };
    });
    await h.deliver(event(3, "/agent codex"));
    expect(h.applyAgentChange).toHaveBeenCalledOnce();
    expect(h.request.mock.calls.map(([scope]) => scope)).toEqual(["chat", "chat", "pubsub"]);
  });

  it("a retained transient reply survives reopening SQLite without re-executing the agent switch", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gchat-pending-reply-")); dirs.push(dir);
    const db = path.join(dir, "seam.db");
    const h = setup(db);
    const cause = new Error("connection reset before reply delivery");
    vi.spyOn(h.adapter as any, "sendText").mockRejectedValueOnce(cause);
    await expect(h.deliver(event(3, "/agent codex"))).rejects.toBe(cause);
    h.store.close(); stores.delete(h.store);
    const restarted = setup(db);
    await restarted.deliver(event(3, "/agent codex"), "retry-reply");
    expect(restarted.applyAgentChange).not.toHaveBeenCalled();
    expect(restarted.request.mock.calls.map(([scope]) => scope)).toEqual(["chat", "pubsub"]);
    expect(restarted.request.mock.calls[0]![1].data.text).toBe("Agent switched to codex");
  });

  it("never turns a command receipt into a recovered agent prompt or supersedes it with a normal message", () => {
    const h = setup();
    const base = { platform: "google-chat", channelRef: "dm.invocation", sessionRecordId: "google-chat:dm.invocation",
      authorId: "42", text: "/agent codex", createdUtc: "2026-10-10T00:00:00Z", preemptive: false };
    h.store.admitInbound({ ...base, messageId: "command", commandResult: { replies: [] } } as any);
    h.store.claimInbound("command", 0, base.createdUtc);
    expect(h.store.listInboundNonterminal()).toEqual([]);
    expect(h.store.recoverAllInbound(base.createdUtc)).toEqual([]);
    h.store.admitInbound({ ...base, messageId: "ordinary", text: "real prompt", preemptive: true });
    expect(h.store.getInbound("command")?.state).toBe("running");
    expect(h.store.listInboundNonterminal().map(row => row.messageId)).toEqual(["ordinary"]);
  });
});
