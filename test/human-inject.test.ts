import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { loadConfig } from "../packages/core/src/config.js";
import { humanInboxFrom, scrubDiscordUrls } from "../packages/core/src/core/human-inject.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

// --- pure helpers (#63 attribution + restricted-profile scrub) --------------

describe("humanInboxFrom (#63 attribution via #57)", () => {
  it("prefers the resolved display name, prefixed human:", () => {
    expect(humanInboxFrom("Jesse", "1487094572696867019")).toBe("human:Jesse");
  });

  it("falls back to the author id when no name resolved", () => {
    expect(humanInboxFrom("", "1487094572696867019")).toBe("human:1487094572696867019");
    expect(humanInboxFrom(null, "42")).toBe("human:42");
    expect(humanInboxFrom(undefined, "42")).toBe("human:42");
  });

  it("trims incidental whitespace around the name", () => {
    expect(humanInboxFrom("  Allie ", "9")).toBe("human:Allie");
  });
});

describe("scrubDiscordUrls (#63 restricted-profile scrub)", () => {
  it("removes message links and CDN/attachment URLs", () => {
    const raw =
      "see https://discord.com/channels/1/2/3 and " +
      "https://cdn.discordapp.com/attachments/1/2/x.png?ex=abc";
    const scrubbed = scrubDiscordUrls(raw);
    expect(scrubbed).not.toMatch(/discord\.com|discordapp\.net/);
    expect(scrubbed).toContain("[discord link removed]");
    expect(scrubbed.startsWith("see ")).toBe(true);
  });

  it("leaves non-Discord text and URLs untouched", () => {
    const raw = "check https://example.com/thing and the repo";
    expect(scrubDiscordUrls(raw)).toBe(raw);
  });
});

// --- Orchestrator wiring (pushHumanInbox / mid-turn routing / cmdSteer) ------

let dir: string;
let store: SessionStore;

const record = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  id: "discord:thread-1",
  platform: "discord",
  channelRef: "thread-1",
  parentRef: "channel-1",
  agentId: "claude",
  acpSessionId: "acp-1",
  repoPath: "/repo",
  configJson: "{}",
  createdUtc: new Date().toISOString(),
  updatedUtc: new Date().toISOString(),
  ...over,
});

/** Build an Orchestrator whose store is real and whose router is a controllable
 *  stub. `restrictDiscordAccess` drives getProfile so the scrub path is testable. */
function makeOrch(opts: {
  restrictDiscordAccess?: boolean;
  abortTurn?: ReturnType<typeof vi.fn>;
}) {
  const abortTurn = opts.abortTurn ?? vi.fn(async () => "cancelled");
  const router = {
    listProfiles: () => [],
    ensureSessionRecord: (o: { channelRef: string; parentRef?: string }) =>
      record({
        id: `discord:${o.channelRef}`,
        channelRef: o.channelRef,
        ...(o.parentRef ? { parentRef: o.parentRef } : {}),
      }),
    getProfile: () => ({ restrictDiscordAccess: opts.restrictDiscordAccess ?? false }),
    abortTurn,
  };
  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: dir,
      DISCORD_USER_NAMES: new Map<string, string>(),
      TURN_TIMEOUT_SECONDS: 60,
    } as any,
    adapter: {} as any,
    router: router as any,
    store,
    renderer: {} as any,
  });
  return { orch, router, abortTurn };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-human-inject-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Orchestrator.pushHumanInbox (#63)", () => {
  it("queues the human's text with the given from attribution", () => {
    const { orch } = makeOrch({});
    const res = orch.pushHumanInbox(record(), "human:Jesse", "go check the logs");
    expect(res.queued).toBe(1);
    const listed = store.listInbox("discord:thread-1");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.fromRef).toBe("human:Jesse");
    expect(listed[0]!.body).toBe("go check the logs");
  });

  it("scrubs Discord URLs only for a restrictDiscordAccess target", () => {
    const restricted = makeOrch({ restrictDiscordAccess: true });
    restricted.orch.pushHumanInbox(record(), "human:Jesse", "look at https://discord.com/channels/1/2/3");
    expect(store.listInbox("discord:thread-1")[0]!.body).toBe("look at [discord link removed]");

    store.drainInbox("discord:thread-1");

    const open = makeOrch({ restrictDiscordAccess: false });
    open.orch.pushHumanInbox(record(), "human:Jesse", "look at https://discord.com/channels/1/2/3");
    expect(store.listInbox("discord:thread-1")[0]!.body).toBe("look at https://discord.com/channels/1/2/3");
  });
});

describe("Orchestrator mid-turn reply routing (#63)", () => {
  it("routes a bare mid-turn reply into the inbox, attributed to the human, no abort", async () => {
    const { orch, abortTurn } = makeOrch({});
    const react = vi.fn(async () => {});
    const msg = {
      channel: { platform: "discord", id: "thread-9" },
      authorId: "1487094572696867019",
      authorName: "Jesse",
      authorIsBot: false,
      text: "actually, prioritize the migration",
      raw: { react },
    };
    await (orch as any).routeMidTurnReplyToInbox(msg);

    const listed = store.listInbox("discord:thread-9");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.body).toBe("actually, prioritize the migration");
    expect(listed[0]!.fromRef).toBe("human:Jesse");
    // Cooperative — the running turn is NOT aborted.
    expect(abortTurn).not.toHaveBeenCalled();
    // Light 💬 ack.
    expect(react).toHaveBeenCalledWith("💬");
  });

  it("is a no-op for an attachment-only (textless) reply", async () => {
    const { orch } = makeOrch({});
    await (orch as any).routeMidTurnReplyToInbox({
      channel: { platform: "discord", id: "thread-9" },
      authorId: "42",
      authorName: "Jesse",
      authorIsBot: false,
      text: "   ",
      raw: {},
    });
    expect(store.countInbox("discord:thread-9")).toBe(0);
  });
});

/** Minimal ChatInputCommandInteraction stub for cmdSteer. */
function steerInteraction(opts: { now: boolean; prompt?: string; thread?: string }) {
  const editReply = vi.fn(async () => {});
  const deferReply = vi.fn(async () => {});
  const i = {
    options: {
      getString: (name: string, _req?: boolean) =>
        name === "thread" ? (opts.thread ?? "thread-7") : (opts.prompt ?? "do the thing"),
      getBoolean: (name: string) => (name === "now" ? opts.now : null),
    },
    deferReply,
    editReply,
    user: { id: "1487094572696867019", username: "jbulpitt", globalName: "Jesse" },
    member: null,
  };
  return { i, editReply, deferReply };
}

describe("Orchestrator.cmdSteer now: option (#63)", () => {
  it("now:false (default) → cooperative inbox push, NO cancel", async () => {
    const { orch, abortTurn } = makeOrch({});
    const { i } = steerInteraction({ now: false, prompt: "check the logs", thread: "thread-7" });
    await (orch as any).cmdSteer(i);

    const listed = store.listInbox("discord:thread-7");
    expect(listed).toHaveLength(1);
    expect(listed[0]!.body).toBe("check the logs");
    expect(listed[0]!.fromRef).toBe("human:Jesse");
    // Cooperative: the running turn is never cancelled.
    expect(abortTurn).not.toHaveBeenCalled();
  });

  it("now:true → preemptive cancel-and-reprompt (existing behavior), no inbox push", async () => {
    const abortTurn = vi.fn(async () => "cancelled");
    const { orch } = makeOrch({ abortTurn });
    // Stub the injection/output plumbing so the preemptive branch runs without a
    // real runtime — we only assert it cancels + does NOT push to the inbox.
    (orch as any).queueOnChannel = (_id: string, task: () => Promise<unknown>) => task();
    (orch as any).injectTurn = async () => ({ text: "done", error: undefined });
    (orch as any).postSteerOutput = async () => {};

    const { i } = steerInteraction({ now: true, prompt: "redirect now", thread: "thread-7" });
    await (orch as any).cmdSteer(i);

    expect(abortTurn).toHaveBeenCalledWith("discord:thread-7", { force: false });
    expect(store.countInbox("discord:thread-7")).toBe(0);
  });
});

describe("SEAM_MIDTURN_REPLY_MODE config (#63)", () => {
  const baseEnv = {
    DISCORD_BOT_TOKEN: "x",
    DISCORD_ALLOWED_USER_IDS: "1",
    REPOS_ROOT: os.tmpdir(),
  };

  it("defaults to 'abort' (ships dark — no behavior change)", () => {
    const saved = process.env;
    try {
      process.env = { ...baseEnv } as NodeJS.ProcessEnv;
      expect(loadConfig().SEAM_MIDTURN_REPLY_MODE).toBe("abort");
    } finally {
      process.env = saved;
    }
  });

  it("accepts 'inbox' when explicitly set", () => {
    const saved = process.env;
    try {
      process.env = { ...baseEnv, SEAM_MIDTURN_REPLY_MODE: "inbox" } as NodeJS.ProcessEnv;
      expect(loadConfig().SEAM_MIDTURN_REPLY_MODE).toBe("inbox");
    } finally {
      process.env = saved;
    }
  });
});

describe("SEAM_INBOX_PREAMBLE_ENABLED config (#61)", () => {
  const baseEnv = {
    DISCORD_BOT_TOKEN: "x",
    DISCORD_ALLOWED_USER_IDS: "1",
    REPOS_ROOT: os.tmpdir(),
  };

  it("defaults to false (ships dark — golden preamble unchanged)", () => {
    const saved = process.env;
    try {
      process.env = { ...baseEnv } as NodeJS.ProcessEnv;
      expect(loadConfig().SEAM_INBOX_PREAMBLE_ENABLED).toBe(false);
    } finally {
      process.env = saved;
    }
  });

  it("accepts true when explicitly set", () => {
    const saved = process.env;
    try {
      process.env = { ...baseEnv, SEAM_INBOX_PREAMBLE_ENABLED: "true" } as NodeJS.ProcessEnv;
      expect(loadConfig().SEAM_INBOX_PREAMBLE_ENABLED).toBe(true);
    } finally {
      process.env = saved;
    }
  });
});
