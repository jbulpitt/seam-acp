import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";

const subscription = "projects/test/subscriptions/events";
const logger = pino({ level: "silent" });

describe("Google Chat Pub/Sub admission", () => {
  it("pulls and acknowledges Space Y while a click in an earlier batch from Space X is still admitting", async () => {
    const { PubSubPullTransport } = await import("../packages/core/src/platforms/google-chat/transport.js");
    let admitX!: () => void;
    const pendingX = new Promise<void>(resolve => { admitX = resolve; });
    const clickX = { type: "CARD_CLICKED", space: { name: "spaces/X" } };
    const messageY = { type: "MESSAGE", space: { name: "spaces/Y" }, message: { name: "spaces/Y/messages/hello", text: "hello" } };
    const delivery = (id: string, event: unknown) => ({ ackId: `ack-${id}`, message: { messageId: id,
      data: Buffer.from(JSON.stringify(event)).toString("base64") } });
    let pulls = 0;
    const request = vi.fn(async (_scope: unknown, r: any): Promise<any> => {
      if (!r.url.endsWith(":pull")) return {};
      if (++pulls === 1) return { receivedMessages: [delivery("X", clickX)] };
      if (pulls === 2) return { receivedMessages: [
        { ...delivery("X", clickX), ackId: "ack-X-redelivery" }, delivery("Y", messageY),
      ] };
      return new Promise((_, reject) => {
        r.signal.addEventListener("abort", () => reject(r.signal.reason), { once: true });
      });
    });
    const receive = vi.fn(async (event: unknown) => { if ((event as any).space.name === "spaces/X") await pendingX; });
    const transport = new PubSubPullTransport({ api: { request }, subscription, receive, logger });
    await transport.start();
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledWith("pubsub", expect.objectContaining({
        url: `https://pubsub.googleapis.com/v1/${subscription}:acknowledge`, data: { ackIds: ["ack-Y"] },
      })), { timeout: 500 });
      expect(receive).toHaveBeenNthCalledWith(1, clickX, expect.any(AbortSignal), "X");
      expect(receive).toHaveBeenNthCalledWith(2, messageY, expect.any(AbortSignal), "Y");
      expect(receive).toHaveBeenCalledTimes(2);
      expect(request.mock.calls.some(([, r]) => r.data?.ackIds?.includes("ack-X"))).toBe(false);
      admitX();
      await vi.waitFor(() => expect(request.mock.calls.filter(([, r]) => r.data?.ackIds?.some((id: string) => id.startsWith("ack-X")))).toHaveLength(2));
    } finally { admitX(); await transport.stop(); }
  });

  it("stops pulling but drains an in-flight admission without acknowledging it during shutdown", async () => {
    const { PubSubPullTransport } = await import("../packages/core/src/platforms/google-chat/transport.js");
    let admit!: () => void, pulls = 0, stopped = false;
    const admission = new Promise<void>(resolve => { admit = resolve; });
    const receive = vi.fn(async () => admission);
    const request = vi.fn(async (_scope: unknown, r: any): Promise<any> => {
      if (!r.url.endsWith(":pull")) return {};
      if (++pulls === 1) return { receivedMessages: ["held", "queued"].map(id => ({ ackId: `ack-${id}`, message: { messageId: id,
        data: Buffer.from('{"type":"CARD_CLICKED","space":{"name":"spaces/X"}}').toString("base64") } })) };
      return new Promise((_, reject) => { r.signal.addEventListener("abort", () => reject(r.signal.reason), { once: true }); });
    });
    const transport = new PubSubPullTransport({ api: { request }, subscription, receive, logger });
    await transport.start();
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    const stop = transport.stop().then(() => { stopped = true; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(stopped).toBe(false);
      expect(request.mock.calls.every(([, r]) => r.url.endsWith(":pull"))).toBe(true);
    } finally { admit(); await stop; }
    expect(stopped).toBe(true);
    expect(receive).toHaveBeenCalledOnce();
    expect(request.mock.calls.every(([, r]) => r.url.endsWith(":pull"))).toBe(true);
  });

  it("orders Workspace hydration and direct events in the same Space while admitting other Spaces", async () => {
    const { PubSubPullTransport } = await import("../packages/core/src/platforms/google-chat/transport.js");
    let hydrated!: () => void;
    const hydration = new Promise<void>(resolve => { hydrated = resolve; });
    const admitted: string[] = [];
    const request = vi.fn(async (): Promise<any> => ({}));
    const transport = new PubSubPullTransport({ api: { request }, subscription, logger,
      receive: async raw => { admitted.push((raw as { id: string }).id); },
      receiveWorkspaceMessage: async message => { await hydration; admitted.push(message.resourceName); } });
    const workspace = transport.process({ ackId: "workspace", message: { messageId: "workspace",
      attributes: { "ce-type": "google.workspace.chat.message.v1.created" },
      data: Buffer.from('{"message":{"name":"spaces/X/messages/first"}}').toString("base64") } });
    const direct = (space: string) => transport.process({ ackId: space, message: { messageId: space,
      data: Buffer.from(JSON.stringify({ id: space, space: { name: `spaces/${space}` } })).toString("base64") } });
    const x = direct("X"), y = direct("Y");
    try {
      await y;
      expect(admitted).toEqual(["Y"]);
      hydrated(); await Promise.all([workspace, x]);
      expect(admitted).toEqual(["Y", "spaces/X/messages/first", "X"]);
    } finally { hydrated(); await Promise.allSettled([workspace, x, y]); }
  });

  it("lets a later same-Space event admit after an earlier admission fails", async () => {
    const { PubSubPullTransport } = await import("../packages/core/src/platforms/google-chat/transport.js");
    let rejectFirst!: (cause: Error) => void;
    const first = new Promise<void>((_, reject) => { rejectFirst = reject; });
    const request = vi.fn(async (): Promise<any> => ({}));
    const receive = vi.fn(async (raw: unknown) => { if ((raw as { id: string }).id === "first") await first; });
    const transport = new PubSubPullTransport({ api: { request }, subscription, logger, receive });
    const process = (id: string) => transport.process({ ackId: id, message: { messageId: id,
      data: Buffer.from(JSON.stringify({ id, space: { name: "spaces/X" } })).toString("base64") } });
    const cause = new Error("SQLite admission failed");
    const failed = expect(process("first")).rejects.toBe(cause), next = process("next");
    rejectFirst(cause);
    await failed; await next;
    expect(receive).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledExactlyOnceWith("pubsub", expect.objectContaining({ data: { ackIds: ["next"] } }));
  });

  it("keeps later same-Space admissions behind earlier hydration while another Space advances", async () => {
    const { PubSubPullTransport } = await import("../packages/core/src/platforms/google-chat/transport.js");
    let admitX!: () => void, pulls = 0;
    const hydration = new Promise<void>(resolve => { admitX = resolve; });
    const event = (space: string, id: string) => ({ ackId: `ack-${id}`, message: { messageId: id,
      data: Buffer.from(JSON.stringify({ type: "MESSAGE", space: { name: `spaces/${space}` }, id })).toString("base64") } });
    const request = vi.fn(async (_scope: unknown, r: any): Promise<any> => {
      if (!r.url.endsWith(":pull")) return {};
      if (++pulls === 1) return { receivedMessages: [event("X", "X1")] };
      if (pulls === 2) return { receivedMessages: [event("X", "X2"), event("Y", "Y1")] };
      return new Promise((_, reject) => { r.signal.addEventListener("abort", () => reject(r.signal.reason), { once: true }); });
    });
    const admitted: string[] = [];
    const receive = vi.fn(async (raw: unknown) => {
      const message = raw as { id: string };
      if (message.id === "X1") await hydration;
      admitted.push(message.id);
    });
    const transport = new PubSubPullTransport({ api: { request }, subscription, receive, logger });
    await transport.start();
    try {
      await vi.waitFor(() => expect(admitted).toContain("Y1"));
      expect(admitted).toEqual(["Y1"]);
      expect(receive).toHaveBeenCalledTimes(2);
      admitX();
      await vi.waitFor(() => expect(admitted).toEqual(["Y1", "X1", "X2"]));
    } finally { admitX(); await transport.stop(); }
  });

  it("decodes unpadded base64 and acknowledges only after durable admission", async () => {
    const { PubSubPullTransport } = await import("../packages/core/src/platforms/google-chat/transport.js");
    let admit!: () => void;
    const admission = new Promise<void>(r => { admit = r; });
    const receive = vi.fn(async (event: unknown) => { expect(event).toEqual({ type: "MESSAGE", text: "hello" }); await admission; });
    const request = vi.fn(async (): Promise<any> => ({}));
    const transport = new PubSubPullTransport({ api: { request }, subscription, receive, logger });
    const processing = transport.process({ ackId: "ack1", message: { messageId: "pub1",
      data: Buffer.from(JSON.stringify({ type: "MESSAGE", text: "hello" })).toString("base64").replace(/=+$/, "") } });
    await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(request).not.toHaveBeenCalled();
    admit(); await processing;
    expect(request).toHaveBeenCalledWith("pubsub", expect.objectContaining({
      url: `https://pubsub.googleapis.com/v1/${subscription}:acknowledge`, data: { ackIds: ["ack1"] } }));
  });

  it("leaves failed admission unacknowledged, preserving the actual error", async () => {
    const { PubSubPullTransport } = await import("../packages/core/src/platforms/google-chat/transport.js");
    const cause = new Error("database is busy");
    const request = vi.fn();
    const transport = new PubSubPullTransport({ api: { request }, subscription,
      receive: async () => { throw cause; }, logger });
    await expect(transport.process({ ackId: "ack2", message: { messageId: "pub2",
      data: Buffer.from('{"type":"MESSAGE"}').toString("base64") } })).rejects.toBe(cause);
    expect(request).not.toHaveBeenCalled();
  });

  it("can stop an idle long pull without acknowledging unprocessed work", async () => {
    const { PubSubPullTransport } = await import("../packages/core/src/platforms/google-chat/transport.js");
    const request = vi.fn(async (_scope: unknown, r: any) => new Promise((_, reject) => {
      r.signal.addEventListener("abort", () => reject(r.signal.reason), { once: true });
    }));
    const transport = new PubSubPullTransport({ api: { request }, subscription, receive: async () => {}, logger });
    await transport.start();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await transport.stop();
    expect(request.mock.calls.every(call => call[1].url.endsWith(":pull"))).toBe(true);
  });
});
