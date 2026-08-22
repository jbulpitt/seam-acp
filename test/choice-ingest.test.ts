import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { hashBridgeToken, mintBridgeToken } from "../packages/core/src/core/bridge-pairing.js";
import {
  ChoiceResultHub,
  validateAgainstSchema,
  extractSeamResultFromText,
} from "../packages/core/src/core/choice/result.js";
import { ChoiceIngest, parseIngestBody, buildIngestPayload } from "../packages/core/src/core/choice/ingest.js";
import type { ChoiceCard } from "../packages/core/src/core/choice/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import { parseChoiceSpec, defaultMaxClicks, wrapChoicePrompt } from "../packages/core/src/core/choice/types.js";
import { SeamMcpServer } from "../packages/core/src/core/mcp/seam-mcp-server.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

let dir: string;
let store: SessionStore;

function card(over: Partial<ChoiceCard> = {}): ChoiceCard {
  const token = over.ingestTokenHash ? "preset" : mintBridgeToken();
  const hash = over.ingestTokenHash ?? hashBridgeToken(token);
  return {
    id: "cid1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "chan-1",
    messageId: "msg-1",
    title: "Essay",
    body: null,
    maxClicks: 100,
    targetUserId: null,
    defaultTarget: { type: "live" },
    options: [{ label: "Submit…", kind: "custom", target: { type: "live" } }],
    clickCount: 0,
    status: "open",
    lastClickerId: null,
    lastClickerName: null,
    createdBy: "discord:thread-1",
    createdUtc: "2026-08-18T00:00:00.000Z",
    ingestTokenHash: hash,
    ingestOptionIndex: 0,
    resultSchema: {
      type: "object",
      required: ["overallScore", "prose"],
      properties: { overallScore: { type: "number" }, prose: { type: "string" } },
    },
    ingestWrapper: "Grade this.",
    ingestCors: null,
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-ingest-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("result schema (#92)", () => {
  const schema = {
    type: "object",
    required: ["overallScore", "prose"],
    properties: { overallScore: { type: "number" }, prose: { type: "string" } },
    additionalProperties: false,
  };
  it("accepts a matching object", () => {
    expect(validateAgainstSchema(schema, { overallScore: 3, prose: "ok" }).ok).toBe(true);
  });
  it("rejects missing required", () => {
    const r = validateAgainstSchema(schema, { overallScore: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/prose/);
  });
  it("rejects extra keys when additionalProperties false", () => {
    const r = validateAgainstSchema(schema, { overallScore: 3, prose: "x", extra: 1 });
    expect(r.ok).toBe(false);
  });
  it("no schema accepts anything", () => {
    expect(validateAgainstSchema(null, { anything: true }).ok).toBe(true);
  });
});

describe("ingest payload helpers", () => {
  it("parses JSON and form bodies", () => {
    expect(parseIngestBody(`{"text":"hi","studentId":"s1"}`, "application/json")).toEqual({
      text: "hi",
      studentId: "s1",
    });
    expect(parseIngestBody("text=hello&studentId=s2", "application/x-www-form-urlencoded")).toEqual({
      text: "hello",
      studentId: "s2",
    });
  });
  it("does not put studentId into the emitted payload", () => {
    const p = buildIngestPayload({ text: "essay", studentId: "stu" }, null, "wrapper");
    expect(p).toContain("essay");
    expect(p).not.toContain("stu");
    expect(p).toContain("wrapper");
  });
});

describe("choice spec ingress", () => {
  it("accepts ingress true and object", () => {
    const base = {
      title: "t",
      options: [{ label: "Go", kind: "custom" as const }],
    };
    expect(parseChoiceSpec({ ...base, ingress: true }).ok).toBe(true);
    expect(parseChoiceSpec({ ...base, ingress: { wrapper: "rubric" } }).ok).toBe(true);
  });
  it("defaults maxClicks to 100 when ingress is set", () => {
    const spec = parseChoiceSpec({
      title: "t",
      ingress: true,
      options: [{ label: "Go", kind: "custom" as const }],
    });
    expect(spec.ok).toBe(true);
    if (spec.ok) expect(defaultMaxClicks(spec.spec)).toBe(100);
  });
});

describe("wrapChoicePrompt http source", () => {
  it("tells the agent to submit_result and stamps untrusted student id", () => {
    const p = wrapChoicePrompt({
      cardId: "c1",
      optionLabel: "Submit…",
      clickerName: "ingest:s1",
      clickerId: "ingest:c1:s1",
      authoringThread: "th",
      destination: "live",
      payload: "essay",
      source: "http",
      wrapper: "Grade this.",
      untrustedStudentId: "s1",
    });
    expect(p).toContain("HTTP ingest");
    expect(p).toContain("untrusted");
    expect(p).toContain("submit_result");
    expect(p).toContain("Grade this.");
    expect(p).toContain("essay");
  });
});

describe("POST /ingest (#92)", () => {
  it("emits via emitChoice and returns declared JSON, not transcript", async () => {
    const token = mintBridgeToken();
    store.insertChoiceCard(card({ ingestTokenHash: hashBridgeToken(token) }));
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
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(specs).toHaveLength(1);
    expect(specs[0]!.kind).toBe("choice");
    expect(specs[0]!.session).toBe("live");
    expect(specs[0]!.prompt).toContain("my essay");
    expect(specs[0]!.prompt).toContain("submit_result");
    results.bindSession("discord:thread-1", specs[0]!.id);
    const submitted = results.submitFromSession("discord:thread-1", {
      overallScore: 4,
      prose: "Nice work.",
    });
    expect(submitted.ok).toBe(true);
    const res = await post;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ overallScore: 4, prose: "Nice work." });
    server.close();
  });

  it("POST ?wait=0 returns 202 with jobId immediately", async () => {
    const token = mintBridgeToken();
    store.insertChoiceCard(card({ ingestTokenHash: hashBridgeToken(token) }));
    const ingest = new ChoiceIngest({
      store,
      results: new ChoiceResultHub({ store, logger: silent }),
      logger: silent,
      enqueue: async () => {},
      destLive: async () => "ok",
      authoringSession: () => record(),
      publicBase: () => "https://example.test",
      waitMs: 60_000,
    });
    const server = createServer((req, res) => void ingest.handle(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/ingest?wait=0`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "essay" }),
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string; poll: string };
    expect(body.jobId).toBeTruthy();
    expect(body.poll).toMatch(/^\/ingest\/jobs\//);
    server.close();
  });

  it("rejects a second submit from the same studentId", async () => {
    const token = mintBridgeToken();
    store.insertChoiceCard(card({ ingestTokenHash: hashBridgeToken(token), maxClicks: 10 }));
    const results = new ChoiceResultHub({ store, logger: silent });
    const ingest = new ChoiceIngest({
      store,
      results,
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
    const first = await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "a", studentId: "same" }),
    });
    expect(first.status).toBe(202);
    const second = await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "b", studentId: "same" }),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: expect.stringMatching(/already submitted/) });
    server.close();
  });

  it("refuses a bad token", async () => {
    const results = new ChoiceResultHub({ store, logger: silent });
    const ingest = new ChoiceIngest({
      store,
      results,
      logger: silent,
      enqueue: async () => {},
      destLive: async () => "ok",
      authoringSession: () => null,
      publicBase: () => "https://example.test",
    });
    const server = createServer((req, res) => void ingest.handle(req, res));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
      method: "POST",
      headers: { authorization: "Bearer nope", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
    server.close();
  });

  it("does not claim when the destination is gone", async () => {
    const token = mintBridgeToken();
    store.insertChoiceCard(card({ ingestTokenHash: hashBridgeToken(token) }));
    const results = new ChoiceResultHub({ store, logger: silent });
    const ingest = new ChoiceIngest({
      store,
      results,
      logger: silent,
      enqueue: async () => {
        throw new Error("should not enqueue");
      },
      destLive: async () => "gone",
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
    expect(store.getChoiceCard("cid1")?.clickCount).toBe(0);
    server.close();
  });

  it("returns 504 when the turn ends with no submit_result, not 202 pending", async () => {
    const token = mintBridgeToken();
    store.insertChoiceCard(card({ ingestTokenHash: hashBridgeToken(token) }));
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
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(specs).toHaveLength(1);
    results.turnEnded(specs[0]!.id);
    const res = await post;
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: string; jobId: string };
    expect(body.error).toMatch(/no submit_result|no declared result/);
    expect(body.jobId).toBe(specs[0]!.id);
    server.close();
  });
});

describe("submit_result MCP", () => {
  it("forwards the arguments object as the result", async () => {
    let seen: unknown;
    const server = new SeamMcpServer({
      logger: silent,
      resolveSession: (t) => (t === "tok" ? record() : undefined),
      enqueueDispatch: async () => {},
      submitResult: (_r, value) => {
        seen = value;
        return { ok: true, dispatchId: "d1" };
      },
    });
    await server.start();
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-seam-session": "tok" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "submit_result", arguments: { overallScore: 2, prose: "meh" } },
      }),
    });
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toMatch(/d1/);
    expect(seen).toEqual({ overallScore: 2, prose: "meh" });
    await server.stop();
  });
});

describe("ChoiceResultHub isolated ingest bind", () => {
  it("submit_result on the store session id hits a waiter bound only to channel + store id (not ACP uuid)", () => {
    const results = new ChoiceResultHub({ store, logger: silent });
    store.insertChoiceCard(card({ ingestTokenHash: "abc" }));
    store.insertChoiceResult({
      dispatchId: "d-iso",
      choiceId: "cid1",
      status: "pending",
      body: null,
      error: null,
      schema: { type: "object", required: ["prose"], properties: { prose: { type: "string" } } },
      createdUtc: new Date().toISOString(),
      finishedUtc: null,
    });
    results.expect({ dispatchId: "d-iso", choiceId: "cid1", schema: { type: "object" } });
    results.bindSession("acp-throwaway-uuid", "d-iso");
    expect(results.submitFromSession("discord:thread-1", { prose: "from store id" }).ok).toBe(false);
    results.bindSession("discord:thread-1", "d-iso");
    results.bindChannel("thread-1", "d-iso");
    expect(results.submitFromSession("discord:thread-1", { prose: "from store id" }).ok).toBe(true);
    expect(store.getChoiceResult("d-iso")?.status).toBe("ok");
  });

  it("channel fallback works when session bind missed", () => {
    const results = new ChoiceResultHub({ store, logger: silent });
    store.insertChoiceCard(card({ ingestTokenHash: "abc" }));
    store.insertChoiceResult({
      dispatchId: "d-ch",
      choiceId: "cid1",
      status: "pending",
      body: null,
      error: null,
      schema: null,
      createdUtc: new Date().toISOString(),
      finishedUtc: null,
    });
    results.expect({ dispatchId: "d-ch", choiceId: "cid1", schema: null });
    results.bindChannel("thread-1", "d-ch");
    expect(results.submitFromSession("discord:thread-1", { prose: "x" }).ok).toBe(false);
    expect(results.submitFromChannel("thread-1", { prose: "x" }).ok).toBe(true);
  });

  it("extractSeamResultFromText harvests an isolated transcript fence", () => {
    const text = "thinking...\n```seam-result\n{\"overallScore\":1,\"prose\":\"ok\"}\n```\n";
    const got = extractSeamResultFromText(text);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value).toEqual({ overallScore: 1, prose: "ok" });
    expect(extractSeamResultFromText("no fence").ok).toBe(false);
  });
});

describe("ChoiceResultHub first-wins", () => {
  it("second submit is refused; missing result on turnEnded", () => {
    const results = new ChoiceResultHub({ store, logger: silent });
    store.insertChoiceCard(card({ ingestTokenHash: "abc" }));
    store.insertChoiceResult({
      dispatchId: "d1",
      choiceId: "cid1",
      status: "pending",
      body: null,
      error: null,
      schema: { type: "object", required: ["prose"], properties: { prose: { type: "string" } } },
      createdUtc: new Date().toISOString(),
      finishedUtc: null,
    });
    const pending = results.expect({ dispatchId: "d1", choiceId: "cid1", schema: { type: "object" } });
    results.bindSession("sess", "d1");
    expect(results.submitFromSession("sess", { prose: "ok" }).ok).toBe(true);
    expect(results.submitFromSession("sess", { prose: "nope" }).ok).toBe(false);
    void pending;
    results.turnEnded("d1");
    expect(store.getChoiceResult("d1")?.status).toBe("ok");
  });
});

describe("seam-choice fence must not leak ingest tokens", () => {
  it("publishes the click-card without minting or posting a Bearer token", async () => {
    store.upsert(record());
    const sent: string[] = [];
    let postedChoiceId = "";
    const orch = new Orchestrator({
      logger: silent,
      config: { DATA_DIR: dir, REPOS_ROOT: dir, TURN_TIMEOUT_SECONDS: 60, DEFAULT_MODEL: "x" } as any,
      adapter: {
        async sendMessage(_ch: unknown, text: string) {
          sent.push(text);
          return { channel: { platform: "discord", id: "thread-1" }, id: "n1" };
        },
        async sendChoiceCard(_ch: unknown, card: { choiceId: string }) {
          postedChoiceId = card.choiceId;
          return { channel: { platform: "discord", id: "thread-1" }, id: "card-1" };
        },
      } as any,
      router: {
        listProfiles: () => [],
        describeConfig: () => ({}),
        ensureSessionRecord: () => record(),
        getProfile: () => ({ id: "claude" }),
      } as any,
      store,
      renderer: {} as any,
    });
    orch.setIngestUrl(() => "https://example.test/ingest");
    await (orch as any).emitChoiceFence(
      { platform: "discord", id: "thread-1", parentId: "chan-1" },
      {
        lang: "seam-choice",
        ext: "json",
        mimeType: "application/json",
        content: JSON.stringify({
          title: "Essay check",
          options: [{ label: "Submit…", kind: "custom" }],
          ingress: { wrapper: "Grade this.", resultSchema: { type: "object" } },
        }),
        openedAtMs: Date.now(),
      }
    );
    const blob = sent.join("\n");
    expect(blob).not.toMatch(/Bearer\s/i);
    expect(blob).not.toMatch(/ingestToken/i);
    expect(blob).toMatch(/create_choice/);
    expect(postedChoiceId).toBeTruthy();
    expect(store.getChoiceCard(postedChoiceId)?.ingestTokenHash).toBeNull();
  });
});
