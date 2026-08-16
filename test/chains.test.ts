import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { pino } from "pino";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "../src/core/session-store.js";
import { PROMPT_PREVIEW_MAX, type ChainCreateInput, type SessionRecord } from "../src/core/types.js";
import {
  SeamMcpServer,
  type PeekedMessage,
} from "../src/core/mcp/seam-mcp-server.js";
import type { Logger } from "../src/lib/logger.js";
import type { DispatchSpec } from "../src/core/dispatch/types.js";

let dir: string;
let store: SessionStore;

const sample = (over: Partial<ChainCreateInput> = {}): ChainCreateInput => ({
  id: "chain-1",
  hops: ["t1", "reviewer", "999999999999999999"],
  originRef: "origin-thread",
  promptPreview: "draft, review, ship",
  ...over,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-chains-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// -------------------------------------------------------------------------
// Store CRUD
// -------------------------------------------------------------------------

describe("chains store", () => {
  it("creates and reads back a chain with stamped defaults", () => {
    const w = store.createChain(sample());
    expect(w.status).toBe("running");
    expect(w.currentIndex).toBe(0);
    expect(w.createdUtc).toBe(w.updatedUtc);
    const read = store.getChain("chain-1");
    expect(read).toEqual(w);
    expect(read?.hops).toEqual(["t1", "reviewer", "999999999999999999"]);
    expect(read?.originRef).toBe("origin-thread");
  });

  it("truncates promptPreview on write", () => {
    const long = "x".repeat(PROMPT_PREVIEW_MAX + 50);
    const w = store.createChain(sample({ promptPreview: long }));
    expect(w.promptPreview).toHaveLength(PROMPT_PREVIEW_MAX);
    expect(store.getChain("chain-1")?.promptPreview).toHaveLength(PROMPT_PREVIEW_MAX);
  });

  it("getChain returns null when absent", () => {
    expect(store.getChain("missing")).toBeNull();
  });

  it("advances a 3-hop chain popping one worker at a time, then drains", () => {
    store.createChain(sample({ hops: ["a", "b", "c"] }));

    const a = store.advanceChain("chain-1");
    expect(a?.nextHop).toBe("a");
    expect(a?.chain.hops).toEqual(["b", "c"]);
    expect(a?.chain.currentIndex).toBe(1);

    const b = store.advanceChain("chain-1");
    expect(b?.nextHop).toBe("b");
    expect(b?.chain.hops).toEqual(["c"]);
    expect(b?.chain.currentIndex).toBe(2);

    const c = store.advanceChain("chain-1");
    expect(c?.nextHop).toBe("c");
    expect(c?.chain.hops).toEqual([]);
    expect(c?.chain.currentIndex).toBe(3);

    // Drained — nextHop is null and the index does not move further.
    const drained = store.advanceChain("chain-1");
    expect(drained?.nextHop).toBeNull();
    expect(drained?.chain.currentIndex).toBe(3);
  });

  it("advanceChain on an unknown id is a no-op returning null", () => {
    expect(store.advanceChain("nope")).toBeNull();
  });

  it("completeChain marks terminal and drops the chain from listActiveChains", () => {
    store.createChain(sample());
    expect(store.listActiveChains().map((c) => c.id)).toEqual(["chain-1"]);
    store.completeChain("chain-1");
    expect(store.getChain("chain-1")?.status).toBe("completed");
    expect(store.listActiveChains()).toHaveLength(0);
  });

  it("completeChain can mark failed", () => {
    store.createChain(sample());
    store.completeChain("chain-1", "failed");
    expect(store.getChain("chain-1")?.status).toBe("failed");
  });

  it("advanceChain refuses to advance a non-running chain", () => {
    store.createChain(sample());
    store.completeChain("chain-1");
    expect(store.advanceChain("chain-1")).toBeNull();
  });

  it("listActiveChains returns running chains oldest first", () => {
    store.createChain(sample({ id: "young", createdUtc: "2026-06-01T00:00:00.000Z" }));
    store.createChain(sample({ id: "old", createdUtc: "2026-01-01T00:00:00.000Z" }));
    store.createChain(sample({ id: "done", createdUtc: "2026-03-01T00:00:00.000Z" }));
    store.completeChain("done");
    expect(store.listActiveChains().map((c) => c.id)).toEqual(["old", "young"]);
  });

  it("persists a chain row across a store reopen (durability)", () => {
    const dbPath = path.join(dir, "reopen.db");
    const s1 = new SessionStore(dbPath);
    s1.createChain(sample({ hops: ["a", "b", "c"] }));
    // Simulate a hop having been dispatched (popped) before the crash.
    s1.advanceChain("chain-1");
    s1.close();

    const s2 = new SessionStore(dbPath);
    const resumed = s2.getChain("chain-1");
    expect(resumed?.status).toBe("running");
    expect(resumed?.hops).toEqual(["b", "c"]);
    expect(resumed?.currentIndex).toBe(1);
    // Resume continues advancing from the persisted state, not from scratch.
    expect(s2.advanceChain("chain-1")?.nextHop).toBe("b");
    s2.close();
  });
});

// -------------------------------------------------------------------------
// End-to-end advance semantics: a 3-hop chain delivering to origin
// -------------------------------------------------------------------------

describe("chain advance drives hop→hop→origin", () => {
  it("pops each hop in order and reports drained at the end", () => {
    // Mirrors the runtime loop: the `chain` tool pops hop 1; each hop's
    // completion pops the next; when drained the final output goes to origin.
    store.createChain(sample({ id: "c", hops: ["w1", "w2", "w3"], originRef: "origin" }));

    const dispatched: string[] = [];
    // Hop 1 (as the chain tool would do it).
    let step = store.advanceChain("c")!;
    expect(step.nextHop).toBe("w1");
    dispatched.push(step.nextHop!);

    // Each subsequent completion advances until drained.
    let guard = 0;
    while (guard++ < 10) {
      step = store.advanceChain("c")!;
      if (step.nextHop === null) break;
      dispatched.push(step.nextHop);
    }
    expect(dispatched).toEqual(["w1", "w2", "w3"]);
    store.completeChain("c");
    expect(store.getChain("c")?.status).toBe("completed");
  });
});

// -------------------------------------------------------------------------
// The chain MCP tool
// -------------------------------------------------------------------------

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

describe("chain MCP tool", () => {
  let server: SeamMcpServer;
  let enqueued: DispatchSpec[];
  let created: Array<{ hops: string[]; originRef: string; promptPreview?: string | null }>;
  let port: number;

  const call = async (method: string, params?: unknown, headers?: Record<string, string>) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  };

  beforeEach(async () => {
    enqueued = [];
    created = [];
    server = new SeamMcpServer({
      logger: silent,
      resolveSession: (token) => (token === "good-token" ? makeRecord() : undefined),
      enqueueDispatch: async (spec) => {
        enqueued.push(spec);
      },
      createChain: (input) => {
        created.push(input);
        // Real wiring: create + pop hop 1.
        store.createChain({
          id: "chain-fixed",
          hops: input.hops,
          originRef: input.originRef,
          promptPreview: input.promptPreview ?? null,
        });
        const advanced = store.advanceChain("chain-fixed");
        return { chainId: "chain-fixed", firstHop: advanced!.nextHop! };
      },
      peekThread: async (): Promise<PeekedMessage[]> => [],
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it("tools/list advertises the chain tool with an array schema", async () => {
    const body = await call("tools/list");
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
    const chain = body.result.tools.find((t: { name: string }) => t.name === "chain");
    expect(chain.inputSchema.properties.workers.type).toBe("array");
    expect(chain.inputSchema.required).toEqual(["workers", "prompt"]);
  });

  it("chain creates a row (origin=returnTo) and enqueues hop 1 with the chainId", async () => {
    const body = await call(
      "tools/call",
      {
        name: "chain",
        arguments: {
          workers: ["888888888888888888", "reviewer"],
          prompt: "do the thing",
          returnTo: "777777777777777777",
        },
      },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBeFalsy();

    // Chain row created with the caller-supplied origin and full hop list.
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      hops: ["888888888888888888", "reviewer"],
      originRef: "777777777777777777",
    });

    // Hop 1 enqueued, carrying the chainId and the initial prompt.
    expect(enqueued).toHaveLength(1);
    const spec = enqueued[0]!;
    expect(spec.chainId).toBe("chain-fixed");
    expect(spec.kind).toBe("forward");
    expect(spec.prompt).toBe("do the thing");
    // A snowflake hop runs live in that thread.
    expect(spec.target).toBe("888888888888888888");
    expect(spec.session).toBe("live");
    // A chain hop drives advancement itself — no report-back returnTo.
    expect(spec.returnTo).toBeUndefined();

    // Store reflects hop 1 popped (durable state).
    const row = store.getChain("chain-fixed");
    expect(row?.hops).toEqual(["reviewer"]);
    expect(row?.currentIndex).toBe(1);
  });

  it("origin defaults to the caller thread when returnTo is omitted", async () => {
    await call(
      "tools/call",
      { name: "chain", arguments: { workers: ["a", "b"], prompt: "p" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(created[0]!.originRef).toBe("thread-caller");
    // A preset-name hop 1 runs isolated, posted into the origin thread.
    const spec = enqueued[0]!;
    expect(spec.preset).toBe("a");
    expect(spec.session).toBe("isolated");
    expect(spec.target).toBe("thread-caller");
  });

  it("rejects an empty workers list as an isError tool result", async () => {
    const body = await call(
      "tools/call",
      { name: "chain", arguments: { workers: [], prompt: "p" } },
      { "X-Seam-Session": "good-token" }
    );
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
    expect(enqueued).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it("an unknown token cannot start a chain", async () => {
    const body = await call(
      "tools/call",
      { name: "chain", arguments: { workers: ["a"], prompt: "p" } },
      { "X-Seam-Session": "bogus" }
    );
    expect(body.error.code).toBe(-32001);
    expect(enqueued).toHaveLength(0);
  });
});
