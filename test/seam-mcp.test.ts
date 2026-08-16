import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pino } from "pino";
import { SeamTokenRegistry } from "../src/core/mcp/token-registry.js";
import {
  SeamMcpServer,
  buildSeamMcpServerEntry,
  type PeekedMessage,
  type SeamMcpServerDeps,
} from "../src/core/mcp/seam-mcp-server.js";
import type { Logger } from "../src/lib/logger.js";
import type { SessionRecord } from "../src/core/types.js";
import type { DispatchSpec } from "../src/core/dispatch/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

function makeRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "discord:thread-caller",
    platform: "discord",
    channelRef: "thread-caller",
    parentRef: null,
    agentId: "claude",
    acpSessionId: "acp-1",
    repoPath: "/repo",
    configJson: "{}",
    createdUtc: "2026-01-01T00:00:00Z",
    updatedUtc: "2026-01-01T00:00:00Z",
    ...over,
  };
}

// -------------------------------------------------------------------------
// Token registry
// -------------------------------------------------------------------------

describe("SeamTokenRegistry", () => {
  it("mints a token that resolves back to the session id", () => {
    const reg = new SeamTokenRegistry();
    const token = reg.mint("discord:thread-a");
    expect(token).toBeTruthy();
    expect(reg.resolve(token)).toBe("discord:thread-a");
    expect(reg.size).toBe(1);
  });

  it("resolves unknown / empty tokens to undefined", () => {
    const reg = new SeamTokenRegistry();
    reg.mint("s1");
    expect(reg.resolve("nope")).toBeUndefined();
    expect(reg.resolve(undefined)).toBeUndefined();
    expect(reg.resolve("")).toBeUndefined();
  });

  it("revokes a session's token so it no longer resolves", () => {
    const reg = new SeamTokenRegistry();
    const token = reg.mint("s1");
    reg.revokeSession("s1");
    expect(reg.resolve(token)).toBeUndefined();
    expect(reg.size).toBe(0);
  });

  it("rotates the token on re-mint (old token stops resolving)", () => {
    const reg = new SeamTokenRegistry();
    const first = reg.mint("s1");
    const second = reg.mint("s1");
    expect(first).not.toBe(second);
    expect(reg.resolve(first)).toBeUndefined();
    expect(reg.resolve(second)).toBe("s1");
    expect(reg.size).toBe(1);
  });
});

// -------------------------------------------------------------------------
// HTTP MCP server
// -------------------------------------------------------------------------

interface Harness {
  server: SeamMcpServer;
  enqueued: DispatchSpec[];
  scheduledWakes: Array<{ record: SessionRecord; req: { delaySeconds: number; reason: string; prompt: string } }>;
  cancelledWakes: string[];
  call: (
    method: string,
    params?: unknown,
    headers?: Record<string, string>
  ) => Promise<{ status: number; body: any }>;
}

async function makeHarness(opts?: {
  resolveSession?: (token: string | undefined) => SessionRecord | undefined;
  peekThread?: (threadId: string, count: number) => Promise<PeekedMessage[]>;
  scheduleWake?: SeamMcpServerDeps["scheduleWake"];
  cancelWake?: SeamMcpServerDeps["cancelWake"];
}): Promise<Harness> {
  const enqueued: DispatchSpec[] = [];
  const scheduledWakes: Harness["scheduledWakes"] = [];
  const cancelledWakes: string[] = [];
  const server = new SeamMcpServer({
    logger: silent,
    resolveSession:
      opts?.resolveSession ??
      ((token) => (token === "good-token" ? makeRecord() : undefined)),
    enqueueDispatch: async (spec) => {
      enqueued.push(spec);
    },
    scheduleWake:
      opts?.scheduleWake ??
      ((record, req) => {
        scheduledWakes.push({ record, req });
        return { ok: true as const, wakeId: "wake-1", fireAtUtc: "2026-08-16T00:20:00.000Z" };
      }),
    cancelWake:
      opts?.cancelWake ??
      ((_record, id) => {
        cancelledWakes.push(id);
        return true;
      }),
    ...(opts?.peekThread ? { peekThread: opts.peekThread } : {}),
  });
  await server.start();
  const port = server.port;

  const call = async (
    method: string,
    params?: unknown,
    headers?: Record<string, string>
  ) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };

  return { server, enqueued, scheduledWakes, cancelledWakes, call };
}

describe("SeamMcpServer", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.server.stop();
  });

  it("binds an ephemeral loopback port", async () => {
    h = await makeHarness();
    expect(h.server.port).toBeGreaterThan(0);
  });

  it("initialize returns tools capability + instructions", async () => {
    h = await makeHarness();
    const { body } = await h.call("initialize", { protocolVersion: "2025-06-18" });
    expect(body.result.capabilities).toEqual({ tools: {} });
    expect(body.result.serverInfo.name).toBe("seam-mcp");
    expect(typeof body.result.instructions).toBe("string");
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("tools/list advertises handoff, forward, peek, steer, chain, config_describe, wakes", async () => {
    h = await makeHarness();
    const { body } = await h.call("tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "cancel_wake",
      "chain",
      "config_describe",
      "forward",
      "handoff",
      "peek",
      "schedule_wake",
      "steer",
    ]);
    for (const t of body.result.tools) {
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("tools/call with a valid token resolves the caller and enqueues a handoff", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "handoff", arguments: { worker: "reviewer", prompt: "review PR 42" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBeFalsy();
    expect(h.enqueued).toHaveLength(1);
    const spec = h.enqueued[0]!;
    // Preset name → isolated run under that preset, target defaults to caller.
    expect(spec.preset).toBe("reviewer");
    expect(spec.session).toBe("isolated");
    expect(spec.target).toBe("thread-caller");
    // returnTo defaults to the caller's thread.
    expect(spec.returnTo).toBe("thread-caller");
    expect(spec.kind).toBe("handoff");
  });

  it("handoff to a thread-id worker runs live in that thread", async () => {
    h = await makeHarness();
    await h.call(
      "tools/call",
      {
        name: "handoff",
        arguments: { worker: "123456789012345678", prompt: "hi", returnTo: "999999999999999999" },
      },
      { "X-Seam-Session": "good-token" }
    );
    const spec = h.enqueued[0]!;
    expect(spec.preset).toBeUndefined();
    expect(spec.session).toBe("live");
    expect(spec.target).toBe("123456789012345678");
    expect(spec.returnTo).toBe("999999999999999999");
  });

  it("forward enqueues a live dispatch into the target with returnTo=caller", async () => {
    h = await makeHarness();
    await h.call(
      "tools/call",
      { name: "forward", arguments: { to: "222222222222222222", content: "relay this" } },
      { "X-Seam-Session": "good-token" }
    );
    const spec = h.enqueued[0]!;
    expect(spec.kind).toBe("forward");
    expect(spec.target).toBe("222222222222222222");
    expect(spec.prompt).toBe("relay this");
    expect(spec.session).toBe("live");
    expect(spec.returnTo).toBe("thread-caller");
  });

  it("steer enqueues a live dispatch of the FRAMED prompt into the target thread", async () => {
    h = await makeHarness();
    await h.call(
      "tools/call",
      { name: "steer", arguments: { thread: "333333333333333333", prompt: "focus on the failing test first" } },
      { "X-Seam-Session": "good-token" }
    );
    const spec = h.enqueued[0]!;
    expect(spec.kind).toBe("handoff");
    expect(spec.target).toBe("333333333333333333");
    expect(spec.session).toBe("live");
    expect(spec.returnTo).toBe("thread-caller");
    // The raw prompt is wrapped in the <seam-steer> frame, not passed verbatim.
    expect(spec.prompt).toContain("<seam-steer>");
    expect(spec.prompt).toContain("focus on the failing test first");
    expect(spec.prompt).toContain("steering you mid-task");
  });

  it("schedule_wake routes to the caller's scheduleWake dep and returns the wake id (#59)", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "schedule_wake", arguments: { delaySeconds: 1200, reason: "check build", prompt: "resume" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBeFalsy();
    expect(h.scheduledWakes).toHaveLength(1);
    expect(h.scheduledWakes[0]!.req).toEqual({ delaySeconds: 1200, reason: "check build", prompt: "resume" });
    // The caller is the token-resolved session, never a caller-supplied thread.
    expect(h.scheduledWakes[0]!.record.channelRef).toBe("thread-caller");
    expect(body.result.content[0].text).toContain("wake-1");
  });

  it("schedule_wake surfaces a guard rejection as an isError result (#59)", async () => {
    h = await makeHarness({
      scheduleWake: () => ({ ok: false as const, error: "delaySeconds 5 is below the 60s floor" }),
    });
    const { body } = await h.call(
      "tools/call",
      { name: "schedule_wake", arguments: { delaySeconds: 5, prompt: "x" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/below the 60s floor/);
    expect(h.scheduledWakes).toHaveLength(0);
  });

  it("cancel_wake routes to the caller's cancelWake dep (#59)", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "cancel_wake", arguments: { wakeId: "wake-xyz" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    expect(h.cancelledWakes).toEqual(["wake-xyz"]);
  });

  it("cancel_wake reports when nothing was removed (#59)", async () => {
    h = await makeHarness({ cancelWake: () => false });
    const { body } = await h.call(
      "tools/call",
      { name: "cancel_wake", arguments: { wakeId: "gone" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/No pending wake/);
  });

  it("tools/call with a MISSING token returns a JSON-RPC error and enqueues nothing", async () => {
    h = await makeHarness();
    const { body } = await h.call("tools/call", {
      name: "handoff",
      arguments: { worker: "reviewer", prompt: "x" },
    });
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32001);
    expect(h.enqueued).toHaveLength(0);
  });

  it("tools/call with an UNKNOWN token is rejected", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "handoff", arguments: { worker: "r", prompt: "x" } },
      { "X-Seam-Session": "bogus" }
    );
    expect(body.error.code).toBe(-32001);
    expect(h.enqueued).toHaveLength(0);
  });

  it("peek reads recent messages via the injected peekThread", async () => {
    h = await makeHarness({
      peekThread: async (threadId, count) => {
        expect(threadId).toBe("thread-x");
        expect(count).toBe(5);
        return [
          { authorIsBot: false, text: "hello" },
          { authorIsBot: true, text: "hi there" },
        ];
      },
    });
    const { body } = await h.call(
      "tools/call",
      { name: "peek", arguments: { thread: "thread-x", count: 5 } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    const text = body.result.content[0].text;
    expect(text).toContain("hello");
    expect(text).toContain("hi there");
  });

  it("bad tool args surface as an isError tool result, not a protocol error", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "handoff", arguments: { prompt: "no worker" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(h.enqueued).toHaveLength(0);
  });

  it("unknown method returns method-not-found", async () => {
    h = await makeHarness();
    const { body } = await h.call("nonsense/method");
    expect(body.error.code).toBe(-32601);
  });

  it("notifications/initialized gets a 202 with no body", async () => {
    h = await makeHarness();
    const res = await fetch(`http://127.0.0.1:${h.server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });
});

describe("buildSeamMcpServerEntry", () => {
  it("builds an http entry carrying the X-Seam-Session header", () => {
    const entry = buildSeamMcpServerEntry(4321, "tok-abc") as {
      type: string;
      name: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
    };
    expect(entry.type).toBe("http");
    expect(entry.name).toBe("seam-mcp");
    expect(entry.url).toBe("http://127.0.0.1:4321/mcp");
    expect(entry.headers).toEqual([{ name: "X-Seam-Session", value: "tok-abc" }]);
  });
});

// -------------------------------------------------------------------------
// config_describe — read-only config introspection (#58 P1)
// -------------------------------------------------------------------------

describe("config_describe", () => {
  const description = {
    sessionId: "discord:thread-caller",
    channelRef: "thread-caller",
    parentRef: "chan-1",
    agent: { value: "claude", source: "session config" as const },
    model: { value: "claude-opus-4.6", source: "channel preset" as const },
    effort: { value: "high", source: "thread preset" as const },
    cwd: { value: "/repo/x", source: "channel preset" as const },
    permission: { value: "ask", source: "default" as const },
    locked: true,
  };

  async function makeDescribeServer(): Promise<SeamMcpServer> {
    const server = new SeamMcpServer({
      logger: silent,
      resolveSession: (token) => (token === "good-token" ? makeRecord({ parentRef: "chan-1" }) : undefined),
      enqueueDispatch: async () => {},
      describeConfig: () => description,
      listConfigEntities: () => ({
        schedules: [
          { name: "morning", cron: "0 7 * * 1-5", timezone: "America/Chicago", enabled: true, nextRunUtc: "2026-08-17T12:00:00Z" },
        ],
        presets: [
          { name: "ts-reviewer", scope: "project", agentId: "claude", model: "claude-opus-4.6" },
        ],
      }),
    });
    await server.start();
    return server;
  }

  async function callTool(server: SeamMcpServer, args: unknown, token = "good-token") {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Seam-Session": token },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "config_describe", arguments: args } }),
    });
    return JSON.parse(await res.text());
  }

  it("renders the effective config with which layer won", async () => {
    const server = await makeDescribeServer();
    try {
      const body = await callTool(server, {});
      expect(body.result.isError).toBeFalsy();
      const text = body.result.content[0].text as string;
      expect(text).toContain("claude-opus-4.6");
      expect(text).toContain("(from channel preset)");
      expect(text).toContain("(from thread preset)");
      expect(text).toContain("(from session config)");
      expect(text).toContain("(from default)");
      expect(text).toContain("🔒");
      // Entity listing folds in.
      expect(text).toContain("morning");
      expect(text).toContain("ts-reviewer");
    } finally {
      await server.stop();
    }
  });

  it("allows an explicit self scope (own thread id)", async () => {
    const server = await makeDescribeServer();
    try {
      const body = await callTool(server, { scope: "thread-caller" });
      expect(body.result.isError).toBeFalsy();
      expect(body.result.content[0].text).toContain("claude-opus-4.6");
    } finally {
      await server.stop();
    }
  });

  it("refuses to describe another thread (cross-thread is privileged, D3)", async () => {
    const server = await makeDescribeServer();
    try {
      const body = await callTool(server, { scope: "some-other-thread" });
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toMatch(/privileged/i);
    } finally {
      await server.stop();
    }
  });

  it("rejects an unknown/missing token before doing any work", async () => {
    const server = await makeDescribeServer();
    try {
      const body = await callTool(server, {}, "bad-token");
      expect(body.error.code).toBe(-32001);
    } finally {
      await server.stop();
    }
  });
});
