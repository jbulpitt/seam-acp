import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { hashBridgeToken, mintBridgeToken } from "../packages/core/src/core/bridge-pairing.js";
import { ChoiceResultHub } from "../packages/core/src/core/choice/result.js";
import { ChoiceIngest } from "../packages/core/src/core/choice/ingest.js";
import {
  parseIngestEndpointSpec,
  planEndpointDispatch,
  wrapEndpointPrompt,
  isDiscordSnowflake,
  type IngestEndpoint,
} from "../packages/core/src/core/choice/endpoint.js";
import { SeamMcpServer } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dir: string;
let store: SessionStore;

function endpoint(over: Partial<IngestEndpoint> = {}): IngestEndpoint {
  const token = over.tokenHash ? "preset" : mintBridgeToken();
  const hash = over.tokenHash ?? hashBridgeToken(token);
  return {
    id: "ie_test1",
    tokenHash: hash,
    name: "essay-check",
    cwd: "/repo",
    agentId: "claude",
    model: "default",
    effort: null,
    wrapper: "Grade this.",
    resultSchema: {
      type: "object",
      required: ["overallScore", "prose"],
      properties: { overallScore: { type: "number" }, prose: { type: "string" } },
    },
    corsOrigins: null,
    uniqueStudent: false,
    notifyThread: null,
    thread: null,
    preset: null,
    status: "open",
    createdBy: "discord:thread-1",
    createdUtc: "2026-08-22T00:00:00.000Z",
    authoringChannelRef: "thread-1",
    authoringParentRef: "chan-1",
    platform: "discord",
    ...over,
  };
}

function record(): SessionRecord {
  return {
    id: "discord:thread-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "chan-1",
    agentId: "claude",
    acpSessionId: "acp-1",
    repoPath: "/repo",
    configJson: "{}",
    createdUtc: "2026-01-01T00:00:00Z",
    updatedUtc: "2026-01-01T00:00:00Z",
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-ie-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseIngestEndpointSpec", () => {
  it("accepts a named endpoint", () => {
    const r = parseIngestEndpointSpec({ name: "quiz", wrapper: "Score this." });
    expect(r.ok).toBe(true);
  });
  it("requires name", () => {
    const r = parseIngestEndpointSpec({ wrapper: "x" });
    expect(r.ok).toBe(false);
  });
  it("rejects a non-snowflake notifyThread", () => {
    const r = parseIngestEndpointSpec({ name: "q", notifyThread: "not-a-id" });
    expect(r.ok).toBe(false);
  });
  it("accepts preset and refuses combining it with agent/model", () => {
    expect(parseIngestEndpointSpec({ name: "q", preset: "hist-grader" }).ok).toBe(true);
    const r = parseIngestEndpointSpec({ name: "q", preset: "hist-grader", agent: "claude" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/preset cannot be combined with agent/);
  });
  it("accepts a thread snowflake (#224)", () => {
    const r = parseIngestEndpointSpec({ name: "q", thread: "1516907849349857421" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.thread).toBe("1516907849349857421");
  });
  it("refuses a non-snowflake thread", () => {
    expect(parseIngestEndpointSpec({ name: "q", thread: "not-a-id" }).ok).toBe(false);
    expect(parseIngestEndpointSpec({ name: "q", thread: "12345" }).ok).toBe(false);
  });
  it("refuses combining thread with any identity pin or notifyThread", () => {
    const thread = "1516907849349857421";
    for (const [key, value] of [
      ["preset", "hist-grader"],
      ["agent", "claude"],
      ["model", "default"],
      ["effort", "high"],
      ["cwd", "/repo"],
      ["notifyThread", "1516907849349857422"],
    ] as const) {
      const r = parseIngestEndpointSpec({ name: "q", thread, [key]: value });
      expect(r.ok, `thread + ${key} should be refused`).toBe(false);
      if (!r.ok) expect(r.error).toMatch(new RegExp(`thread cannot be combined with ${key}`));
    }
  });
});

describe("wrapEndpointPrompt", () => {
  it("asks for submit_result and stamps untrusted student id", () => {
    const p = wrapEndpointPrompt({
      ingestId: "ie1",
      name: "quiz",
      payload: "essay text",
      wrapper: "Grade this.",
      untrustedStudentId: "stu",
    });
    expect(p).toContain("submit_result");
    expect(p).toContain("untrusted");
    expect(p).toContain("stu");
    expect(p).toContain("Grade this.");
    expect(p).toContain("essay text");
    expect(p).toContain("isolated silent");
  });
  it("drops the isolated-silent / submit_result line for a live thread (#224)", () => {
    const p = wrapEndpointPrompt({
      ingestId: "ie1",
      name: "quiz",
      payload: "a visitor question",
      wrapper: "Answer it.",
      untrustedStudentId: "stu",
      thread: "1516907849349857421",
    });
    expect(p).not.toContain("isolated silent");
    expect(p).not.toContain("submit_result({...})");
    expect(p).toContain("No submit_result is required");
    expect(p).toContain("this thread, live");
    // The untrusted stamp survives — the POST body is still not a Discord user.
    expect(p).toContain("untrusted");
    expect(p).toContain("stu");
    expect(p).toContain("a visitor question");
  });
});

describe("planEndpointDispatch", () => {
  it("is isolated silent with kind ingest and a ledger sentinel target", () => {
    const spec = planEndpointDispatch({
      endpoint: endpoint(),
      payload: "hello",
      untrustedStudentId: "s1",
    });
    expect(spec.kind).toBe("ingest");
    expect(spec.session).toBe("isolated");
    expect(spec.stream).toBe(false);
    expect(spec.target).toBe("ingest:ie_test1");
    expect(spec.cwd).toBe("/repo");
    expect(spec.agentId).toBe("claude");
    expect(spec.prompt).toContain("hello");
    expect(spec.preset).toBeUndefined();
  });
  it("carries preset name for resolve-at-fire", () => {
    const spec = planEndpointDispatch({
      endpoint: endpoint({ preset: "hist-grader", agentId: null, model: null, cwd: null }),
      payload: "x",
    });
    expect(spec.preset).toBe("hist-grader");
    expect(spec.agentId).toBeUndefined();
  });
  it("uses notifyThread as target when it is a snowflake", () => {
    const spec = planEndpointDispatch({
      endpoint: endpoint({ notifyThread: "1516907849349857421" }),
      payload: "x",
    });
    expect(spec.target).toBe("1516907849349857421");
    expect(isDiscordSnowflake(spec.target)).toBe(true);
  });
  it("plans a live handoff with no returnTo for a thread endpoint (#224)", () => {
    const spec = planEndpointDispatch({
      endpoint: endpoint({
        thread: "1516907849349857421",
        agentId: null,
        model: null,
        effort: null,
        cwd: null,
        resultSchema: null,
      }),
      payload: "hello",
      untrustedStudentId: "s1",
      defaultModel: "should-be-ignored",
    });
    expect(spec.kind).toBe("ingest");
    expect(spec.session).toBe("live");
    expect(spec.target).toBe("1516907849349857421");
    expect(spec.stream).toBe(true);
    expect(spec.returnTo).toBeUndefined();
    expect(spec.correlationId).toBe("ie_test1");
    // Live uses the TARGET thread's identity — nothing is pinned on the spec.
    expect(spec.preset).toBeUndefined();
    expect(spec.agentId).toBeUndefined();
    expect(spec.model).toBeUndefined();
    expect(spec.effort).toBeUndefined();
    expect(spec.cwd).toBeUndefined();
    expect(spec.prompt).toContain("hello");
  });
});

describe("ingest endpoint store", () => {
  it("round-trips and looks up by token hash", () => {
    const token = mintBridgeToken();
    const row = endpoint({ tokenHash: hashBridgeToken(token) });
    store.insertIngestEndpoint(row);
    expect(store.getIngestEndpoint(row.id)?.name).toBe("essay-check");
    expect(store.getIngestEndpointByTokenHash(row.tokenHash)?.id).toBe(row.id);
    expect(store.listOpenIngestEndpoints("discord", "thread-1")).toHaveLength(1);
  });
  it("round-trips a preset name", () => {
    store.insertIngestEndpoint(endpoint({ preset: "hist-grader" }));
    expect(store.getIngestEndpoint("ie_test1")?.preset).toBe("hist-grader");
  });
  it("round-trips a live thread destination (#224)", () => {
    store.insertIngestEndpoint(endpoint({ thread: "1516907849349857421" }));
    expect(store.getIngestEndpoint("ie_test1")?.thread).toBe("1516907849349857421");
    expect(store.listOpenIngestEndpoints("discord", "thread-1")[0]?.thread).toBe(
      "1516907849349857421"
    );
  });
  it("revoke stops listing and lookup still finds the row as revoked", () => {
    store.insertIngestEndpoint(endpoint());
    expect(store.revokeIngestEndpoint("ie_test1", "thread-1")).toBe(true);
    expect(store.listOpenIngestEndpoints("discord", "thread-1")).toHaveLength(0);
    expect(store.getIngestEndpoint("ie_test1")?.status).toBe("revoked");
  });
  it("unique-student claim rejects a duplicate id", () => {
    store.insertIngestEndpoint(endpoint({ uniqueStudent: true }));
    expect(store.claimIngestStudent("ie_test1", "alaina").ok).toBe(true);
    expect(store.claimIngestStudent("ie_test1", "alaina").ok).toBe(false);
    expect(store.claimIngestStudent("ie_test1", "allie").ok).toBe(true);
  });
});

describe("POST /ingest headless endpoint (#95)", () => {
  it("retries the same studentId by default", async () => {
    const token = mintBridgeToken();
    store.insertIngestEndpoint(endpoint({ tokenHash: hashBridgeToken(token) }));
    const specs: DispatchSpec[] = [];
    const results = new ChoiceResultHub({ store, logger: silent });
    const ingest = new ChoiceIngest({
      store,
      results,
      logger: silent,
      enqueue: async (s) => {
        specs.push(s);
      },
      destLive: async () => "ok",
      authoringSession: () => record(),
      publicBase: () => "https://example.test",
      waitMs: 50,
    });
    const server = createServer((req, res) => void ingest.handle(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const first = await fetch(`http://127.0.0.1:${port}/ingest?wait=0`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "a", studentId: "same" }),
    });
    const second = await fetch(`http://127.0.0.1:${port}/ingest?wait=0`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "b", studentId: "same" }),
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(specs).toHaveLength(2);
    expect(specs[0]!.kind).toBe("ingest");
    expect(specs[0]!.session).toBe("isolated");
    expect(specs[0]!.stream).toBe(false);
    server.close();
  });

  it("uniqueStudent rejects a second same studentId", async () => {
    const token = mintBridgeToken();
    store.insertIngestEndpoint(
      endpoint({ tokenHash: hashBridgeToken(token), uniqueStudent: true })
    );
    const ingest = new ChoiceIngest({
      store,
      results: new ChoiceResultHub({ store, logger: silent }),
      logger: silent,
      enqueue: async () => {},
      destLive: async () => "ok",
      authoringSession: () => record(),
      publicBase: () => "https://example.test",
      waitMs: 50,
    });
    const server = createServer((req, res) => void ingest.handle(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const first = await fetch(`http://127.0.0.1:${port}/ingest?wait=0`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "a", studentId: "same" }),
    });
    const second = await fetch(`http://127.0.0.1:${port}/ingest?wait=0`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "b", studentId: "same" }),
    });
    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    server.close();
  });

  it("returns declared JSON, not the transcript", async () => {
    const token = mintBridgeToken();
    store.insertIngestEndpoint(endpoint({ tokenHash: hashBridgeToken(token) }));
    const specs: DispatchSpec[] = [];
    const results = new ChoiceResultHub({ store, logger: silent });
    const ingest = new ChoiceIngest({
      store,
      results,
      logger: silent,
      enqueue: async (s) => {
        specs.push(s);
      },
      destLive: async () => "ok",
      authoringSession: () => record(),
      publicBase: () => "https://example.test",
      waitMs: 2000,
    });
    const server = createServer((req, res) => void ingest.handle(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const post = fetch(`http://127.0.0.1:${port}/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "my essay", studentId: "stu-1" }),
    });
    const until = Date.now() + 2000;
    while (specs.length === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(specs[0]).toBeTruthy();
    results.bindSession("job", specs[0]!.id);
    const submitted = results.submitFromDispatch(specs[0]!.id, { overallScore: 4, prose: "nice" });
    expect(submitted.ok).toBe(true);
    const res = await post;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ overallScore: 4, prose: "nice" });
    server.close();
  });

  it("GET /ingest/jobs/{id} returns 422 JSON when the turn ends with no submit_result", async () => {
    const token = mintBridgeToken();
    store.insertIngestEndpoint(endpoint({ tokenHash: hashBridgeToken(token) }));
    const specs: DispatchSpec[] = [];
    const results = new ChoiceResultHub({ store, logger: silent });
    const ingest = new ChoiceIngest({
      store,
      results,
      logger: silent,
      enqueue: async (s) => {
        specs.push(s);
      },
      destLive: async () => "ok",
      authoringSession: () => record(),
      publicBase: () => "https://example.test",
      waitMs: 60_000,
    });
    const server = createServer((req, res) => void ingest.handle(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const post = await fetch(`http://127.0.0.1:${port}/ingest?wait=0`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "essay", studentId: "stu-miss" }),
    });
    expect(post.status).toBe(202);
    const { jobId } = (await post.json()) as { jobId: string };
    expect(jobId).toBeTruthy();
    results.turnEnded(jobId);
    const poll = await fetch(`http://127.0.0.1:${port}/ingest/jobs/${jobId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(poll.status).toBe(422);
    expect(await poll.json()).toEqual({
      error: "turn ended with no submit_result / seam-result",
      jobId,
      status: "missing",
    });
    server.close();
  });

  it("POST wait-ended without submit_result is 422, not 504", async () => {
    const token = mintBridgeToken();
    store.insertIngestEndpoint(endpoint({ tokenHash: hashBridgeToken(token) }));
    const specs: DispatchSpec[] = [];
    const results = new ChoiceResultHub({ store, logger: silent });
    const ingest = new ChoiceIngest({
      store,
      results,
      logger: silent,
      enqueue: async (s) => {
        specs.push(s);
      },
      destLive: async () => "ok",
      authoringSession: () => record(),
      publicBase: () => "https://example.test",
      waitMs: 2000,
    });
    const server = createServer((req, res) => void ingest.handle(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const post = fetch(`http://127.0.0.1:${port}/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "essay" }),
    });
    const until = Date.now() + 2000;
    while (specs.length === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(specs[0]).toBeTruthy();
    results.turnEnded(specs[0]!.id);
    const res = await post;
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: "turn ended with no submit_result / seam-result",
      jobId: specs[0]!.id,
      status: "missing",
    });
    server.close();
  });

  it("thread mode: turn-end without submit_result is success, not 422 (#224)", async () => {
    const token = mintBridgeToken();
    store.insertIngestEndpoint(
      endpoint({
        tokenHash: hashBridgeToken(token),
        thread: "1516907849349857421",
        agentId: null,
        model: null,
        cwd: null,
        resultSchema: null,
      })
    );
    const specs: DispatchSpec[] = [];
    const results = new ChoiceResultHub({ store, logger: silent });
    const ingest = new ChoiceIngest({
      store,
      results,
      logger: silent,
      enqueue: async (s) => {
        specs.push(s);
      },
      destLive: async () => "ok",
      threadLive: async () => "ok",
      authoringSession: () => record(),
      publicBase: () => "https://example.test",
      waitMs: 2000,
    });
    const server = createServer((req, res) => void ingest.handle(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const post = fetch(`http://127.0.0.1:${port}/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "a visitor question" }),
    });
    const until = Date.now() + 2000;
    while (specs.length === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(specs[0]).toBeTruthy();
    expect(specs[0]!.session).toBe("live");
    expect(specs[0]!.target).toBe("1516907849349857421");
    results.turnEnded(specs[0]!.id, { resultOptional: true });
    const res = await post;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The durable row agrees, so a late GET /jobs/{id} reads 200 too.
    const poll = await fetch(`http://127.0.0.1:${port}/ingest/jobs/${specs[0]!.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(poll.status).toBe(200);
    server.close();
  });

  it("thread mode: a resultSchema still requires submit_result (#224)", async () => {
    const results = new ChoiceResultHub({ store, logger: silent });
    store.insertChoiceResult({
      dispatchId: "d-schema",
      choiceId: "ie_test1",
      status: "pending",
      body: null,
      error: null,
      schema: { type: "object" },
      createdUtc: new Date().toISOString(),
      finishedUtc: null,
    });
    const pending = results.expect({
      dispatchId: "d-schema",
      choiceId: "ie_test1",
      schema: { type: "object" },
    });
    results.turnEnded("d-schema", { resultOptional: true });
    await expect(pending).rejects.toThrow(/no declared result/);
    expect(store.getChoiceResult("d-schema")?.status).toBe("missing");
  });

  it("thread mode: an archived destination 409s and does not enqueue (#224)", async () => {
    const token = mintBridgeToken();
    store.insertIngestEndpoint(
      endpoint({
        tokenHash: hashBridgeToken(token),
        thread: "1516907849349857421",
        uniqueStudent: true,
      })
    );
    const ingest = new ChoiceIngest({
      store,
      results: new ChoiceResultHub({ store, logger: silent }),
      logger: silent,
      enqueue: async () => {
        throw new Error("should not enqueue");
      },
      destLive: async () => "ok",
      threadLive: async () => "archived",
      authoringSession: () => record(),
      publicBase: () => "https://example.test",
    });
    const server = createServer((req, res) => void ingest.handle(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/ingest?wait=0`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "x", studentId: "stu" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "destination thread is archived" });
    // The refused POST must not burn the one-shot student claim.
    expect(store.claimIngestStudent("ie_test1", "stu").ok).toBe(true);
    server.close();
  });

  it("isolated mode still fails a turn that declares nothing (#224 regression)", async () => {
    const results = new ChoiceResultHub({ store, logger: silent });
    store.insertChoiceResult({
      dispatchId: "d-iso",
      choiceId: "ie_test1",
      status: "pending",
      body: null,
      error: null,
      schema: null,
      createdUtc: new Date().toISOString(),
      finishedUtc: null,
    });
    const pending = results.expect({ dispatchId: "d-iso", choiceId: "ie_test1", schema: null });
    results.turnEnded("d-iso");
    await expect(pending).rejects.toThrow(/no declared result/);
    expect(store.getChoiceResult("d-iso")?.status).toBe("missing");
  });

  it("409s a revoked endpoint", async () => {
    const token = mintBridgeToken();
    store.insertIngestEndpoint(
      endpoint({ tokenHash: hashBridgeToken(token), status: "revoked" })
    );
    const ingest = new ChoiceIngest({
      store,
      results: new ChoiceResultHub({ store, logger: silent }),
      logger: silent,
      enqueue: async () => {
        throw new Error("should not enqueue");
      },
      destLive: async () => "ok",
      authoringSession: () => record(),
      publicBase: () => "https://example.test",
    });
    const server = createServer((req, res) => void ingest.handle(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    expect(res.status).toBe(409);
    server.close();
  });
});

describe("MCP create_ingest / cancel_ingest", () => {
  it("create_ingest returns the token once", async () => {
    const server = new SeamMcpServer({
      logger: silent,
      resolveSession: (t) => (t === "tok" ? record() : undefined),
      enqueueDispatch: async () => {},
      createIngest: async () => ({
        ok: true,
        ingestId: "ie_1",
        ingestToken: "secret-token",
        ingestUrl: "https://example.test/ingest",
      }),
    });
    await server.start();
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seam-session": "tok" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_ingest", arguments: { name: "quiz" } },
      }),
    });
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toMatch(/ie_1/);
    expect(body.result.content[0]!.text).toMatch(/secret-token/);
    expect(body.result.content[0]!.text).toMatch(/shown once/);
    await server.stop();
  });

  it("create_ingest advertises thread and reports the live-handoff contract (#224)", async () => {
    let seen: unknown;
    const server = new SeamMcpServer({
      logger: silent,
      resolveSession: (t) => (t === "tok" ? record() : undefined),
      enqueueDispatch: async () => {},
      createIngest: async (_r, spec) => {
        seen = spec;
        return {
          ok: true,
          ingestId: "ie_1",
          ingestToken: "secret-token",
          ingestUrl: "https://example.test/ingest",
          thread: "1516907849349857421",
        };
      },
    });
    await server.start();
    const list = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seam-session": "tok" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const tools = (await list.json()) as {
      result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> };
    };
    const create = tools.result.tools.find((t) => t.name === "create_ingest")!;
    expect(create.inputSchema.properties.thread).toBeTruthy();

    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seam-session": "tok" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "create_ingest",
          arguments: { name: "site-questions", thread: "1516907849349857421" },
        },
      }),
    });
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(seen).toMatchObject({ thread: "1516907849349857421" });
    expect(body.result.content[0]!.text).toMatch(/live turn in thread 1516907849349857421/);
    expect(body.result.content[0]!.text).toMatch(/no report-back/);
    expect(body.result.content[0]!.text).not.toMatch(/Isolated silent/);
    await server.stop();
  });

  it("surfaces a participant refusal", async () => {
    const server = new SeamMcpServer({
      logger: silent,
      resolveSession: (t) => (t === "tok" ? record() : undefined),
      enqueueDispatch: async () => {},
      createIngest: async () => ({
        ok: false,
        error: "Restricted participants cannot create ingest endpoints.",
      }),
    });
    await server.start();
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seam-session": "tok" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_ingest", arguments: { name: "quiz" } },
      }),
    });
    const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toMatch(/Restricted participants/);
    await server.stop();
  });
});
