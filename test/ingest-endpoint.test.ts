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
