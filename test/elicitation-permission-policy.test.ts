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
  type CreateElicitationRequest,
  type RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import type { AgentProfile } from "@seam/adapters";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import {
  CODEX_APPROVAL_KIND_KEY,
  CODEX_APPROVAL_KIND_MCP_TOOL_CALL,
  autoResponseForApprovalPolicy,
  elicitationWithoutTrustGrant,
  handleElicitationWithPermissionPolicy,
  isMcpToolApprovalElicitation,
  responseWithoutTrustGrant,
} from "../packages/core/src/core/elicitation/approval-policy.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const logger = pino({ level: "silent" }) as unknown as Logger;

const record: SessionRecord = {
  id: "discord:thread-1",
  platform: "discord",
  channelRef: "thread-1",
  parentRef: "parent-1",
  agentId: "codex",
  acpSessionId: "acp-1",
  repoPath: "/repo",
  configJson: JSON.stringify({ permissionPolicy: "always" }),
  createdUtc: "2026-09-05T00:00:00.000Z",
  updatedUtc: "2026-09-05T00:00:00.000Z",
};

function approvalForm(over: Partial<CreateElicitationRequest> = {}): CreateElicitationRequest {
  return {
    mode: "form",
    sessionId: "acp-1",
    toolCallId: "call-1",
    message: "Allow Codex to call poll_inbox?",
    requestedSchema: {
      type: "object",
      properties: {
        persist: {
          type: "string",
          title: "Approval scope",
          oneOf: [
            { const: "once", title: "Allow once" },
            { const: "session", title: "Allow for this session" },
            { const: "always", title: "Allow and don't ask again" },
          ],
        },
      },
      required: ["persist"],
    },
    _meta: { [CODEX_APPROVAL_KIND_KEY]: CODEX_APPROVAL_KIND_MCP_TOOL_CALL, persist: ["session", "always"] },
    ...over,
  };
}

function normalForm(): CreateElicitationRequest {
  return {
    mode: "form",
    sessionId: "acp-1",
    message: "Allow Codex to call poll_inbox?",
    requestedSchema: {
      type: "object",
      properties: { note: { type: "string", title: "Note" } },
      required: ["note"],
    },
  };
}

function urlAuth(): CreateElicitationRequest {
  return {
    mode: "url",
    sessionId: "acp-1",
    message: "Complete sign-in on the provider page.",
    elicitationId: "auth-1",
    url: "https://example.test/authorize",
    _meta: { [CODEX_APPROVAL_KIND_KEY]: CODEX_APPROVAL_KIND_MCP_TOOL_CALL },
  };
}

const ctx = { requestId: 1, signal: new AbortController().signal };

describe("MCP tool approval elicitation identification", () => {
  it("matches only request _meta.codex_approval_kind=mcp_tool_call on form mode", () => {
    expect(isMcpToolApprovalElicitation(approvalForm())).toBe(true);
    expect(isMcpToolApprovalElicitation(approvalForm({
      requestedSchema: { type: "object", properties: {} },
    }))).toBe(true);
  });

  it("does not match message text, schema _meta, stored flags, or URL elicitations", () => {
    expect(isMcpToolApprovalElicitation(normalForm())).toBe(false);
    expect(isMcpToolApprovalElicitation({
      ...normalForm(),
      _meta: { [CODEX_APPROVAL_KIND_KEY]: "other" },
    })).toBe(false);
    expect(isMcpToolApprovalElicitation({
      ...normalForm(),
      requestedSchema: {
        type: "object",
        properties: { note: { type: "string" } },
        _meta: { [CODEX_APPROVAL_KIND_KEY]: CODEX_APPROVAL_KIND_MCP_TOOL_CALL },
      },
    })).toBe(false);
    expect(isMcpToolApprovalElicitation({
      ...normalForm(),
      ...({ seamMcpToolApproval: true } as object),
    } as CreateElicitationRequest)).toBe(false);
    expect(isMcpToolApprovalElicitation(urlAuth())).toBe(false);
  });
});

describe("approval policy auto-response", () => {
  it("maps always/deny to the exact codex-acp elicitation shape without persist", () => {
    expect(autoResponseForApprovalPolicy("always")).toEqual({ action: "accept" });
    expect(autoResponseForApprovalPolicy("deny")).toEqual({ action: "cancel" });
    expect(autoResponseForApprovalPolicy("ask")).toBeNull();
    expect(autoResponseForApprovalPolicy("always")).not.toHaveProperty("_meta");
    expect(autoResponseForApprovalPolicy("always")).not.toHaveProperty("content");
  });
});

describe("trust-grant stripping", () => {
  it("removes persist from the schema without touching correlation ids", () => {
    const stripped = elicitationWithoutTrustGrant(approvalForm());
    expect(stripped.mode).toBe("form");
    if (stripped.mode !== "form") throw new Error("expected form");
    expect(stripped.sessionId).toBe("acp-1");
    expect(stripped.toolCallId).toBe("call-1");
    expect(stripped.requestedSchema.properties).toEqual({});
    expect(stripped.requestedSchema.required).toBeUndefined();
    expect(stripped._meta).toMatchObject({ [CODEX_APPROVAL_KIND_KEY]: CODEX_APPROVAL_KIND_MCP_TOOL_CALL });
  });

  it("strips persist from accept content and _meta", () => {
    expect(responseWithoutTrustGrant({
      action: "accept",
      content: { persist: "always", note: "keep" },
      _meta: { persist: "session", other: 1 },
    })).toEqual({
      action: "accept",
      content: { note: "keep" },
      _meta: { other: 1 },
    });
    expect(responseWithoutTrustGrant({
      action: "accept",
      content: { persist: "always" },
      _meta: { persist: "always" },
    })).toEqual({ action: "accept" });
  });
});

describe("handleElicitationWithPermissionPolicy", () => {
  it("does not auto-accept a live request that only carries the durable storage flag", async () => {
    const elicitUser = vi.fn(async () => ({ action: "accept" as const, content: { note: "ok" } }));
    await expect(handleElicitationWithPermissionPolicy({
      request: {
        ...normalForm(),
        ...({ seamMcpToolApproval: true } as object),
      } as CreateElicitationRequest,
      context: ctx,
      mode: "always",
      elicitUser,
      record,
    })).resolves.toEqual({ action: "accept", content: { note: "ok" } });
    expect(elicitUser).toHaveBeenCalledTimes(1);
  });

  it("always auto-accepts approval elicitations without calling elicitUser", async () => {
    const elicitUser = vi.fn(async () => ({ action: "accept" as const, content: { persist: "always" } }));
    await expect(handleElicitationWithPermissionPolicy({
      request: approvalForm(),
      context: { ...ctx, signal: AbortSignal.abort() },
      mode: "always",
      elicitUser,
      record,
    })).resolves.toEqual({ action: "accept" });
    expect(elicitUser).not.toHaveBeenCalled();
  });

  it("deny auto-cancels approval elicitations without a card", async () => {
    const elicitUser = vi.fn(async () => ({ action: "accept" as const }));
    await expect(handleElicitationWithPermissionPolicy({
      request: approvalForm(),
      context: ctx,
      mode: "deny",
      elicitUser,
      record,
    })).resolves.toEqual({ action: "cancel" });
    expect(elicitUser).not.toHaveBeenCalled();
  });

  it("ask stays interactive, strips persist from the posted schema and the response", async () => {
    const elicitUser = vi.fn(async (_record, request) => {
      expect(request.mode).toBe("form");
      if (request.mode === "form") {
        expect(request.requestedSchema.properties).toEqual({});
        expect(request.requestedSchema.properties).not.toHaveProperty("persist");
      }
      return { action: "accept" as const, content: { persist: "session" }, _meta: { persist: "session" } };
    });
    await expect(handleElicitationWithPermissionPolicy({
      request: approvalForm(),
      context: ctx,
      mode: "ask",
      elicitUser,
      record,
    })).resolves.toEqual({ action: "accept" });
    expect(elicitUser).toHaveBeenCalledTimes(1);
  });

  it("does not apply the policy to lookalike messages or genuine forms/URLs", async () => {
    const elicitUser = vi.fn(async () => ({ action: "accept" as const, content: { note: "ok" } }));
    await expect(handleElicitationWithPermissionPolicy({
      request: normalForm(),
      context: ctx,
      mode: "always",
      elicitUser,
      record,
    })).resolves.toEqual({ action: "accept", content: { note: "ok" } });
    await expect(handleElicitationWithPermissionPolicy({
      request: urlAuth(),
      context: ctx,
      mode: "always",
      elicitUser,
      record,
    })).resolves.toEqual({ action: "accept", content: { note: "ok" } });
    expect(elicitUser).toHaveBeenCalledTimes(2);
  });
});

describe("SessionRouter permission vs elicitation wiring", () => {
  let dir: string;
  let store: SessionStore;
  let router: SessionRouter;
  let elicitCalls: CreateElicitationRequest[];
  let permissionCalls: RequestPermissionRequest[];
  let agentSaw: unknown[] = [];
  let agentConnection: { close(): void };

  function fakeChild() {
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
    const transportAgent = agent({ name: "permission-elicit-agent" })
      .onRequest(methods.agent.initialize, () => ({
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
      }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: "wire-session" }))
      .onRequest(methods.agent.session.load, ({ params }) => ({ sessionId: params.sessionId }))
      .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
        const text = params.prompt.map((block) => "text" in block ? block.text : "").join("");
        if (text.includes("permission")) {
          agentSaw.push(await client.request(methods.client.session.requestPermission, {
            sessionId: "wire-session",
            toolCall: { toolCallId: "perm-1", kind: "execute", status: "pending", title: "run" },
            options: [
              { optionId: "allow_once", name: "Allow", kind: "allow_once" },
              { optionId: "cancel", name: "Cancel", kind: "reject_once" },
            ],
          }));
          return { stopReason: "end_turn" };
        }
        if (text.includes("approval")) {
          agentSaw.push(await client.request(methods.client.elicitation.create, approvalForm({
            sessionId: "wire-session",
          })));
          return { stopReason: "end_turn" };
        }
        if (text.includes("url")) {
          agentSaw.push(await client.request(methods.client.elicitation.create, {
            ...urlAuth(),
            sessionId: "wire-session",
          }));
          return { stopReason: "end_turn" };
        }
        agentSaw.push(await client.request(methods.client.elicitation.create, {
          ...normalForm(),
          sessionId: "wire-session",
          message: "A real question",
        }));
        return { stopReason: "end_turn" };
      })
      .onNotification(methods.agent.session.cancel, () => {});
    agentConnection = transportAgent.connect(
      ndJsonStream(
        Writable.toWeb(stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(stdin) as ReadableStream<Uint8Array>
      )
    );
    return child;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-elicit-perm-"));
    store = new SessionStore(path.join(dir, "state.db"));
    elicitCalls = [];
    permissionCalls = [];
    agentSaw = [];
    const profile = {
      id: "codex",
      defaultModel: "gpt-test",
      spawn: () => fakeChild(),
    } as unknown as AgentProfile;
    router = new SessionRouter({
      logger,
      store,
      profiles: [profile],
      defaultAgentId: "codex",
      defaultModel: "gpt-test",
      defaultPermissionMode: "ask",
    });
    router.setAskUser(async (_record, req) => {
      permissionCalls.push(req);
      return { outcome: { outcome: "selected", optionId: req.options[0]!.optionId } };
    });
    router.setElicitationHandlers({
      create: async (_record, request) => {
        elicitCalls.push(request);
        return { action: "accept", content: { note: "interactive" } };
      },
      complete: async () => {},
      cancel: async () => {},
    });
  });

  afterEach(async () => {
    await router.disposeAll();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    agentConnection?.close();
  });

  async function startWithPolicy(policy: "always" | "ask" | "deny"): Promise<SessionRecord> {
    const row: SessionRecord = {
      ...record,
      id: "discord:perm-thread",
      channelRef: "perm-thread",
      acpSessionId: "",
      configJson: JSON.stringify({ permissionPolicy: policy, model: "gpt-test" }),
    };
    store.upsert(row);
    return row;
  }

  it("requestPermission still auto-selects allow_ under always and does not post an elicitation card", async () => {
    const row = await startWithPolicy("always");
    const rt = await router.getOrStartRuntime(row);
    const result = await rt.prompt("permission");
    expect(result).toMatchObject({ stopReason: "end_turn" });
    expect(permissionCalls).toHaveLength(0);
    expect(elicitCalls).toHaveLength(0);
    expect(agentSaw).toEqual([{ outcome: { outcome: "selected", optionId: "allow_once" } }]);
  });

  it("approval-shaped elicitation/create auto-accepts under always with no card and no persist grant", async () => {
    const row = await startWithPolicy("always");
    const rt = await router.getOrStartRuntime(row);
    await rt.prompt("approval");
    expect(elicitCalls).toHaveLength(0);
    expect(agentSaw).toEqual([{ action: "accept" }]);
    expect(JSON.stringify(agentSaw[0])).not.toMatch(/persist/);
  });

  it("approval-shaped elicitation/create auto-cancels under deny with no card", async () => {
    const row = await startWithPolicy("deny");
    const rt = await router.getOrStartRuntime(row);
    await rt.prompt("approval");
    expect(elicitCalls).toHaveLength(0);
    expect(agentSaw).toEqual([{ action: "cancel" }]);
  });

  it("ask keeps approval elicitations interactive after stripping persist", async () => {
    const row = await startWithPolicy("ask");
    const rt = await router.getOrStartRuntime(row);
    await rt.prompt("approval");
    expect(elicitCalls).toHaveLength(1);
    const posted = elicitCalls[0]!;
    expect(posted.mode).toBe("form");
    if (posted.mode === "form") {
      expect(posted.requestedSchema.properties).not.toHaveProperty("persist");
    }
  });

  it("re-reads the live session policy after /seam approve-style upsert", async () => {
    const row = await startWithPolicy("always");
    const rt = await router.getOrStartRuntime(row);
    expect(row.configJson).toContain("always");
    store.upsert({
      ...row,
      configJson: JSON.stringify({ permissionPolicy: "deny", model: "gpt-test" }),
      updatedUtc: new Date().toISOString(),
    });
    expect(row.configJson).toContain("always");
    await rt.prompt("approval");
    expect(elicitCalls).toHaveLength(0);
    expect(agentSaw).toEqual([{ action: "cancel" }]);
  });

  it("normal forms and URL elicitations stay interactive even when policy is always", async () => {
    const row = await startWithPolicy("always");
    const rt = await router.getOrStartRuntime(row);
    await rt.prompt("form");
    await rt.prompt("url");
    expect(elicitCalls).toHaveLength(2);
    expect(elicitCalls[0]?.mode).toBe("form");
    expect(elicitCalls[1]?.mode).toBe("url");
  });

  it("requestPermission under ask still uses the permission card path, not elicitation", async () => {
    const row = await startWithPolicy("ask");
    const rt = await router.getOrStartRuntime(row);
    await rt.prompt("permission");
    expect(permissionCalls).toHaveLength(1);
    expect(elicitCalls).toHaveLength(0);
    expect(permissionCalls[0]!.options[0]!.optionId).toBe("allow_once");
  });
});
