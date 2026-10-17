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
      if (pulls === 2) return { receivedMessages: [delivery("Y", messageY)] };
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
      expect(request.mock.calls.some(([, r]) => r.data?.ackIds?.includes("ack-X"))).toBe(false);
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
