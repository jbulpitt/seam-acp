import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pino } from "pino";
import { SeamTokenRegistry } from "../packages/core/src/core/mcp/token-registry.js";
import {
  SeamMcpServer,
  buildSeamMcpServerEntry,
  type PeekedMessage,
  type SeamMcpServerDeps,
} from "../packages/core/src/core/mcp/seam-mcp-server.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import {
  applyWatchFeedback,
  WATCH_FEEDBACK_INSTRUCTION,
  type DispatchSpec,
} from "../packages/core/src/core/dispatch/types.js";

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

  it("peek returns the current token without rotating", () => {
    const reg = new SeamTokenRegistry();
    expect(reg.peek("s1")).toBeUndefined();
    const first = reg.mint("s1");
    expect(reg.peek("s1")).toBe(first);
    expect(reg.peek("s1")).toBe(first);
    expect(reg.resolve(first)).toBe("s1");
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
  createdWatches: Array<{ record: SessionRecord; req: any }>;
  cancelledWatches: string[];
  /** Per-session-ref inbox backing the send/poll_inbox stubs (session_ref → messages). */
  inbox: Map<string, Array<{ fromRef: string | null; body: string; priority: boolean; createdUtc: string }>>;
  /** Every interrupt (#67) routed through the interruptRedirect dep. */
  interrupts: Array<{ caller: SessionRecord; to: string; message: string; fresh: boolean }>;
  call: (
    method: string,
    params?: unknown,
    headers?: Record<string, string>
  ) => Promise<{ status: number; body: any }>;
}

async function makeHarness(opts?: {
  resolveSession?: (token: string | undefined) => SessionRecord | undefined;
  peekThread?: (threadId: string, count: number) => Promise<PeekedMessage[]>;
  listThreads?: SeamMcpServerDeps["listThreads"];
  scheduleWake?: SeamMcpServerDeps["scheduleWake"];
  cancelWake?: SeamMcpServerDeps["cancelWake"];
  createChoice?: SeamMcpServerDeps["createChoice"];
  cancelChoice?: SeamMcpServerDeps["cancelChoice"];
  createWatch?: SeamMcpServerDeps["createWatch"];
  cancelWatch?: SeamMcpServerDeps["cancelWatch"];
  listWatches?: SeamMcpServerDeps["listWatches"];
  isChannelLocked?: (record: SessionRecord) => boolean;
  configAdminUserIds?: ReadonlySet<string>;
  configParticipantUserIds?: ReadonlySet<string>;
  currentSpeakerId?: (record: SessionRecord) => string | undefined;
  proposeConfig?: (record: SessionRecord, input: unknown) => Promise<any>;
  pushInbox?: SeamMcpServerDeps["pushInbox"];
  drainInbox?: SeamMcpServerDeps["drainInbox"];
  interruptRedirect?: SeamMcpServerDeps["interruptRedirect"];
  /** Omit the compact dep entirely (to test the "not supported" refusal). */
  disableCompact?: boolean;
  /** Omit the inbox deps entirely (to test the "not supported" refusal). */
  disableInbox?: boolean;
  /** Omit the interrupt dep entirely (to test the "not supported" refusal). */
  disableInterrupt?: boolean;
}): Promise<Harness> {
  const enqueued: DispatchSpec[] = [];
  const scheduledWakes: Harness["scheduledWakes"] = [];
  const cancelledWakes: string[] = [];
  const createdWatches: Harness["createdWatches"] = [];
  const cancelledWatches: string[] = [];
  // In-memory inbox mirroring the store: keyed by the OWNING session ref
  // (`${platform}:${channelRef}`). `send` pushes to the target's ref; poll_inbox
  // drains the caller's own ref (deliver-once).
  const inbox: Harness["inbox"] = new Map();
  const interrupts: Harness["interrupts"] = [];
  const server = new SeamMcpServer({
    logger: silent,
    resolveSession:
      opts?.resolveSession ??
      ((token) => (token === "good-token" ? makeRecord({ parentRef: "chan-1" }) : undefined)),
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
    createChoice:
      opts?.createChoice ??
      (async () => ({ ok: true as const, choiceId: "choice-1", messageId: "msg-1" })),
    cancelChoice:
      opts?.cancelChoice ??
      (async () => ({ ok: true as const })),
    createWatch:
      opts?.createWatch ??
      ((record, req) => {
        createdWatches.push({ record, req });
        return {
          ok: true as const,
          watchId: "watch-1",
          expiresAtUtc: "2026-08-16T01:00:00.000Z",
          intervalSeconds: (req.intervalSeconds as number) ?? 30,
        };
      }),
    cancelWatch:
      opts?.cancelWatch ??
      ((_record, id) => {
        cancelledWatches.push(id);
        return true;
      }),
    listWatches:
      opts?.listWatches ??
      (() => [
        {
          id: "watch-1",
          kind: "http",
          spec: "https://ci/status",
          intervalSeconds: 60,
          mode: "once",
          fireCount: 0,
          maxFires: 1,
          expiresAtUtc: "2026-08-16T01:00:00.000Z",
          reason: "wait for CI",
        },
      ]),
    ...(opts?.peekThread ? { peekThread: opts.peekThread } : {}),
    ...(opts?.listThreads ? { listThreads: opts.listThreads } : {}),
    ...(opts?.isChannelLocked ? { isChannelLocked: opts.isChannelLocked } : {}),
    ...(opts?.configAdminUserIds ? { configAdminUserIds: opts.configAdminUserIds } : {}),
    ...(opts?.configParticipantUserIds
      ? { configParticipantUserIds: opts.configParticipantUserIds }
      : {}),
    ...(opts?.currentSpeakerId ? { currentSpeakerId: opts.currentSpeakerId } : {}),
    ...(opts?.proposeConfig ? { proposeConfig: opts.proposeConfig } : {}),
    // The compact tool only ENQUEUES; its dep is a presence gate. Provide a stub
    // by default so the tool is enabled, and omit it when disableCompact is set.
    ...(opts?.disableCompact
      ? {}
      : {
          compactThread: async (record) => ({
            newSessionId: "sess-new",
            originalSessionId: record.acpSessionId,
            wasActive: true,
            reportMarkdown: "# report",
            stats: { chunks: 3 },
          }),
        }),
    // Agent inbox (#61): default stubs back a real in-memory queue so the
    // send→poll round-trip and self-scope can be exercised end to end. Omit both
    // deps when disableInbox is set to test the "not supported" refusal.
    ...(opts?.disableInbox
      ? {}
      : {
          pushInbox:
            opts?.pushInbox ??
            ((caller, to, message, priority) => {
              const ref = `${caller.platform}:${to}`;
              const queue = inbox.get(ref) ?? [];
              queue.push({
                fromRef: caller.channelRef,
                body: message,
                priority: priority ?? false,
                createdUtc: "2026-08-16T00:00:00.000Z",
              });
              inbox.set(ref, queue);
              return { ok: true as const, queued: queue.length };
            }),
          drainInbox:
            opts?.drainInbox ??
            ((record) => {
              const queue = inbox.get(record.id) ?? [];
              inbox.delete(record.id);
              return queue;
            }),
        }),
    // Interrupt (#67): default stub records the call and reports a cancelled
    // redirect. Omit when disableInterrupt is set to test the refusal.
    ...(opts?.disableInterrupt
      ? {}
      : {
          interruptRedirect:
            opts?.interruptRedirect ??
            (async (caller, to, message, fresh) => {
              interrupts.push({ caller, to, message, fresh });
              return { ok: true as const, cancelled: "cancelled" as const, fresh, dispatchId: "disp-int-1" };
            }),
        }),
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

  return { server, enqueued, scheduledWakes, cancelledWakes, createdWatches, cancelledWatches, inbox, interrupts, call };
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

  it("tools/list advertises handoff, forward, peek, steer, chain, compact, config_describe, config_propose, wakes", async () => {
    h = await makeHarness();
    const { body } = await h.call("tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "cancel_choice",
      "cancel_wake",
      "chain",
      "compact",
      "config_describe",
      "config_propose",
      "create_choice",
      "forward",
      "handoff",
      "peek",
      "poll_inbox",
      "schedule_wake",
      "send",
      "steer",
      "submit_result",
      "threads",
      "watch_cancel",
      "watch_create",
      "watch_list",
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

  it("handoff to agentId@location carries location on the spec (#84 remainder)", async () => {
    h = await makeHarness();
    await h.call(
      "tools/call",
      { name: "handoff", arguments: { worker: "claude@mac", prompt: "run on the mac" } },
      { "X-Seam-Session": "good-token" }
    );
    const spec = h.enqueued[0]!;
    expect(spec.session).toBe("isolated");
    expect(spec.preset).toBe("claude");
    expect(spec.location).toBe("mac");
    expect(spec.target).toBe("thread-caller");
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

  it("handoff/forward advertise the stream option in their input schema", async () => {
    h = await makeHarness();
    const { body } = await h.call("tools/list");
    const byName = new Map(body.result.tools.map((t: any) => [t.name, t]));
    expect(byName.get("handoff").inputSchema.properties.stream.type).toBe("boolean");
    expect(byName.get("forward").inputSchema.properties.stream.type).toBe("boolean");
  });

  // --- handoff feedback channel: watchFeedback (#62) ------------------------

  it("handoff advertises the watchFeedback option in its input schema (#62)", async () => {
    h = await makeHarness();
    const { body } = await h.call("tools/list");
    const byName = new Map(body.result.tools.map((t: any) => [t.name, t]));
    // Adding an OPTION to handoff does NOT change the tool count (#91 took it to 18).
    expect(body.result.tools).toHaveLength(19);
    expect(byName.get("handoff").inputSchema.properties.watchFeedback.type).toBe("boolean");
  });

  it("handoff with watchFeedback:true carries the flag on the spec (#62)", async () => {
    h = await makeHarness();
    await h.call(
      "tools/call",
      { name: "handoff", arguments: { worker: "reviewer", prompt: "review PR 42", watchFeedback: true } },
      { "X-Seam-Session": "good-token" }
    );
    const spec = h.enqueued[0]!;
    expect(spec.watchFeedback).toBe(true);
  });

  it("handoff without watchFeedback leaves the flag off the spec (#62)", async () => {
    h = await makeHarness();
    await h.call(
      "tools/call",
      { name: "handoff", arguments: { worker: "reviewer", prompt: "review PR 42" } },
      { "X-Seam-Session": "good-token" }
    );
    const spec = h.enqueued[0]!;
    expect(spec.watchFeedback).toBeUndefined();
  });

  it("watchFeedback appends the poll_inbox instruction to the worker prompt dispatchInjectTurn builds (#62)", () => {
    // `applyWatchFeedback` is exactly the composition dispatchInjectTurn runs on
    // the dispatched prompt (after any preset-identity prepend). With the flag on,
    // the standing instruction reaches the worker; without it, the prompt is
    // untouched — so vanilla handoffs are unchanged.
    const base = "<seam-worker-identity>…</seam-worker-identity>\n\ndo the task";
    const withFlag = applyWatchFeedback(base, true);
    expect(withFlag).toContain(base);
    expect(withFlag).toContain(WATCH_FEEDBACK_INSTRUCTION);
    expect(withFlag).toContain("poll_inbox");
    expect(withFlag).toContain("you do not need to restart");
    // #66: the standing text now also steers on PRIORITY items — stop and reorient.
    expect(withFlag).toContain("PRIORITY");
    expect(withFlag).toContain("reorient to it, even mid-task");

    expect(applyWatchFeedback(base, false)).toBe(base);
    expect(applyWatchFeedback(base, undefined)).toBe(base);
  });

  it("handoff defaults stream ON (omitted from spec) and honors stream:false", async () => {
    h = await makeHarness();
    // Omitted → spec carries no `stream`, so the runtime default (ON) applies.
    await h.call(
      "tools/call",
      { name: "handoff", arguments: { worker: "reviewer", prompt: "review" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(h.enqueued[0]!.stream).toBeUndefined();

    // Explicit false → the escape hatch is plumbed straight onto the spec.
    await h.call(
      "tools/call",
      { name: "handoff", arguments: { worker: "reviewer", prompt: "review", stream: false } },
      { "X-Seam-Session": "good-token" }
    );
    expect(h.enqueued[1]!.stream).toBe(false);
  });

  it("forward plumbs stream:false onto the spec", async () => {
    h = await makeHarness();
    await h.call(
      "tools/call",
      { name: "forward", arguments: { to: "222222222222222222", content: "relay", stream: false } },
      { "X-Seam-Session": "good-token" }
    );
    expect(h.enqueued[0]!.stream).toBe(false);
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

  it("compact with no `thread` arg enqueues a kind:compact dispatch scoped to the caller", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "compact", arguments: {} },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBeFalsy();
    expect(h.enqueued).toHaveLength(1);
    const spec = h.enqueued[0]!;
    // It's a compact dispatch, NOT an inject-turn handoff.
    expect(spec.kind).toBe("compact");
    // Self-scoped: target defaults to the caller's own thread.
    expect(spec.target).toBe("thread-caller");
    // The caller is stamped as the actor (returnTo) for the ledger.
    expect(spec.returnTo).toBe("thread-caller");
    // Default source is session-history.
    expect(spec.compactSource).toBe("session");
    // Result message tells the caller it runs off-turn and posts to the thread.
    expect(body.result.content[0].text).toMatch(/Compaction started for thread thread-caller/);
  });

  it("compact with an explicit `thread` targets that thread but keeps the caller as actor", async () => {
    h = await makeHarness();
    await h.call(
      "tools/call",
      { name: "compact", arguments: { thread: "444444444444444444" } },
      { "X-Seam-Session": "good-token" }
    );
    const spec = h.enqueued[0]!;
    expect(spec.kind).toBe("compact");
    expect(spec.target).toBe("444444444444444444");
    // Actor→target is preserved: caller is the source, the named thread the target.
    expect(spec.returnTo).toBe("thread-caller");
  });

  it("compact honors source:discord", async () => {
    h = await makeHarness();
    await h.call(
      "tools/call",
      { name: "compact", arguments: { source: "discord" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(h.enqueued[0]!.compactSource).toBe("discord");
  });

  it("compact refuses gracefully when the deployment has no compactThread dep", async () => {
    h = await makeHarness({ disableCompact: true });
    const { body } = await h.call(
      "tools/call",
      { name: "compact", arguments: {} },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/not supported/);
    // Nothing was enqueued on the refusal path.
    expect(h.enqueued).toHaveLength(0);
  });

  it("compact rejects an unknown token with -32001 before enqueuing", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "compact", arguments: {} },
      { "X-Seam-Session": "bad-token" }
    );
    expect(body.error.code).toBe(-32001);
    expect(h.enqueued).toHaveLength(0);
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
    expect(h.scheduledWakes[0]!.req).toEqual({
      delaySeconds: 1200,
      reason: "check build",
      prompt: "resume",
      fireOnStartup: false,
    });
    // The caller is the token-resolved session, never a caller-supplied thread.
    expect(h.scheduledWakes[0]!.record.channelRef).toBe("thread-caller");
    expect(body.result.content[0].text).toContain("wake-1");
  });

  it("schedule_wake threads onStartup=true through to the scheduleWake dep (#59)", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "schedule_wake", arguments: { onStartup: true, prompt: "resume after restart" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBeFalsy();
    expect(h.scheduledWakes).toHaveLength(1);
    expect(h.scheduledWakes[0]!.req.fireOnStartup).toBe(true);
    // delaySeconds is optional when onStartup is set — arrives as NaN, ignored.
    expect(Number.isNaN(h.scheduledWakes[0]!.req.delaySeconds)).toBe(true);
    expect(body.result.content[0].text).toContain("next process boot");
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

  it("watch_create routes to the caller's createWatch dep and returns the watch id (#60)", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      {
        name: "watch_create",
        arguments: {
          kind: "http",
          spec: "https://ci/status",
          match: "status:200",
          intervalSeconds: 60,
          prompt: "CI finished — resume",
          expiresInSeconds: 3600,
        },
      },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0].text).toMatch(/watch-1/);
    expect(h.createdWatches).toHaveLength(1);
    // Self-scope: armed for the token-resolved caller, not a caller-supplied thread.
    expect(h.createdWatches[0]!.record.channelRef).toBe("thread-caller");
    expect(h.createdWatches[0]!.req.kind).toBe("http");
  });

  it("watch_create surfaces a guard rejection (e.g. command disabled) as an isError result (#60)", async () => {
    h = await makeHarness({
      createWatch: () => ({ ok: false as const, error: "command watches are disabled on this deployment" }),
    });
    const { body } = await h.call(
      "tools/call",
      {
        name: "watch_create",
        arguments: { kind: "command", spec: "rm -rf /", intervalSeconds: 10, prompt: "x", expiresInSeconds: 60 },
      },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/disabled/);
  });

  it("watch_create requires kind/spec/prompt/interval/expiry (missing → tool error)", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "watch_create", arguments: { kind: "file" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(h.createdWatches).toHaveLength(0);
  });

  it("watch_cancel routes to the caller's cancelWatch dep (#60)", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "watch_cancel", arguments: { watchId: "watch-xyz" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    expect(h.cancelledWatches).toEqual(["watch-xyz"]);
  });

  it("watch_cancel reports when nothing was removed (#60)", async () => {
    h = await makeHarness({ cancelWatch: () => false });
    const { body } = await h.call(
      "tools/call",
      { name: "watch_cancel", arguments: { watchId: "gone" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/No pending watch/);
  });

  it("watch_list renders the caller's pending watches (#60)", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "watch_list", arguments: {} },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0].text).toMatch(/watch-1/);
    expect(body.result.content[0].text).toMatch(/https:\/\/ci\/status/);
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

  // --- threads: discover addressable teammate threads (#73) ----------------

  it("threads lists the caller's channel siblings — self flagged, busy + status surfaced (#73)", async () => {
    let sawRecord: SessionRecord | undefined;
    h = await makeHarness({
      listThreads: async (record) => {
        sawRecord = record;
        return [
          {
            id: "111111111111111111",
            name: "✨ HIST 2300",
            isSelf: false,
            agent: "claude",
            model: "opus",
            cwd: "/repo/a",
            busy: true,
            status: "active",
            lastActivityUtc: "2026-08-17T10:00:00.000Z",
          },
          {
            id: "thread-caller",
            name: "🤝 me",
            isSelf: true,
            agent: "claude",
            model: "sonnet",
            cwd: "/repo/b",
            busy: false,
            status: "active",
            lastActivityUtc: "2026-08-17T09:00:00.000Z",
          },
          {
            id: "222222222222222222",
            name: "🗄️ archived one",
            isSelf: false,
            agent: "claude",
            model: "haiku",
            cwd: "/repo/c",
            busy: false,
            status: "archived",
            lastActivityUtc: "2026-08-10T00:00:00.000Z",
          },
        ];
      },
    });
    const { body } = await h.call(
      "tools/call",
      { name: "threads", arguments: {} },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    // Self-scope: the dep is handed the token-resolved caller, not an argument.
    expect(sawRecord?.id).toBe("discord:thread-caller");
    const text = body.result.content[0].text;
    // The busy teammate is addressable by its id and flagged busy (send-vs-steer).
    expect(text).toContain("id 111111111111111111");
    expect(text).toContain("✨ HIST 2300");
    expect(text).toContain("busy");
    // The caller's own thread is marked YOU so it doesn't hand off to itself.
    expect(text).toContain("YOU");
    // Archived-but-bound thread still appears, marked (not silently dropped).
    expect(text).toContain("222222222222222222");
    expect(text).toContain("archived");
  });

  it("threads lists agentId@location with host emoji (#84 remainder)", async () => {
    h = await makeHarness({
      listThreads: async () => [
        {
          id: "111111111111111111",
          name: "mac worker",
          isSelf: false,
          agent: "claude",
          model: "opus",
          cwd: "/Users/me/proj",
          busy: false,
          status: "active",
          lastActivityUtc: "2026-08-17T10:00:00.000Z",
          location: "mac",
          hostEmoji: "💻",
        },
      ],
    });
    const { body } = await h.call(
      "tools/call",
      { name: "threads", arguments: {} },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    const text = body.result.content[0].text as string;
    expect(text).toContain("claude@mac");
    expect(text).toContain("💻");
  });

  it("threads refuses a scope that names another channel (self-scope, #73)", async () => {
    h = await makeHarness({ listThreads: async () => [] });
    const { body } = await h.call(
      "tools/call",
      { name: "threads", arguments: { scope: "some-other-channel" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Refused");
  });

  it("threads returns a plain note when the caller is not a thread under a channel (#73)", async () => {
    // Default resolveSession record has parentRef: null unless overridden; here
    // the caller has no parent, so there are no siblings to discover.
    h = await makeHarness({
      resolveSession: (token) =>
        token === "good-token" ? makeRecord({ parentRef: null }) : undefined,
      listThreads: async () => {
        throw new Error("listThreads must not be called without a parent channel");
      },
    });
    const { body } = await h.call(
      "tools/call",
      { name: "threads", arguments: {} },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0].text).toContain("no sibling threads");
  });

  it("threads reports not-supported when the dep is absent (#73)", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "threads", arguments: {} },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("not supported");
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

  // --- agent inbox: send + poll_inbox (#61) --------------------------------

  it("send leaves a message the target drains via poll_inbox exactly once (#61)", async () => {
    h = await makeHarness();
    // Caller sends to its own thread id ("thread-caller"), then polls its inbox.
    const send = await h.call(
      "tools/call",
      { name: "send", arguments: { to: "thread-caller", message: "ping from a teammate" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(send.body.error).toBeUndefined();
    expect(send.body.result.isError).toBeFalsy();

    const poll1 = await h.call(
      "tools/call",
      { name: "poll_inbox", arguments: {} },
      { "X-Seam-Session": "good-token" }
    );
    expect(poll1.body.result.isError).toBeFalsy();
    expect(poll1.body.result.content[0].text).toContain("ping from a teammate");
    expect(poll1.body.result.content[0].text).toContain("thread-caller"); // attribution

    // Deliver-once: a second poll finds nothing.
    const poll2 = await h.call(
      "tools/call",
      { name: "poll_inbox", arguments: {} },
      { "X-Seam-Session": "good-token" }
    );
    expect(poll2.body.result.content[0].text).toBe("No new messages.");
  });

  it("send is PULL-ONLY: it does NOT enqueue a dispatch or start a turn (#61)", async () => {
    h = await makeHarness();
    await h.call(
      "tools/call",
      { name: "send", arguments: { to: "some-other-thread", message: "note for later" } },
      { "X-Seam-Session": "good-token" }
    );
    // The whole point: no dispatch is enqueued (contrast forward/handoff).
    expect(h.enqueued).toHaveLength(0);
    // The message is sitting in the target's inbox, waiting to be polled.
    expect(h.inbox.get("discord:some-other-thread")).toHaveLength(1);
  });

  it("poll_inbox is self-scoped: it only returns the CALLER's own messages (#61)", async () => {
    const owner = makeRecord({ id: "discord:owner", channelRef: "owner" });
    const other = makeRecord({ id: "discord:other", channelRef: "other" });
    h = await makeHarness({
      resolveSession: (t) =>
        t === "owner-token" ? owner : t === "other-token" ? other : undefined,
    });

    // `other` leaves a message for `owner`.
    await h.call(
      "tools/call",
      { name: "send", arguments: { to: "owner", message: "for the owner only" } },
      { "X-Seam-Session": "other-token" }
    );

    // The sender's OWN inbox is empty — it can't see what it addressed elsewhere.
    const otherPoll = await h.call(
      "tools/call",
      { name: "poll_inbox", arguments: {} },
      { "X-Seam-Session": "other-token" }
    );
    expect(otherPoll.body.result.content[0].text).toBe("No new messages.");

    // The owner drains it.
    const ownerPoll = await h.call(
      "tools/call",
      { name: "poll_inbox", arguments: {} },
      { "X-Seam-Session": "owner-token" }
    );
    expect(ownerPoll.body.result.content[0].text).toContain("for the owner only");
    expect(ownerPoll.body.result.content[0].text).toContain("other"); // from-attribution
  });

  it("poll_inbox frames drained messages as actionable delegator feedback (#62)", async () => {
    h = await makeHarness();
    // A delegator ("boss") pushes mid-task steering into the worker's inbox.
    await h.call(
      "tools/call",
      { name: "send", arguments: { to: "thread-caller", message: "prefer the smaller diff" } },
      { "X-Seam-Session": "good-token" }
    );
    const poll = await h.call(
      "tools/call",
      { name: "poll_inbox", arguments: {} },
      { "X-Seam-Session": "good-token" }
    );
    const text = poll.body.result.content[0].text;
    // Surfaces the delegator's `from` attribution as FEEDBACK...
    expect(text).toContain("[FEEDBACK from thread-caller]:");
    expect(text).toContain("prefer the smaller diff");
    // ...and the standing "you do not need to restart" cooperative cue.
    expect(text).toContain("you do not need to restart");
  });

  it("send(priority:true) frames the drained message as a PRIORITY abandon-plan directive (#66)", async () => {
    h = await makeHarness();
    await h.call(
      "tools/call",
      { name: "send", arguments: { to: "thread-caller", message: "drop the refactor, ship the hotfix", priority: true } },
      { "X-Seam-Session": "good-token" }
    );
    const poll = await h.call(
      "tools/call",
      { name: "poll_inbox", arguments: {} },
      { "X-Seam-Session": "good-token" }
    );
    const text = poll.body.result.content[0].text;
    expect(text).toContain("PRIORITY — abandon your current plan and reorient to this");
    expect(text).toContain("drop the refactor, ship the hotfix");
    // A priority item is NOT framed as ordinary cooperative FEEDBACK.
    expect(text).not.toContain("[FEEDBACK from");
  });

  it("send without priority keeps the ordinary [FEEDBACK …] framing (#66 default)", async () => {
    h = await makeHarness();
    await h.call(
      "tools/call",
      { name: "send", arguments: { to: "thread-caller", message: "a normal note" } },
      { "X-Seam-Session": "good-token" }
    );
    const poll = await h.call(
      "tools/call",
      { name: "poll_inbox", arguments: {} },
      { "X-Seam-Session": "good-token" }
    );
    const text = poll.body.result.content[0].text;
    expect(text).toContain("[FEEDBACK from thread-caller]: a normal note");
    expect(text).not.toContain("PRIORITY");
  });

  it("poll_inbox surfaces PRIORITY items FIRST when a drain mixes priority and normal (#66)", async () => {
    h = await makeHarness();
    // Queue a normal note BEFORE the priority one to prove ordering is by
    // priority, not insertion order.
    await h.call(
      "tools/call",
      { name: "send", arguments: { to: "thread-caller", message: "normal-first-note" } },
      { "X-Seam-Session": "good-token" }
    );
    await h.call(
      "tools/call",
      { name: "send", arguments: { to: "thread-caller", message: "urgent-reorient", priority: true } },
      { "X-Seam-Session": "good-token" }
    );
    const poll = await h.call(
      "tools/call",
      { name: "poll_inbox", arguments: {} },
      { "X-Seam-Session": "good-token" }
    );
    const text = poll.body.result.content[0].text;
    // Both present, priority framed distinctly...
    expect(text).toContain("urgent-reorient");
    expect(text).toContain("[FEEDBACK from thread-caller]: normal-first-note");
    // ...and the priority block precedes the normal one despite arriving later.
    expect(text.indexOf("urgent-reorient")).toBeLessThan(text.indexOf("normal-first-note"));
  });

  // --- send(interrupt) — preemptive cancel-and-redirect (#67) --------------

  it("send advertises interrupt + fresh in its input schema without changing the tool count (#67)", async () => {
    h = await makeHarness();
    const { body } = await h.call("tools/list");
    // Params on `send` must NOT add a tool — the set stays at 18 (#61/#62/#66/#73/#91).
    expect(body.result.tools).toHaveLength(19);
    const byName = new Map(body.result.tools.map((t: any) => [t.name, t]));
    expect(byName.get("send").inputSchema.properties.interrupt.type).toBe("boolean");
    expect(byName.get("send").inputSchema.properties.fresh.type).toBe("boolean");
  });

  it("send(interrupt:true) routes to interruptRedirect — cancels + redirects, does NOT queue to the inbox (#67)", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "send", arguments: { to: "thread-caller", message: "pivot to the hotfix", interrupt: true } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBeFalsy();
    // The interrupt dep was invoked (keep-context by default: fresh=false)...
    expect(h.interrupts).toHaveLength(1);
    expect(h.interrupts[0]!.to).toBe("thread-caller");
    expect(h.interrupts[0]!.message).toBe("pivot to the hotfix");
    expect(h.interrupts[0]!.fresh).toBe(false);
    // ...and NOTHING was queued to the inbox (this is not a pull-only send).
    expect(h.inbox.size).toBe(0);
    // The result confirms cancel + redirect + no report-back for the old handoff.
    const text = body.result.content[0].text as string;
    expect(text).toContain("Interrupted thread thread-caller");
    expect(text).toContain("session KEPT");
    expect(text).toContain("NO result");
  });

  it("send(interrupt:true, fresh:true) threads fresh through and reports a session reset (#67)", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "send", arguments: { to: "thread-caller", message: "start over", interrupt: true, fresh: true } },
      { "X-Seam-Session": "good-token" }
    );
    expect(h.interrupts[0]!.fresh).toBe(true);
    expect(body.result.content[0].text).toContain("session RESET");
  });

  it("send interrupt:true SUPERSEDES priority:true — interrupt path taken, inbox untouched (#67)", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      {
        name: "send",
        arguments: { to: "thread-caller", message: "urgent redirect", interrupt: true, priority: true },
      },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    // Interrupt path: the redirect ran and NOTHING was queued as a priority note.
    expect(h.interrupts).toHaveLength(1);
    expect(h.inbox.size).toBe(0);
  });

  it("send(interrupt:true) with no active turn degrades to immediate delivery (never lost) (#67)", async () => {
    h = await makeHarness({
      interruptRedirect: async (_caller, _to, _message, fresh) => ({
        ok: true as const,
        cancelled: "idle" as const,
        fresh,
        dispatchId: "disp-int-2",
      }),
    });
    const { body } = await h.call(
      "tools/call",
      { name: "send", arguments: { to: "thread-caller", message: "do this next", interrupt: true } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    const text = body.result.content[0].text as string;
    expect(text).toContain("no active turn");
    expect(text).toContain("delivered immediately");
  });

  it("send(interrupt:true) reports unsupported when the interruptRedirect dep is absent (#67)", async () => {
    h = await makeHarness({ disableInterrupt: true });
    const { body } = await h.call(
      "tools/call",
      { name: "send", arguments: { to: "thread-caller", message: "x", interrupt: true } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("not supported");
    // A refusal must not leak into the inbox path.
    expect(h.inbox.size).toBe(0);
  });

  it("send(interrupt:false) is unchanged — still a pull-only inbox queue (#67 default)", async () => {
    h = await makeHarness();
    await h.call(
      "tools/call",
      { name: "send", arguments: { to: "some-other-thread", message: "a normal note", interrupt: false } },
      { "X-Seam-Session": "good-token" }
    );
    // No interrupt fired; the message sits in the target's inbox as before.
    expect(h.interrupts).toHaveLength(0);
    expect(h.inbox.get("discord:some-other-thread")).toHaveLength(1);
  });

  it("send rejects an unknown token with -32001 BEFORE interrupting (#67)", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "send", arguments: { to: "thread-caller", message: "hi", interrupt: true } },
      { "X-Seam-Session": "bad-token" }
    );
    expect(body.error.code).toBe(-32001);
    expect(h.interrupts).toHaveLength(0);
  });

  it("poll_inbox rejects an unknown token with -32001 (#61)", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "poll_inbox", arguments: {} },
      { "X-Seam-Session": "bad-token" }
    );
    expect(body.error.code).toBe(-32001);
  });

  it("send rejects an unknown token with -32001 before pushing (#61)", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "send", arguments: { to: "thread-caller", message: "hi" } },
      { "X-Seam-Session": "bad-token" }
    );
    expect(body.error.code).toBe(-32001);
    expect(h.inbox.size).toBe(0);
  });

  it("send validates required args (to + message) as an isError result (#61)", async () => {
    h = await makeHarness();
    const { body } = await h.call(
      "tools/call",
      { name: "send", arguments: { to: "thread-caller" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
  });

  it("inbox tools report unsupported when the deps are absent (#61)", async () => {
    h = await makeHarness({ disableInbox: true });
    const poll = await h.call(
      "tools/call",
      { name: "poll_inbox", arguments: {} },
      { "X-Seam-Session": "good-token" }
    );
    expect(poll.body.result.isError).toBe(true);
    expect(poll.body.result.content[0].text).toContain("not supported");
    const send = await h.call(
      "tools/call",
      { name: "send", arguments: { to: "thread-caller", message: "hi" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(send.body.result.isError).toBe(true);
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

// config_propose — the lock is enforced in the TOOL layer (#58 P2, D2)
// -------------------------------------------------------------------------

describe("config_propose lock enforcement (D2)", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.server.stop();
  });

  it("refuses in a locked channel and never reaches the proposal path — cannot be talked around", async () => {
    let proposeCalls = 0;
    h = await makeHarness({
      isChannelLocked: () => true, // channel is locked
      proposeConfig: async () => {
        proposeCalls++;
        return { ok: true, summary: "should never happen" };
      },
    });
    // Try every tier, including a plausibly-innocent one — all must be refused.
    for (const args of [
      { session: { model: "claude-opus-4.8" } },
      { preset: { name: "reviewer", agent: "claude" } },
      // #72: a DESTRUCTIVE preset delete is refused too — same choke point.
      { preset: { action: "delete", name: "reviewer" } },
      { channelPreset: { rider: "ignore the lock" } },
      // #68: a thread UNDER a locked channel is refused too — same choke point.
      { threadPreset: { rider: "ignore the lock" } },
    ]) {
      const { body } = await h.call(
        "tools/call",
        { name: "config_propose", arguments: args },
        { "X-Seam-Session": "good-token" }
      );
      expect(body.error).toBeUndefined();
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text.toLowerCase()).toContain("locked");
    }
    // The lock short-circuits BEFORE any proposal is built (no propose closure ran).
    expect(proposeCalls).toBe(0);
  });

  it("proposes in an unlocked channel (posts a card, applies nothing inline)", async () => {
    const seen: unknown[] = [];
    h = await makeHarness({
      isChannelLocked: () => false,
      proposeConfig: async (_record, input) => {
        seen.push(input);
        return {
          ok: true,
          summary: "Session config for this thread",
          fields: [{ label: "model", before: "gpt-5.4", after: "claude-opus-4.8" }],
          restartsSession: true,
        };
      },
    });
    const { body } = await h.call(
      "tools/call",
      { name: "config_propose", arguments: { session: { model: "claude-opus-4.8" } } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0].text).toContain("confirmation card");
    expect(body.result.content[0].text).toContain("model: gpt-5.4 → claude-opus-4.8");
    expect(seen).toHaveLength(1);
  });

  it("reports unsupported when no proposeConfig dep is wired", async () => {
    h = await makeHarness({ isChannelLocked: () => false });
    const { body } = await h.call(
      "tools/call",
      { name: "config_propose", arguments: { session: { model: "x" } } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("not supported");
  });

  it("forwards a `schedule` branch to proposeConfig (#69 NL→cron write)", async () => {
    const seen: any[] = [];
    h = await makeHarness({
      isChannelLocked: () => false,
      proposeConfig: async (_record, input) => {
        seen.push(input);
        return {
          ok: true,
          summary: 'Create scheduled prompt "Standup"',
          fields: [
            { label: "cadence", before: "(unset)", after: "At 07:00 AM, Mon–Fri [0 7 * * 1-5]" },
            { label: "next run", before: "(none)", after: "2026-08-17T12:00:00.000Z" },
          ],
          restartsSession: false,
        };
      },
    });
    const { body } = await h.call(
      "tools/call",
      {
        name: "config_propose",
        arguments: {
          schedule: { action: "create", name: "Standup", promptText: "Post the standup", cron: "0 7 * * 1-5" },
        },
      },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    // The schedule payload reached the service unchanged.
    expect(seen).toHaveLength(1);
    expect(seen[0].schedule).toMatchObject({ action: "create", cron: "0 7 * * 1-5" });
    // The card echoes the parsed cadence AND the resolved next run.
    expect(body.result.content[0].text).toContain("cadence");
    expect(body.result.content[0].text).toContain("next run");
  });
});

// -------------------------------------------------------------------------
// config_propose lock immunity for config admins (#71). The lock still refuses
// everyone by default; an admin (SEAM_CONFIG_ADMIN_USER_IDS) may propose in a
// locked channel, but ONLY when the CURRENT turn's harness-stamped speaker id
// is in the set. Keyed to the same set as the Apply gate.
// -------------------------------------------------------------------------

describe("config_propose lock immunity for config admins (#71)", () => {
  let h: Harness;
  afterEach(async () => {
    await h?.server.stop();
  });

  it("lets a config admin propose in a locked channel when the speaker id matches", async () => {
    let proposeCalls = 0;
    h = await makeHarness({
      isChannelLocked: () => true,
      configAdminUserIds: new Set(["1487094572696867019"]),
      currentSpeakerId: () => "1487094572696867019", // admin is the current speaker
      proposeConfig: async () => {
        proposeCalls++;
        return {
          ok: true,
          summary: "Session config for this thread",
          fields: [{ label: "model", before: "gpt-5.4", after: "claude-opus-4.8" }],
          restartsSession: true,
        };
      },
    });
    const { body } = await h.call(
      "tools/call",
      { name: "config_propose", arguments: { session: { model: "claude-opus-4.8" } } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0].text).toContain("confirmation card");
    expect(proposeCalls).toBe(1);
  });

  it("still refuses a NON-admin speaker in a locked channel (student cannot generate a card)", async () => {
    let proposeCalls = 0;
    h = await makeHarness({
      isChannelLocked: () => true,
      configAdminUserIds: new Set(["1487094572696867019"]),
      currentSpeakerId: () => "9999999999", // a student, not in the admin set
      proposeConfig: async () => {
        proposeCalls++;
        return { ok: true, summary: "should never happen" };
      },
    });
    const { body } = await h.call(
      "tools/call",
      { name: "config_propose", arguments: { session: { model: "claude-opus-4.8" } } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text.toLowerCase()).toContain("locked");
    expect(proposeCalls).toBe(0);
  });

  it("refuses a NON-admin's DESTRUCTIVE preset delete in a locked channel (#72)", async () => {
    let proposeCalls = 0;
    h = await makeHarness({
      isChannelLocked: () => true,
      configAdminUserIds: new Set(["1487094572696867019"]),
      currentSpeakerId: () => "9999999999", // a student, not in the admin set
      proposeConfig: async () => {
        proposeCalls++;
        return { ok: true, summary: "should never happen" };
      },
    });
    const { body } = await h.call(
      "tools/call",
      { name: "config_propose", arguments: { preset: { action: "delete", name: "reviewer" } } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text.toLowerCase()).toContain("locked");
    // The delete never reached the proposal path — the lock short-circuits first.
    expect(proposeCalls).toBe(0);
  });

  it("refuses even an admin when speaker identity is off (no trustworthy id ⇒ never fail open)", async () => {
    let proposeCalls = 0;
    h = await makeHarness({
      isChannelLocked: () => true,
      configAdminUserIds: new Set(["1487094572696867019"]),
      currentSpeakerId: () => undefined, // SPEAKER_IDENTITY_ENABLED=false → no id
      proposeConfig: async () => {
        proposeCalls++;
        return { ok: true, summary: "should never happen" };
      },
    });
    const { body } = await h.call(
      "tools/call",
      { name: "config_propose", arguments: { session: { model: "claude-opus-4.8" } } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text.toLowerCase()).toContain("locked");
    expect(proposeCalls).toBe(0);
  });

  it("with no admin set configured, a locked channel refuses everyone — byte-identical to today", async () => {
    let proposeCalls = 0;
    h = await makeHarness({
      isChannelLocked: () => true,
      // configAdminUserIds omitted (unset) ; even a stamped speaker is refused.
      currentSpeakerId: () => "1487094572696867019",
      proposeConfig: async () => {
        proposeCalls++;
        return { ok: true, summary: "should never happen" };
      },
    });
    const { body } = await h.call(
      "tools/call",
      { name: "config_propose", arguments: { session: { model: "claude-opus-4.8" } } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text.toLowerCase()).toContain("locked");
    expect(proposeCalls).toBe(0);
  });

  it("does not gate an UNLOCKED channel on the admin set (propose proceeds regardless of speaker)", async () => {
    let proposeCalls = 0;
    h = await makeHarness({
      isChannelLocked: () => false,
      configAdminUserIds: new Set(["1487094572696867019"]),
      currentSpeakerId: () => "9999999999", // non-admin, but channel is unlocked
      proposeConfig: async () => {
        proposeCalls++;
        return {
          ok: true,
          summary: "Session config for this thread",
          fields: [{ label: "model", before: "gpt-5.4", after: "claude-opus-4.8" }],
        };
      },
    });
    const { body } = await h.call(
      "tools/call",
      { name: "config_propose", arguments: { session: { model: "claude-opus-4.8" } } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    expect(proposeCalls).toBe(1);
  });
});

// -------------------------------------------------------------------------
// config_propose participant refusal (#74). A restricted participant cannot
// cause a proposal card to be built, locked OR unlocked. Admin wins overlap.
// Unset participant set ⇒ today's behavior (the #71 unlocked-channel test
// above still covers "non-admin speaker may propose when unlocked").
// -------------------------------------------------------------------------

describe("config_propose participant refusal (#74)", () => {
  const ADMIN = "1487094572696867019";
  const STUDENT = "1534937951044112505";
  let h: Harness;
  afterEach(async () => {
    await h?.server.stop();
  });

  it("refuses a participant in an UNLOCKED channel (no card is built)", async () => {
    let proposeCalls = 0;
    h = await makeHarness({
      isChannelLocked: () => false,
      configAdminUserIds: new Set([ADMIN]),
      configParticipantUserIds: new Set([STUDENT]),
      currentSpeakerId: () => STUDENT,
      proposeConfig: async () => {
        proposeCalls++;
        return { ok: true, summary: "should never happen" };
      },
    });
    const { body } = await h.call(
      "tools/call",
      { name: "config_propose", arguments: { session: { model: "claude-opus-4.8" } } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("That's an admin setting");
    expect(proposeCalls).toBe(0);
  });

  it("refuses a participant in a LOCKED channel (no card is built)", async () => {
    let proposeCalls = 0;
    h = await makeHarness({
      isChannelLocked: () => true,
      configAdminUserIds: new Set([ADMIN]),
      configParticipantUserIds: new Set([STUDENT]),
      currentSpeakerId: () => STUDENT,
      proposeConfig: async () => {
        proposeCalls++;
        return { ok: true, summary: "should never happen" };
      },
    });
    const { body } = await h.call(
      "tools/call",
      { name: "config_propose", arguments: { session: { model: "claude-opus-4.8" } } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("That's an admin setting");
    expect(proposeCalls).toBe(0);
  });

  it("an id in BOTH admin+participant sets may propose (admin wins)", async () => {
    let proposeCalls = 0;
    h = await makeHarness({
      isChannelLocked: () => true,
      configAdminUserIds: new Set([ADMIN]),
      configParticipantUserIds: new Set([ADMIN, STUDENT]),
      currentSpeakerId: () => ADMIN,
      proposeConfig: async () => {
        proposeCalls++;
        return {
          ok: true,
          summary: "Session config for this thread",
          fields: [{ label: "model", before: "gpt-5.4", after: "claude-opus-4.8" }],
        };
      },
    });
    const { body } = await h.call(
      "tools/call",
      { name: "config_propose", arguments: { session: { model: "claude-opus-4.8" } } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    expect(proposeCalls).toBe(1);
  });

  it("with the participant set unset, an unlocked non-admin may still propose (byte-identical to today)", async () => {
    let proposeCalls = 0;
    h = await makeHarness({
      isChannelLocked: () => false,
      configAdminUserIds: new Set([ADMIN]),
      // configParticipantUserIds omitted
      currentSpeakerId: () => STUDENT,
      proposeConfig: async () => {
        proposeCalls++;
        return {
          ok: true,
          summary: "Session config for this thread",
          fields: [{ label: "model", before: "gpt-5.4", after: "claude-opus-4.8" }],
        };
      },
    });
    const { body } = await h.call(
      "tools/call",
      { name: "config_propose", arguments: { session: { model: "claude-opus-4.8" } } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    expect(proposeCalls).toBe(1);
  });

  it("does not refuse when speaker identity is off (no trustworthy id to key on)", async () => {
    let proposeCalls = 0;
    h = await makeHarness({
      isChannelLocked: () => false,
      configParticipantUserIds: new Set([STUDENT]),
      currentSpeakerId: () => undefined,
      proposeConfig: async () => {
        proposeCalls++;
        return {
          ok: true,
          summary: "Session config for this thread",
          fields: [{ label: "model", before: "gpt-5.4", after: "claude-opus-4.8" }],
        };
      },
    });
    const { body } = await h.call(
      "tools/call",
      { name: "config_propose", arguments: { session: { model: "claude-opus-4.8" } } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.result.isError).toBeFalsy();
    expect(proposeCalls).toBe(1);
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
    detached: { value: true, source: "thread preset" as const },
    location: { value: "local", source: "default" as const },
  };

  async function makeDescribeServer(): Promise<SeamMcpServer> {
    const server = new SeamMcpServer({
      logger: silent,
      resolveSession: (token) => (token === "good-token" ? makeRecord({ parentRef: "chan-1" }) : undefined),
      enqueueDispatch: async () => {},
      describeConfig: () => description,
      listConfigEntities: () => ({
        schedules: [
          {
            id: "sch_morning1",
            name: "morning",
            promptText: "Summarize overnight PRs and post the standup",
            cron: "0 7 * * 1-5",
            timezone: "America/Chicago",
            enabled: true,
            sessionMode: "isolated",
            model: "claude-opus-4.6",
            cwd: null,
            targetChannel: null,
            outputType: "card",
            catchupSeconds: 7200,
            attachments: ["spec.md"],
            lastStatus: "ok",
            lastRunUtc: "2026-08-16T12:00:00Z",
            nextRunUtc: "2026-08-17T12:00:00Z",
          },
        ],
        presets: [
          {
            name: "ts-reviewer",
            scope: "project",
            agentId: "claude",
            model: "claude-opus-4.6",
            effort: "high",
            permission: "ask",
            cwd: "/repo/x",
            description: "Reviews TypeScript PRs",
          },
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
      expect(text).toContain("detached:");
      expect(text).toContain("true");
      expect(text).toMatch(/detached:.*true.*thread preset/s);
      // Entity listing folds in — now the FULL definition (#69): the id (needed
      // to target an edit), the promptText (the actual content), attachments,
      // and last-run status all render, not just name/cron/tz.
      expect(text).toContain("morning");
      expect(text).toContain("sch_morning1");
      expect(text).toContain("Summarize overnight PRs and post the standup");
      expect(text).toContain("spec.md");
      expect(text).toContain("ts-reviewer");
      expect(text).toContain("Reviews TypeScript PRs");
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
