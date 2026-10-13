import { describe, expect, it, vi } from "vitest";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";

const channel = { platform: "google-chat", id: "ROOM.thread", parentId: "ROOM" };
const message = { name: "spaces/ROOM/messages/thread.existing", thread: { name: "spaces/ROOM/threads/thread" } };
const collision = (requestId: string) => {
  const text = `Failed to create a message with the specified request id ${requestId} and thread key . A message may have already been created with the same request id, but a different thread key.`;
  return Object.assign(new Error(text), { response: { status: 400, data: { error: { code: 400,
    status: "INVALID_ARGUMENT", message: text, errors: [{ domain: "global", reason: "badRequest", message: text }] } } } });
};
function fixture() {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const request = vi.fn(async (_scope: string, r: any): Promise<any> => {
    if (r.method === "POST") throw collision(r.params.requestId);
    return message;
  });
  const adapter = new GoogleChatAdapter({ api: { request }, subscription: "unused", allowedUserIds: new Set(),
    defaultCwd: "/projects", logger: logger as any, writeIntervalMs: 0 });
  return { adapter, request, logger };
}

describe("Google Chat verified create collisions", () => {
  it.each(["text", "panel"])("resolves the observed Google400 for a nonce-backed %s by fetching that client id", async kind => {
    const h = fixture(), delivery = { nonce: "stable-final", enforceNonce: true };
    const ref = kind === "text" ? await h.adapter.sendMessage(channel, "FINAL", delivery)
      : await h.adapter.sendPanel(channel, { title: "Done", fields: [] }, delivery);
    expect(ref.id).toBe(message.name);
    const clientId = h.request.mock.calls[0][1].params.messageId;
    expect(h.request.mock.calls[1]).toEqual(["chat", { method: "GET", url: `https://chat.googleapis.com/v1/spaces/ROOM/messages/${clientId}` }]);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.logger.warn).not.toHaveBeenCalled();
  });

  it("keeps the real lookup cause if the collision's client id cannot be fetched", async () => {
    const h = fixture(), denied = Object.assign(new Error("Permission denied on existing message"), { response: { status: 403 } });
    h.request.mockImplementation(async (_scope, r) => { if (r.method === "POST") throw collision(r.params.requestId); throw denied; });
    await expect(h.adapter.sendMessage(channel, "FINAL", { nonce: "stable-final", enforceNonce: true })).rejects.toBe(denied);
  });

  it.each(["no nonce", "different request", "different message", "different reason", "different status"])("does not turn %s into success", async variant => {
    const h = fixture(); let original: Error;
    h.request.mockImplementation(async (_scope, r) => {
      const error = collision(variant === "different request" ? "other-request" : r.params.requestId);
      if (variant === "different message") error.response.data.error.message = "Invalid text payload";
      if (variant === "different reason") error.response.data.error.errors[0].reason = "forbidden";
      if (variant === "different status") error.response.status = 403;
      original = error; throw error;
    });
    const result = await h.adapter.sendMessage(channel, "FINAL", variant === "no nonce" ? undefined : { nonce: "stable-final", enforceNonce: true }).catch(e => e);
    expect(result).toBe(original!);
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.request.mock.calls[0][1].method).toBe("POST");
  });
});
