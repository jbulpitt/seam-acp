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
  choiceConfirmNudge,
  choiceLayoutCapError,
  choicePendingKey,
  choiceSelectionInRange,
  formatDestination,
  isChoiceAuthoringRefused,
  isChoiceMultiSelect,
  makeChoiceConfirmId,
  makeChoiceCustomId,
  makeChoiceModalId,
  makeChoiceSelectId,
  parseChoiceCustomId,
  parseChoiceFence,
  parseChoiceSpec,
  renderChoicePanel,
  isChoiceSingleUser,
  choiceCardHideButtons,
  wrapChoiceMultiPrompt,
  wrapChoicePrompt,
  type ChoiceCard,
} from "../packages/core/src/core/choice/types.js";
import {
  emitChoice,
  emitChoiceMulti,
  planChoiceDispatch,
  planChoiceMultiDispatch,
} from "../packages/core/src/core/choice/emit.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { ChoiceInteraction } from "../packages/core/src/platforms/chat-adapter.js";
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
    lastOptionIndex: null,
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

const multiOpts = [
  { label: "Loops", kind: "prompt" as const, payload: "Cover loops." },
  { label: "Recursion", kind: "prompt" as const, payload: "Cover recursion." },
  { label: "Testing", kind: "prompt" as const, payload: "Cover testing." },
];

describe("choice spec select (#94)", () => {
  it("accepts a valid multi-select spec and defaults min=1, max=options.length", () => {
    const r = parseChoiceSpec({ title: "Topics", select: {}, options: multiOpts });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.select).toEqual({ min: 1, max: 3 });
  });

  it("accepts explicit min/max", () => {
    const r = parseChoiceSpec({
      title: "Topics",
      select: { min: 2, max: 3 },
      options: multiOpts,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.select).toEqual({ min: 2, max: 3 });
  });

  it("rejects custom + select", () => {
    const r = parseChoiceSpec({
      title: "t",
      select: { min: 1, max: 1 },
      options: [
        { label: "Go", kind: "prompt", payload: "p" },
        { label: "Type…", kind: "custom" },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/custom/);
  });

  it("rejects min > max", () => {
    const r = parseChoiceSpec({
      title: "t",
      select: { min: 3, max: 1 },
      options: multiOpts,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/min/);
  });

  it("clamps max to options.length and to 25", () => {
    const three = parseChoiceSpec({
      title: "t",
      select: { max: 100 },
      options: multiOpts,
    });
    expect(three.ok).toBe(true);
    if (three.ok) expect(three.spec.select).toEqual({ min: 1, max: 3 });

    const many = Array.from({ length: 25 }, (_, i) => ({
      label: `O${i}`,
      kind: "prompt" as const,
      payload: "p",
    }));
    const capped = parseChoiceSpec({ title: "t", select: { max: 100 }, options: many });
    expect(capped.ok).toBe(true);
    if (capped.ok) expect(capped.spec.select).toEqual({ min: 1, max: 25 });
  });

  it("rejects select + maxClicks>1", () => {
    const r = parseChoiceSpec({
      title: "t",
      maxClicks: 2,
      select: { min: 1, max: 2 },
      options: multiOpts,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/maxClicks>1/);
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

  it("round-trips confirm id (choice:<id>:c)", () => {
    expect(makeChoiceConfirmId("abc")).toBe("choice:abc:c");
    expect(parseChoiceCustomId(makeChoiceConfirmId("abc"))).toEqual({
      choiceId: "abc",
      kind: "confirm",
    });
    expect(parseChoiceCustomId(makeChoiceSelectId("abc"))).toEqual({
      choiceId: "abc",
      kind: "select",
    });
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

describe("D8 multi-select wrap + emit (#94)", () => {
  it("joins labels in the frame and lists payloads under Selected:", () => {
    const text = wrapChoiceMultiPrompt({
      cardId: "cid1",
      optionLabels: ["Loops", "Testing"],
      clickerName: "Jesse",
      clickerId: "1487",
      authoringThread: "thread-1",
      destination: "live",
      payloads: ["Cover loops.", "Cover testing."],
    });
    expect(text).toContain("<seam-choice>");
    expect(text).toContain('options "Loops, Testing" clicked by Jesse (id 1487)');
    expect(text).toMatch(/<\/seam-choice>\n\nSelected: Loops, Testing\nCover loops\.\nCover testing\./);
  });

  it("emits ONE combined prompt to the card defaultTarget", async () => {
    const enqueued: DispatchSpec[] = [];
    const r = await emitChoiceMulti({
      card: makeCard({
        select: { min: 1, max: 3 },
        defaultTarget: { type: "live" },
        options: multiOpts,
      }),
      optionIndices: [0, 2],
      actor: { id: "1", name: "Jesse" },
      enqueue: async (s) => {
        enqueued.push(s);
      },
      authoringSession: record(),
      destLive: "ok",
    });
    expect(r.ok).toBe(true);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.kind).toBe("choice");
    expect(enqueued[0]!.target).toBe("thread-1");
    expect(enqueued[0]!.prompt).toContain("Selected: Loops, Testing");
    expect(enqueued[0]!.prompt).toContain("Cover loops.");
    expect(enqueued[0]!.prompt).toContain("Cover testing.");
    expect(enqueued[0]!.prompt).not.toContain("Cover recursion.");
  });

  it("ignores per-option target and uses defaultTarget", () => {
    const planned = planChoiceMultiDispatch({
      card: makeCard({
        select: { min: 1, max: 2 },
        defaultTarget: { type: "live" },
        options: [
          {
            label: "QA",
            kind: "prompt",
            payload: "qa",
            target: { type: "thread", threadId: "999" },
          },
          { label: "Ship", kind: "prompt", payload: "ship" },
        ],
      }),
      optionIndices: [0, 1],
      actor: { id: "1", name: "J" },
      enqueue: async () => {},
      authoringSession: record(),
      destLive: "ok",
    });
    expect(planned.ok).toBe(true);
    if (planned.ok) {
      expect(planned.spec.session).toBe("live");
      expect(planned.spec.target).toBe("thread-1");
    }
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
    expect(card?.lastOptionIndex).toBe(0);
  });

  it("cancel only from authoring thread", () => {
    store.insertChoiceCard(makeCard({ id: "c1", channelRef: "thread-1" }));
    expect(store.cancelChoiceCard("c1", "other")).toBe(false);
    expect(store.cancelChoiceCard("c1", "thread-1")).toBe(true);
    expect(store.getChoiceCard("c1")?.status).toBe("cancelled");
  });

  it("persists select min/max so a multi-select card survives reopen", () => {
    store.insertChoiceCard(
      makeCard({
        id: "c1",
        select: { min: 2, max: 3 },
        options: multiOpts,
      })
    );
    store.close();
    store = new SessionStore(path.join(dir, "t.db"));
    const card = store.getChoiceCard("c1");
    expect(card?.select).toEqual({ min: 2, max: 3 });
    expect(isChoiceMultiSelect(card!)).toBe(true);
  });

  it("persists lastOptionIndices after a multi-select claim", () => {
    store.insertChoiceCard(makeCard({ id: "c1", select: { min: 1, max: 3 }, options: multiOpts }));
    const claimed = store.claimChoiceClick({
      choiceId: "c1",
      userId: "u1",
      userName: "A",
      optionIndex: 0,
      optionIndices: [0, 2],
    });
    expect(claimed.ok).toBe(true);
    store.close();
    store = new SessionStore(path.join(dir, "t.db"));
    const card = store.getChoiceCard("c1");
    expect(card?.lastOptionIndices).toEqual([0, 2]);
    expect(card?.status).toBe("exhausted");
  });
});

describe("renderChoicePanel", () => {
  it("single-user default: pick one, then show selection and hide buttons", () => {
    const open = renderChoicePanel(makeCard());
    expect(isChoiceSingleUser(makeCard())).toBe(true);
    expect(open.footer).toBe("Pick one");
    expect(choiceCardHideButtons(makeCard())).toBe(false);
    const closed = renderChoicePanel(
      makeCard({
        status: "exhausted",
        clickCount: 1,
        lastClickerName: "Jesse",
        lastOptionIndex: 0,
      })
    );
    expect(closed.footer).toBe("Done");
    expect(closed.fields.some((f) => /Approve/.test(f.value) && /Jesse/.test(f.value))).toBe(true);
    expect(
      choiceCardHideButtons(
        makeCard({ status: "exhausted", clickCount: 1, lastOptionIndex: 0, lastClickerName: "Jesse" })
      )
    ).toBe(true);
  });

  it("targetUserId is still single-user", () => {
    expect(isChoiceSingleUser(makeCard({ targetUserId: "1487", maxClicks: 1 }))).toBe(true);
    expect(choiceCardHideButtons(makeCard({ targetUserId: "1487", maxClicks: 1, status: "exhausted" }))).toBe(
      true
    );
  });

  it("multi-user (maxClicks > 1) keeps count footer and does not hide buttons while open", () => {
    const open = renderChoicePanel(makeCard({ maxClicks: 10 }));
    expect(open.footer).toMatch(/0\/10 · open/);
    expect(choiceCardHideButtons(makeCard({ maxClicks: 10 }))).toBe(false);
    const closed = renderChoicePanel(
      makeCard({ maxClicks: 10, status: "exhausted", clickCount: 10, lastClickerName: "Alaina" })
    );
    expect(closed.footer).toMatch(/10\/10 · closed/);
    expect(choiceCardHideButtons(makeCard({ maxClicks: 10, status: "exhausted", clickCount: 10 }))).toBe(
      false
    );
  });

  it("multi-select freeze shows Selected: A, B, C", () => {
    const closed = renderChoicePanel(
      makeCard({
        select: { min: 1, max: 3 },
        options: multiOpts,
        status: "exhausted",
        clickCount: 1,
        lastClickerName: "Jesse",
        lastOptionIndex: 0,
        lastOptionIndices: [0, 2],
      })
    );
    expect(closed.footer).toBe("Done");
    const selected = closed.fields.find((f) => f.name === "Selected");
    expect(selected?.value).toMatch(/Loops, Testing/);
    expect(selected?.value).toMatch(/Jesse/);
    expect(
      choiceCardHideButtons(
        makeCard({
          select: { min: 1, max: 3 },
          status: "exhausted",
          clickCount: 1,
          lastOptionIndices: [0, 2],
        })
      )
    ).toBe(true);
  });
});

function mockChoiceEvt(
  over: Partial<ChoiceInteraction> & { customId: string }
): ChoiceInteraction & { ephemeral: string[]; edited: unknown[] } {
  const ephemeral: string[] = [];
  const edited: unknown[] = [];
  const evt = {
    userId: "1",
    userName: "Jesse",
    channel: { platform: "discord" as const, id: "thread-1" },
    messageId: "msg-1",
    kind: "select" as const,
    replyEphemeral: async (text: string) => {
      ephemeral.push(text);
    },
    followUpEphemeral: async (text: string) => {
      ephemeral.push(text);
    },
    deferUpdate: async () => {},
    showModal: async () => {},
    ...over,
  };
  return Object.assign(evt, { ephemeral, edited });
}

describe("multi-select lifecycle (#94)", () => {
  let dir: string;
  let store: SessionStore;
  let orch: Orchestrator;
  let posted: Array<{ select?: { min: number; max: number }; pendingSelection?: number[]; hideButtons?: boolean; panel: { fields: Array<{ name: string; value: string }>; footer?: string } }>;
  let allowed: Set<string>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-choice-life-"));
    store = new SessionStore(path.join(dir, "t.db"));
    posted = [];
    allowed = new Set(["1", "2", "3"]);
    orch = new Orchestrator({
      logger: silent,
      config: { DATA_DIR: dir, DISCORD_ALLOWED_USER_IDS: allowed } as any,
      adapter: {
        async sendChoiceCard(_ch: unknown, card: any) {
          posted.push(card);
          return { channel: { platform: "discord", id: "thread-1" }, id: "msg-1" };
        },
        async editChoiceCard(_msg: unknown, card: any) {
          posted.push(card);
        },
      } as any,
      router: { listProfiles: () => [], describeConfig: () => ({}) } as any,
      store,
      renderer: {} as any,
    });
    store.upsert(record());
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function insertMulti(over: Partial<ChoiceCard> = {}): ChoiceCard {
    const card = makeCard({
      id: "c-multi",
      select: { min: 1, max: 3 },
      options: multiOpts,
      messageId: "msg-1",
      ...over,
    });
    store.insertChoiceCard(card);
    return card;
  }

  it("SELECT stores pending (no emit) and enables Confirm at [min,max]", async () => {
    insertMulti();
    const evt = mockChoiceEvt({
      customId: makeChoiceSelectId("c-multi"),
      kind: "select",
      values: ["0", "2"],
    });
    await (orch as any).handleChoiceCardInteraction(evt);
    expect(evt.ephemeral).toEqual([]);
    const pending = (orch as any).choicePending as Map<string, number[]>;
    expect(pending.get(choicePendingKey("c-multi", "1"))).toEqual([0, 2]);
    const last = posted[posted.length - 1]!;
    expect(last.pendingSelection).toEqual([0, 2]);
    expect(last.hideButtons).toBeFalsy();
    const files = fs.existsSync(path.join(dir, "dispatch", "pending"))
      ? fs.readdirSync(path.join(dir, "dispatch", "pending"))
      : [];
    expect(files.filter((f) => f.endsWith(".json"))).toHaveLength(0);
    expect(store.getChoiceCard("c-multi")?.status).toBe("open");
    expect(choiceSelectionInRange(2, { min: 1, max: 3 })).toBe(true);
  });

  it("CONFIRM emits ONE combined prompt and freezes Selected: …", async () => {
    insertMulti();
    await (orch as any).handleChoiceCardInteraction(
      mockChoiceEvt({
        customId: makeChoiceSelectId("c-multi"),
        kind: "select",
        values: ["0", "2"],
      })
    );
    const confirm = mockChoiceEvt({
      customId: makeChoiceConfirmId("c-multi"),
      kind: "button",
    });
    await (orch as any).handleChoiceCardInteraction(confirm);
    expect(confirm.ephemeral).toEqual([]);
    const pendingDir = path.join(dir, "dispatch", "pending");
    const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const spec = JSON.parse(fs.readFileSync(path.join(pendingDir, files[0]!), "utf8")) as DispatchSpec;
    expect(spec.prompt).toContain("Selected: Loops, Testing");
    expect(spec.prompt).toContain("Cover loops.");
    expect(spec.prompt).toContain("Cover testing.");
    expect(spec.prompt).not.toContain("Cover recursion.");
    const card = store.getChoiceCard("c-multi")!;
    expect(card.status).toBe("exhausted");
    const frozen = posted[posted.length - 1]!;
    expect(frozen.hideButtons).toBe(true);
    expect(frozen.panel.fields.some((f) => /Loops, Testing/.test(f.value))).toBe(true);
    expect((orch as any).choicePending.get(choicePendingKey("c-multi", "1"))).toBeUndefined();
  });

  it("CONFIRM with invalid count nudges and does not emit", async () => {
    insertMulti({ select: { min: 2, max: 3 } });
    const confirm = mockChoiceEvt({
      customId: makeChoiceConfirmId("c-multi"),
      kind: "button",
    });
    await (orch as any).handleChoiceCardInteraction(confirm);
    expect(confirm.ephemeral[0]).toBe(choiceConfirmNudge({ min: 2, max: 3 }));
    expect(store.getChoiceCard("c-multi")?.status).toBe("open");
    const pendingDir = path.join(dir, "dispatch", "pending");
    const files = fs.existsSync(pendingDir) ? fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json")) : [];
    expect(files).toHaveLength(0);
  });

  it("single-select card is unchanged: one select value emits immediately", async () => {
    store.insertChoiceCard(makeCard({ id: "c-single", messageId: "msg-1" }));
    const evt = mockChoiceEvt({
      customId: makeChoiceSelectId("c-single"),
      kind: "select",
      values: ["0"],
    });
    await (orch as any).handleChoiceCardInteraction(evt);
    expect(store.getChoiceCard("c-single")?.status).toBe("exhausted");
    const pendingDir = path.join(dir, "dispatch", "pending");
    const files = fs.readdirSync(pendingDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const spec = JSON.parse(fs.readFileSync(path.join(pendingDir, files[0]!), "utf8")) as DispatchSpec;
    expect(spec.prompt).toContain('option "Approve"');
    expect(spec.prompt).not.toContain("Selected:");
    expect((orch as any).choicePending.size).toBe(0);
  });

  it("participant may select + confirm; targetUserId restricts", async () => {
    insertMulti({ targetUserId: "2" });
    const outsider = mockChoiceEvt({
      customId: makeChoiceSelectId("c-multi"),
      kind: "select",
      values: ["0"],
      userId: "1",
    });
    await (orch as any).handleChoiceCardInteraction(outsider);
    expect(outsider.ephemeral[0]).toMatch(/isn't for you/);
    expect((orch as any).choicePending.size).toBe(0);

    const target = mockChoiceEvt({
      customId: makeChoiceSelectId("c-multi"),
      kind: "select",
      values: ["0", "1"],
      userId: "2",
      userName: "Alaina",
    });
    await (orch as any).handleChoiceCardInteraction(target);
    expect(target.ephemeral).toEqual([]);
    expect((orch as any).choicePending.get(choicePendingKey("c-multi", "2"))).toEqual([0, 1]);

    const confirm = mockChoiceEvt({
      customId: makeChoiceConfirmId("c-multi"),
      kind: "button",
      userId: "2",
      userName: "Alaina",
    });
    await (orch as any).handleChoiceCardInteraction(confirm);
    expect(confirm.ephemeral).toEqual([]);
    expect(store.getChoiceCard("c-multi")?.status).toBe("exhausted");

    store.insertChoiceCard(
      makeCard({
        id: "c-part",
        select: { min: 1, max: 3 },
        options: multiOpts,
        messageId: "msg-2",
        targetUserId: null,
      })
    );
    const part = mockChoiceEvt({
      customId: makeChoiceSelectId("c-part"),
      kind: "select",
      values: ["2"],
      userId: "3",
      userName: "Student",
    });
    await (orch as any).handleChoiceCardInteraction(part);
    expect(part.ephemeral).toEqual([]);
    const partConfirm = mockChoiceEvt({
      customId: makeChoiceConfirmId("c-part"),
      kind: "button",
      userId: "3",
      userName: "Student",
    });
    await (orch as any).handleChoiceCardInteraction(partConfirm);
    expect(partConfirm.ephemeral).toEqual([]);
    expect(store.getChoiceCard("c-part")?.status).toBe("exhausted");
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
