import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import {
  CHOICE_AUTHORING_RULE,
  CHOICE_FENCE_LANG,
  choiceClickRefusal,
  choiceLayoutCapError,
  formatDestination,
  isChoiceAuthoringRefused,
  makeChoiceCustomId,
  makeChoiceModalId,
  parseChoiceCustomId,
  parseChoiceFence,
  parseChoiceSpec,
  renderChoicePanel,
  wrapChoicePrompt,
  type ChoiceCard,
} from "../packages/core/src/core/choice/types.js";
import { emitChoice, planChoiceDispatch } from "../packages/core/src/core/choice/emit.js";
import { harnessPreamble } from "../packages/core/src/core/agent-conventions.js";
import type { DispatchSpec } from "../packages/core/src/core/dispatch/types.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import { SeamMcpServer } from "../packages/core/src/core/mcp/seam-mcp-server.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const validSpec = {
  title: "Ship this?",
  options: [
    { label: "Approve", kind: "prompt" as const, payload: "Approved." },
    { label: "Type a fix…", kind: "custom" as const, target: { type: "isolated" as const } },
  ],
};

function makeCard(over: Partial<ChoiceCard> = {}): ChoiceCard {
  return {
    id: "cid1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "chan-1",
    messageId: "msg-1",
    title: "Ship this?",
    body: null,
    maxClicks: 1,
    targetUserId: null,
    defaultTarget: { type: "live" },
    options: [
      { label: "Approve", kind: "prompt", payload: "Approved." },
      { label: "Type…", kind: "custom", target: { type: "isolated" } },
    ],
    clickCount: 0,
    status: "open",
    lastClickerId: null,
    lastClickerName: null,
    createdBy: "discord:thread-1",
    createdUtc: "2026-08-18T00:00:00.000Z",
    ingestTokenHash: null,
    ingestOptionIndex: null,
    resultSchema: null,
    ingestWrapper: null,
    ingestCors: null,
    ...over,
  };
}

function record(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "discord:thread-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "chan-1",
    agentId: "claude",
    acpSessionId: "acp-1",
    repoPath: "/repo",
    configJson: JSON.stringify({ model: "claude-opus-4.6", reasoningEffort: "high" }),
    createdUtc: "2026-01-01T00:00:00Z",
    updatedUtc: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("choice spec validate (#91)", () => {
  it("accepts a well-formed card", () => {
    const r = parseChoiceSpec(validSpec);
    expect(r.ok).toBe(true);
  });

  it("refuses empty options", () => {
    const r = parseChoiceSpec({ title: "x", options: [] });
    expect(r.ok).toBe(false);
  });

  it("refuses prompt without payload", () => {
    const r = parseChoiceSpec({
      title: "x",
      options: [{ label: "Go", kind: "prompt" }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/payload/);
  });

  it("layout cap: 25 ok without custom; 26 refused", () => {
    const opts = Array.from({ length: 25 }, (_, i) => ({
      label: `O${i}`,
      kind: "prompt" as const,
      payload: "p",
    }));
    expect(parseChoiceSpec({ title: "t", options: opts }).ok).toBe(true);
    expect(parseChoiceSpec({ title: "t", options: [...opts, { label: "x", kind: "prompt", payload: "p" }] }).ok).toBe(
      false
    );
  });

  it("layout cap: 24 total with a custom ok; 25 with a custom refused", () => {
    const prompts23 = Array.from({ length: 23 }, (_, i) => ({
      label: `O${i}`,
      kind: "prompt" as const,
      payload: "p",
    }));
    expect(
      parseChoiceSpec({
        title: "t",
        options: [...prompts23, { label: "Type", kind: "custom" }],
      }).ok
    ).toBe(true);
    expect(
      choiceLayoutCapError([...prompts23, { kind: "custom" }, { kind: "custom" }])
    ).toMatch(/24/);
  });

  it("thread target requires threadId", () => {
    const r = parseChoiceSpec({
      title: "t",
      options: [{ label: "Go", kind: "prompt", payload: "p", target: { type: "thread" } }],
    });
    expect(r.ok).toBe(false);
  });
});

describe("choice fence parse + strip contract", () => {
  it("parses a seam-choice JSON body", () => {
    const r = parseChoiceFence(JSON.stringify(validSpec));
    expect(r.ok).toBe(true);
  });

  it("refuses non-JSON", () => {
    const r = parseChoiceFence("not json");
    expect(r.ok).toBe(false);
  });

  it("CHOICE_FENCE_LANG is seam-choice", () => {
    expect(CHOICE_FENCE_LANG).toBe("seam-choice");
  });

  it("default harness preamble does NOT include the authoring rule (thin extra-rule)", () => {
    const p = harnessPreamble();
    expect(p).not.toContain("seam-choice");
    expect(harnessPreamble([CHOICE_AUTHORING_RULE])).toContain("seam-choice");
  });
});

describe("D8 payload wrap", () => {
  it("stamps card/option/clicker/thread/destination then the payload", () => {
    const text = wrapChoicePrompt({
      cardId: "cid1",
      optionLabel: "Approve",
      clickerName: "Jesse",
      clickerId: "1487",
      authoringThread: "thread-1",
      destination: "live",
      payload: "Approved. Merge.",
    });
    expect(text).toContain("<seam-choice>");
    expect(text).toContain('option "Approve" clicked by Jesse (id 1487)');
    expect(text).toContain("Authoring thread: thread-1");
    expect(text).toContain("Destination: live");
    expect(text).toMatch(/<\/seam-choice>\n\nApproved\. Merge\./);
  });

  it("formatDestination names thread snowflakes", () => {
    expect(formatDestination({ type: "isolated" })).toBe("isolated");
    expect(formatDestination({ type: "thread", threadId: "99" })).toBe("thread 99");
  });
});

describe("click auth", () => {
  const allowed = new Set(["1", "2", "3"]);
  it("allows an allowed user", () => {
    expect(choiceClickRefusal("1", makeCard(), allowed)).toBe("ok");
  });
  it("refuses a non-allowlisted user without consuming (caller must not claim)", () => {
    expect(choiceClickRefusal("9", makeCard(), allowed)).toBe("not-allowed");
  });
  it("targetUserId: only that user", () => {
    const card = makeCard({ targetUserId: "2" });
    expect(choiceClickRefusal("1", card, allowed)).toBe("not-target");
    expect(choiceClickRefusal("2", card, allowed)).toBe("ok");
  });
  it("closed card", () => {
    expect(choiceClickRefusal("1", makeCard({ status: "exhausted" }), allowed)).toBe("closed");
  });
  it("participants may click (auth does not consult participant set)", () => {
    expect(choiceClickRefusal("3", makeCard(), allowed)).toBe("ok");
  });
});

describe("participant authoring gate (D9)", () => {
  const STUDENT = "1534";
  const ADMIN = "1487";
  it("refuses a restricted participant", () => {
    expect(isChoiceAuthoringRefused(STUDENT, new Set([STUDENT]), new Set([ADMIN]))).toBe(true);
  });
  it("allows an admin even if also listed as participant", () => {
    expect(isChoiceAuthoringRefused(ADMIN, new Set([ADMIN, STUDENT]), new Set([ADMIN]))).toBe(false);
  });
  it("injected turns (no author id) may author", () => {
    expect(isChoiceAuthoringRefused(null, new Set([STUDENT]), new Set([ADMIN]))).toBe(false);
    expect(isChoiceAuthoringRefused(undefined, new Set([STUDENT]), new Set())).toBe(false);
  });
  it("operators (not in participant set) may author", () => {
    expect(isChoiceAuthoringRefused("111", new Set([STUDENT]), new Set([ADMIN]))).toBe(false);
  });
});

describe("custom_id lookup only", () => {
  it("round-trips option / select / modal ids", () => {
    expect(parseChoiceCustomId(makeChoiceCustomId("abc", 2))).toEqual({
      choiceId: "abc",
      optionIndex: 2,
      kind: "option",
    });
    expect(parseChoiceCustomId(makeChoiceModalId("abc", 1))).toEqual({
      choiceId: "abc",
      optionIndex: 1,
      kind: "modal",
    });
    expect(parseChoiceCustomId("choice:abc:s")).toEqual({ choiceId: "abc", kind: "select" });
    expect(parseChoiceCustomId("seam-cfg-edit:x:save")).toBeNull();
  });
});

describe("emitChoice helper", () => {
  it("builds a kind:choice live spec wrapping D8 provenance", async () => {
    const enqueued: DispatchSpec[] = [];
    const r = await emitChoice({
      card: makeCard(),
      optionIndex: 0,
      actor: { id: "1", name: "Jesse" },
      payload: "Approved.",
      enqueue: async (s) => {
        enqueued.push(s);
      },
      authoringSession: record(),
      destLive: "ok",
    });
    expect(r.ok).toBe(true);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.kind).toBe("choice");
    expect(enqueued[0]!.session).toBe("live");
    expect(enqueued[0]!.target).toBe("thread-1");
    expect(enqueued[0]!.prompt).toContain("<seam-choice>");
    expect(enqueued[0]!.prompt).toContain("Approved.");
  });

  it("isolated inherits authoring cwd/model/effort and stays on the card thread", async () => {
    const enqueued: DispatchSpec[] = [];
    const r = await emitChoice({
      card: makeCard(),
      optionIndex: 1,
      actor: { id: "1", name: "Jesse" },
      payload: "typed fix",
      enqueue: async (s) => {
        enqueued.push(s);
      },
      authoringSession: record(),
      destLive: "ok",
    });
    expect(r.ok).toBe(true);
    expect(enqueued[0]!.session).toBe("isolated");
    expect(enqueued[0]!.target).toBe("thread-1");
    expect(enqueued[0]!.cwd).toBe("/repo");
    expect(enqueued[0]!.model).toBe("claude-opus-4.6");
    expect(enqueued[0]!.effort).toBe("high");
  });

  it("thread destination uses the snowflake as live target", () => {
    const planned = planChoiceDispatch({
      card: makeCard({
        options: [
          {
            label: "QA",
            kind: "prompt",
            payload: "qa",
            target: { type: "thread", threadId: "999" },
          },
        ],
      }),
      optionIndex: 0,
      actor: { id: "1", name: "J" },
      payload: "qa",
      enqueue: async () => {},
      authoringSession: record(),
      destLive: "ok",
    });
    expect(planned.ok).toBe(true);
    if (planned.ok) {
      expect(planned.spec.session).toBe("live");
      expect(planned.spec.target).toBe("999");
    }
  });

  it("gone destination refuses without enqueue (D13, no consume)", async () => {
    const enqueued: DispatchSpec[] = [];
    const r = await emitChoice({
      card: makeCard(),
      optionIndex: 0,
      actor: { id: "1", name: "J" },
      payload: "x",
      enqueue: async (s) => {
        enqueued.push(s);
      },
      authoringSession: record(),
      destLive: "gone",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.consume).toBe(false);
    expect(enqueued).toHaveLength(0);
  });
});

describe("SessionStore atomic claim", () => {
  let dir: string;
  let store: SessionStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-choice-"));
    store = new SessionStore(path.join(dir, "t.db"));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("two users racing maxClicks:1 — exactly one wins", () => {
    store.insertChoiceCard(makeCard({ id: "c1", maxClicks: 1 }));
    const a = store.claimChoiceClick({ choiceId: "c1", userId: "u1", userName: "A", optionIndex: 0 });
    const b = store.claimChoiceClick({ choiceId: "c1", userId: "u2", userName: "B", optionIndex: 0 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(["exhausted", "not-open"]).toContain(b.reason);
    expect(store.getChoiceCard("c1")?.clickCount).toBe(1);
    expect(store.getChoiceCard("c1")?.status).toBe("exhausted");
  });

  it("same user cannot click twice even when maxClicks > 1", () => {
    store.insertChoiceCard(makeCard({ id: "c1", maxClicks: 5 }));
    const a = store.claimChoiceClick({ choiceId: "c1", userId: "u1", userName: "A", optionIndex: 0 });
    const b = store.claimChoiceClick({ choiceId: "c1", userId: "u1", userName: "A", optionIndex: 1 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe("already-clicked");
    expect(store.getChoiceCard("c1")?.clickCount).toBe(1);
    expect(store.getChoiceCard("c1")?.status).toBe("open");
  });

  it("survives reopen (redeploy)", () => {
    store.insertChoiceCard(makeCard({ id: "c1" }));
    store.claimChoiceClick({ choiceId: "c1", userId: "u1", userName: "A", optionIndex: 0 });
    store.close();
    store = new SessionStore(path.join(dir, "t.db"));
    const card = store.getChoiceCard("c1");
    expect(card?.status).toBe("exhausted");
    expect(card?.clickCount).toBe(1);
  });

  it("cancel only from authoring thread", () => {
    store.insertChoiceCard(makeCard({ id: "c1", channelRef: "thread-1" }));
    expect(store.cancelChoiceCard("c1", "other")).toBe(false);
    expect(store.cancelChoiceCard("c1", "thread-1")).toBe(true);
    expect(store.getChoiceCard("c1")?.status).toBe("cancelled");
  });
});

describe("renderChoicePanel", () => {
  it("shows clicked/max and disables via status", () => {
    const open = renderChoicePanel(makeCard());
    expect(open.title).toMatch(/Ship this/);
    expect(open.footer).toMatch(/0\/1 · open/);
    const closed = renderChoicePanel(makeCard({ status: "exhausted", clickCount: 1, lastClickerName: "Jesse" }));
    expect(closed.footer).toMatch(/1\/1 · closed/);
    expect(closed.footer).toMatch(/Jesse/);
  });
});

describe("MCP create_choice / cancel_choice", () => {
  it("create_choice publishes via the dep", async () => {
    let seen: unknown;
    const server = new SeamMcpServer({
      logger: silent,
      resolveSession: (t) => (t === "tok" ? record() : undefined),
      enqueueDispatch: async () => {},
      createChoice: async (_r, spec) => {
        seen = spec;
        return { ok: true, choiceId: "c1", messageId: "m1" };
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
        params: { name: "create_choice", arguments: validSpec },
      }),
    });
    const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(body.result.content[0]!.text).toMatch(/Choice card c1/);
    expect(seen).toMatchObject({ title: "Ship this?" });
    await server.stop();
  });

  it("create_choice surfaces a participant refusal from the dep", async () => {
    const server = new SeamMcpServer({
      logger: silent,
      resolveSession: (t) => (t === "tok" ? record() : undefined),
      enqueueDispatch: async () => {},
      createChoice: async () => ({
        ok: false,
        error: "Restricted participants cannot publish choice cards.",
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
        params: { name: "create_choice", arguments: validSpec },
      }),
    });
    const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
    expect(body.result.content[0]!.text).toMatch(/Restricted participants/);
    await server.stop();
  });
});
