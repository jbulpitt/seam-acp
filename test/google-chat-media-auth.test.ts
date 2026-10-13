import { afterEach, describe, expect, it, vi } from "vitest";

const { authOptions, requests } = vi.hoisted(() => ({ authOptions: [] as any[], requests: vi.fn(async () => ({ data: { ok: true } })) }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class {
  constructor(options: any) { authOptions.push(options); }
  async getClient() { return { request: requests }; }
} }));
import { GoogleRestApi } from "../packages/core/src/platforms/google-chat/api.js";

afterEach(() => { authOptions.length = 0; requests.mockClear(); });
describe("Google Chat media OAuth", () => {
  it("uses the configured user file with approved create/readonly media scopes, separate from the app key", async () => {
    const api = new (GoogleRestApi as any)("/fixture/app-key.json", "project", "/fixture/user-token.json");
    await api.request("media", { method: "POST", url: "https://chat.googleapis.com/upload/v1/spaces/test/attachments:upload",
      headers: { "Content-Type": "multipart/related; boundary=test" }, data: Buffer.from("image") });
    expect(authOptions).toContainEqual(expect.objectContaining({ keyFile: "/fixture/user-token.json",
      scopes: ["https://www.googleapis.com/auth/chat.messages.create", "https://www.googleapis.com/auth/chat.messages.readonly"] }));
    expect(authOptions.filter(o => o.keyFile === "/fixture/user-token.json")).toHaveLength(1);
    expect(authOptions.filter(o => o.keyFile === "/fixture/app-key.json").every(o => !o.scopes.includes("https://www.googleapis.com/auth/chat.messages.create"))).toBe(true);
    expect(requests).toHaveBeenCalledWith(expect.objectContaining({ retry: false, headers: { "Content-Type": expect.any(String) } }));
  });
  it("does not configure user authentication when native images are off", async () => {
    const api = new GoogleRestApi("/fixture/app-key.json", "project");
    await api.request("chat", { method: "POST", url: "https://chat.googleapis.com/v1/spaces/test/messages" });
    expect(authOptions.every(o => o.keyFile === "/fixture/app-key.json")).toBe(true);
  });
  it.each([false, true])("preserves Google's binary download error cause and original error identity (wrapped=%s)", async wrapped => {
    const body = { error: { code: 403, status: "PERMISSION_DENIED", message: "App does not have access to this attachment.",
      errors: [{ domain: "global", reason: "forbidden" }] } };
    const error = Object.assign(new Error("Request failed with status code 403"),
      { response: { status: 403, data: Buffer.from(JSON.stringify(wrapped ? [body] : body)) } });
    requests.mockRejectedValueOnce(error);
    const api = new GoogleRestApi("/fixture/app-key.json", "project", "/fixture/user-token.json");
    const result = await api.request("chat", { method: "GET", url: "https://chat.googleapis.com/v1/media/opaque", responseType: "arraybuffer" }).catch(e => e);
    expect(result).toBe(error);
    expect(result.message).toBe(body.error.message);
    expect(result.response.status).toBe(403);
    expect(result.response.data).toEqual(wrapped ? [body] : body);
  });
});
