import { beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { loadConfig } from "../packages/core/src/config.js";
import * as actions from "../packages/core/src/platforms/google-chat/command-actions.js";
import { GoogleRestApi } from "../packages/core/src/platforms/google-chat/api.js";

const auth = vi.hoisted(() => ({ options: [] as any[], request: vi.fn() }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class {
  constructor(options: unknown) { auth.options.push(options); }
  async getClient() { return { request: auth.request }; }
} }));
beforeEach(() => { auth.options.length = 0; auth.request.mockReset().mockResolvedValue({ data: {} }); });

const base = { DISCORD_BOT_TOKEN: "fixture", DISCORD_ALLOWED_USER_IDS: "123", REPOS_ROOT: tmpdir(), DEFAULT_AGENT: "codex" };
const foundation = actions as any;

describe("Google Chat org defaults", () => {
  it("uses the granted spaces/memberships app scopes while retaining bot/message/PubSub auth", async () => {
    const api = new GoogleRestApi("/fixture/key.json", "fixture-project");
    await api.request("spaces" as any, { method: "POST", url: "https://chat.googleapis.com/v1/spaces" });
    await api.request("memberships" as any, { method: "PATCH", url: "https://chat.googleapis.com/v1/spaces/A/members/person" });
    expect(auth.options.map(option => option.scopes[0])).toEqual(expect.arrayContaining([
      "https://www.googleapis.com/auth/chat.app.spaces", "https://www.googleapis.com/auth/chat.app.memberships",
      "https://www.googleapis.com/auth/chat.bot", "https://www.googleapis.com/auth/chat.app.messages.readonly",
      "https://www.googleapis.com/auth/pubsub",
    ]));
    expect(auth.request).toHaveBeenCalledWith(expect.objectContaining({ retry: false }));
  });

  it("loads the org's agent, model and effort beside the existing cwd/location knobs", () => {
    const config = loadConfig({ env: { ...base, GOOGLE_CHAT_DEFAULT_AGENT: "codex@remote",
      GOOGLE_CHAT_DEFAULT_MODEL: "org-model", GOOGLE_CHAT_DEFAULT_EFFORT: "medium",
      GOOGLE_CHAT_DEFAULT_CWD: "/org/repo", GOOGLE_CHAT_DEFAULT_LOCATION: "fallback" } }) as any;
    expect(config.GOOGLE_CHAT_DEFAULT_AGENT).toBe("codex@remote");
    expect(config.GOOGLE_CHAT_DEFAULT_MODEL).toBe("org-model");
    expect(config.GOOGLE_CHAT_DEFAULT_EFFORT).toBe("medium");
    expect(config.GOOGLE_CHAT_DEFAULT_CWD).toBe("/org/repo");
    expect(config.GOOGLE_CHAT_DEFAULT_LOCATION).toBe("fallback");
  });

  it("resolves one org snapshot without a requester or origin-session layer", () => {
    const config = loadConfig({ env: { ...base, GOOGLE_CHAT_DEFAULT_AGENT: "codex@remote",
      GOOGLE_CHAT_DEFAULT_MODEL: "org-model", GOOGLE_CHAT_DEFAULT_EFFORT: "medium",
      GOOGLE_CHAT_DEFAULT_CWD: "/org/repo", GOOGLE_CHAT_DEFAULT_LOCATION: "fallback" } });
    expect(foundation.resolveGoogleChatOrgDefaults(config)).toEqual({
      agentId: "codex", location: "remote", model: "org-model", effort: "medium", repo: "/org/repo",
    });
  });

  it("uses Seam's designated model/default effort and existing bare-agent location fallback", () => {
    const config = loadConfig({ env: { ...base, GOOGLE_CHAT_DEFAULT_LOCATION: "remote" } });
    expect(foundation.resolveGoogleChatOrgDefaults(config)).toEqual({
      agentId: "codex", location: "remote", model: "default", effort: "auto", repo: tmpdir(),
    });
  });

  it.each(["GOOGLE_CHAT_DEFAULT_AGENT", "GOOGLE_CHAT_DEFAULT_MODEL", "GOOGLE_CHAT_DEFAULT_EFFORT"])(
    "does not silently turn an explicitly empty %s into a different choice", key => {
      expect(() => loadConfig({ env: { ...base, [key]: "" } })).toThrow(key);
    });

  it("uses the existing catalog and repo preparation rather than Chat-specific value rules", async () => {
    const selection = { agentId: "codex", location: "remote", model: "native-alias", effort: "provider-special", repo: "chosen repo" };
    const resolve = vi.fn(() => ({ normalized: { model: "canonical-model", effort: "provider-special" } }));
    const prepareRepoChange = vi.fn(async () => ({ ok: true, cwd: "/remote/chosen repo" }));
    const getProfile = vi.fn(() => ({ id: "codex" }));
    const result = await foundation.prepareGoogleChatSpaceSelection(selection, {
      router: { getProfile }, modelCatalog: { resolve }, configPlan: { prepareRepoChange }, defaultCwd: tmpdir(),
    });
    expect(result).toEqual({ ...selection, model: "canonical-model", repo: "/remote/chosen repo" });
    expect(getProfile).toHaveBeenCalledWith("codex", "remote");
    expect(resolve).toHaveBeenCalledWith({ agentId: "codex", location: "remote" }, { model: "native-alias", effort: "provider-special" });
    expect(prepareRepoChange).toHaveBeenCalledWith("remote", "chosen repo");
  });

  it("passes unknown typed models through the existing catalog instead of refusing from a Chat cache", async () => {
    const resolve = vi.fn(() => ({ normalized: { model: "provider-new-id", effort: "" } }));
    const result = await foundation.prepareGoogleChatSpaceSelection({ agentId: "codex", location: "local",
      model: "provider-new-id", effort: "auto", repo: "/repo" }, {
      router: { getProfile: () => ({}) }, modelCatalog: { resolve },
      configPlan: { prepareRepoChange: async () => ({ ok: true, cwd: "/repo" }) }, defaultCwd: tmpdir(),
    });
    expect(result.model).toBe("provider-new-id"); expect(result.effort).toBe("auto");
    expect(resolve.mock.calls[0]).toEqual([{ agentId: "codex", location: "local" }, { model: "provider-new-id", effort: undefined }]);
  });

  it("preserves a real catalog cause and the shared repo refusal", async () => {
    const selection = { agentId: "codex", location: "remote", model: "model", effort: "high", repo: "/missing" };
    const cause = new Error("effort high is unsupported for model model in catalog generation 8");
    const deps = { router: { getProfile: () => ({}) }, modelCatalog: { resolve: () => { throw cause; } },
      configPlan: { prepareRepoChange: async () => ({ ok: false, error: "pwd: /missing: Permission denied" }) }, defaultCwd: tmpdir() };
    await expect(Promise.resolve().then(() => foundation.prepareGoogleChatSpaceSelection(selection, deps))).rejects.toBe(cause);
    deps.modelCatalog.resolve = () => ({ normalized: { model: "model", effort: "high" } }) as never;
    await expect(foundation.prepareGoogleChatSpaceSelection(selection, deps)).rejects.toThrow("pwd: /missing: Permission denied");
  });
});
