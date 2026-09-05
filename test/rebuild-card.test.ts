import { afterEach, describe, expect, it } from "vitest";
import {
  SIMPLE_FAILURE_LINE,
  SIMPLE_FAILURE_TITLE,
  SIMPLE_SUCCESS_LINE,
  SIMPLE_SUCCESS_TITLE,
  SIMPLE_WORKING_LINE,
  SIMPLE_WORKING_TITLE,
  RebuildCardSession,
  firstErrorLine,
  formatRebuildElapsed,
  panelTextBlob,
  renderRebuildCard,
  type RebuildCardState,
  type RebuildSuccessStats,
  type RebuildWorkingDetails,
  type RebuildWorkingStage,
} from "../packages/core/src/core/rebuild-card.js";

const DETAILS: RebuildWorkingDetails = {
  agentId: "claude",
  model: "claude-opus-4.8",
  contextWindow: 200_000,
  budgetTokens: 120_000,
  discordPosts: 12,
  projectedLogicalCount: 8,
  retainedLogicalCount: 7,
  omittedLogicalCount: 1,
  estimatedTokens: 900,
};

const STATS: RebuildSuccessStats = {
  agentId: "claude",
  model: "claude-opus-4.8",
  contextWindow: 200_000,
  sourcePostCount: 12,
  projectedLogicalCount: 8,
  retainedLogicalCount: 7,
  omittedLogicalCount: 1,
  estimatedTokens: 900,
  budgetTokens: 120_000,
  transformSavedTokens: 40,
  newSessionId: "acp-rebuilt-1",
  attachLine: "🟢 This thread is now bound to `acp-rebuilt-1`.",
};

const T0 = 1_000_000;
const later = (ms: number) => T0 + ms;

function working(
  stage: RebuildWorkingStage,
  now = later(8 * 60_000 + 12_000)
): Extract<RebuildCardState, { kind: "working" }> {
  return { kind: "working", stage, startedAt: T0, now, details: DETAILS };
}

const FORBIDDEN_SIMPLE = [
  /rebuild/i,
  /session/i,
  /token/i,
  /discord/i,
  /claude/i,
  /gpt-/i,
  /grok/i,
  /opus/i,
  /sonnet/i,
  /nothing was lost/i,
  /acp-/i,
  /window \d/i,
  /stack/i,
];

function assertSimpleClean(blob: string): void {
  for (const re of FORBIDDEN_SIMPLE) {
    expect(blob, `simple copy matched ${re}`).not.toMatch(re);
  }
}

describe("formatRebuildElapsed", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatRebuildElapsed(12_000)).toBe("12s");
    expect(formatRebuildElapsed(8 * 60_000 + 12_000)).toBe("8m 12s");
    expect(formatRebuildElapsed(3661_000)).toBe("1h 1m 1s");
  });
});

describe("firstErrorLine", () => {
  it("keeps the message and drops a stack dump", () => {
    const err = new Error("destination window unresolved\n    at seedNewSession (orchestrator.ts:1:1)");
    expect(firstErrorLine(err)).toBe("destination window unresolved");
    expect(firstErrorLine(err)).not.toMatch(/at seedNewSession/);
  });
});

describe("renderRebuildCard — simple", () => {
  it("working stages use the locked purpose-agnostic copy, one stage at a time", () => {
    const fetching = renderRebuildCard("simple", working("fetching"));
    expect(fetching.title).toBe(SIMPLE_WORKING_TITLE);
    expect(fetching.description).toContain(SIMPLE_WORKING_LINE);
    expect(fetching.description).toContain("Looking back through the thread");
    expect(fetching.description).not.toContain("Preparing");
    expect(fetching.footer).toBe("⏱ 8m 12s");
    expect(fetching.fields).toEqual([]);
    assertSimpleClean(panelTextBlob(fetching));

    const assembled = renderRebuildCard("simple", working("assembled"));
    expect(assembled.description).toContain("Preparing");
    expect(assembled.description).not.toContain("Looking back through the thread");
    assertSimpleClean(panelTextBlob(assembled));

    const seeding = renderRebuildCard("simple", working("seeding"));
    expect(seeding.description).toContain("Loading it back in");
    assertSimpleClean(panelTextBlob(seeding));

    const attaching = renderRebuildCard("simple", working("attaching"));
    expect(attaching.description).toContain("Finishing");
    assertSimpleClean(panelTextBlob(attaching));
  });

  it("freezes success and failure without forbidden words or buttons", () => {
    const ok = renderRebuildCard("simple", {
      kind: "success",
      startedAt: T0,
      now: later(5000),
      stats: STATS,
    });
    expect(ok.title).toBe(SIMPLE_SUCCESS_TITLE);
    expect(ok.description).toBe(SIMPLE_SUCCESS_LINE);
    expect(ok.actions).toEqual([]);
    assertSimpleClean(panelTextBlob(ok));

    const fail = renderRebuildCard("simple", {
      kind: "failure",
      startedAt: T0,
      now: later(5000),
      error: "destination window unresolved\n    at seed (x.ts:1)",
    });
    expect(fail.title).toBe(SIMPLE_FAILURE_TITLE);
    expect(fail.description).toBe(SIMPLE_FAILURE_LINE);
    expect(fail.actions).toEqual([]);
    assertSimpleClean(panelTextBlob(fail));
    expect(panelTextBlob(fail)).not.toContain("destination window");
  });
});

describe("renderRebuildCard — full", () => {
  it("working stages carry destination, fetch, projection, and seed/attach labels", () => {
    const start = renderRebuildCard("full", working("starting", T0));
    expect(start.title).toBe("Rebuild");
    expect(start.description).toContain("claude · claude-opus-4.8 · window 200000 · 60% budget 120000");
    expect(start.footer).toContain("Resolving destination");

    const fetch = renderRebuildCard("full", working("fetching"));
    expect(fetch.description).toMatch(/Fetched 12 Discord posts/);
    expect(fetch.footer).toContain("Fetching Discord history");

    const assembled = renderRebuildCard("full", working("assembled"));
    expect(assembled.description).toContain("projected 8 logical");
    expect(assembled.description).toContain("retained 7");
    expect(assembled.description).toContain("~900 tokens");

    const seeding = renderRebuildCard("full", working("seeding"));
    expect(seeding.description).toBe("Seeding new session");
    expect(seeding.footer).toContain("Seeding new session");

    const attaching = renderRebuildCard("full", working("attaching"));
    expect(attaching.description).toBe("Attaching");
  });

  it("success lists destination, posts, retained/omitted, seed tokens, session id, attach", () => {
    const ok = renderRebuildCard("full", {
      kind: "success",
      startedAt: T0,
      now: later(5000),
      stats: STATS,
    });
    expect(ok.title).toBe("Rebuild complete");
    const blob = panelTextBlob(ok);
    expect(blob).toContain("claude");
    expect(blob).toContain("claude-opus-4.8");
    expect(blob).toContain("window 200000");
    expect(blob).toContain("12 posts → logical 8");
    expect(blob).toContain("7 retained, 1 omitted");
    expect(blob).toContain("900 / 120000 tokens");
    expect(blob).toContain("acp-rebuilt-1");
    expect(blob).toContain("now bound");
    expect(ok.actions).toEqual([]);
  });

  it("failure shows the error message without a stack dump", () => {
    const fail = renderRebuildCard("full", {
      kind: "failure",
      startedAt: T0,
      now: later(3000),
      error: firstErrorLine(
        new Error("Rebuild stopped: Discord history exceeded the page cap\n    at walkThread")
      ),
    });
    expect(fail.title).toBe("Rebuild failed");
    expect(fail.description).toBe("Rebuild stopped: Discord history exceeded the page cap");
    expect(fail.description).not.toMatch(/at walkThread/);
    expect(fail.actions).toEqual([]);
  });
});

describe("RebuildCardSession", () => {
  afterEach(() => {
    // sessions dispose in each test
  });

  it("posts, edits through stages, heartbeats elapsed during seed, freezes success", async () => {
    const posts: unknown[] = [];
    const edits: Array<{ footer?: string; description?: string; title?: string }> = [];
    let now = T0;
    const session = new RebuildCardSession(
      "full",
      {
        post: async (panel) => {
          posts.push(panel);
          return { id: "card-1" };
        },
        edit: async (_ref, panel) => {
          edits.push(panel);
        },
      },
      { now: () => now, debounceMs: 5, heartbeatMs: 20 }
    );
    expect(await session.start({ agentId: "claude", model: "opus", contextWindow: 1, budgetTokens: 1 })).toBe(true);
    expect(posts).toHaveLength(1);
    expect((posts[0] as { title?: string }).title).toBe("Rebuild");

    await session.setStage("fetching", { discordPosts: 2 });
    await session.setStage("assembled", {
      projectedLogicalCount: 1,
      retainedLogicalCount: 1,
      omittedLogicalCount: 0,
      estimatedTokens: 10,
    });
    await session.setStage("seeding");
    const beforeBeat = edits.length;
    now += 8_000;
    await new Promise((r) => setTimeout(r, 50));
    expect(edits.length).toBeGreaterThan(beforeBeat);
    expect(edits.at(-1)?.footer).toMatch(/⏱ 8s/);
    expect(edits.at(-1)?.description).toBe("Seeding new session");

    await session.setStage("attaching");
    await session.succeed(STATS);
    expect(edits.at(-1)?.title).toBe("Rebuild complete");
    expect(edits.at(-1)?.title).not.toBeUndefined();
    session.dispose();
  });

  it("freezes failure after a posted working card", async () => {
    const edits: Array<{ title?: string; description?: string }> = [];
    const session = new RebuildCardSession(
      "simple",
      {
        post: async () => ({ id: "c" }),
        edit: async (_ref, panel) => {
          edits.push(panel);
        },
      },
      { heartbeatMs: 60_000 }
    );
    await session.start({});
    await session.setStage("fetching");
    await session.fail(firstErrorLine(new Error("boom\n    at x")));
    expect(edits.at(-1)?.title).toBe(SIMPLE_FAILURE_TITLE);
    expect(edits.at(-1)?.description).toBe(SIMPLE_FAILURE_LINE);
    session.dispose();
  });
});
