import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { MessageFlags } from "discord.js";
import { Orchestrator, prefixThreadNameWithAgentEmoji } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { PARTICIPANT_CONFIG_REFUSAL } from "../packages/core/src/config.js";
import {
  THREAD_LIMIT_MESSAGE,
  formatKeycap,
} from "../packages/core/src/platforms/discord/thread-naming.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { Preset, SessionRecord } from "../packages/core/src/core/types.js";
import type { ChannelRef } from "../packages/core/src/platforms/chat-adapter.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const ADMIN = "1487094572696867019";
const STUDENT = "1534937951044112505";
const OPERATOR = "111";

let dir: string;
let store: SessionStore;

const now = "2026-08-22T00:00:00.000Z";

function preset(over: Partial<Preset> & { name: string }): Preset {
  return {
    id: over.id ?? `p-${over.name}`,
    name: over.name,
    projectRef: over.projectRef ?? "chan-1",
    description: over.description ?? null,
    agentId: over.agentId ?? "grok",
    model: over.model ?? "grok-4",
    effort: over.effort ?? "high",
    repoPath: over.repoPath ?? "/repo/special",
    threadSlug: over.threadSlug ?? null,
    permission: over.permission ?? "ask",
    toolsAllow: over.toolsAllow ?? null,
    toolsExclude: over.toolsExclude ?? null,
    instructions: over.instructions ?? "Be a specialist.",
    statusCardStyle: over.statusCardStyle ?? null,
    createdBy: "admin",
    createdUtc: now,
    updatedUtc: now,
  };
}

function slashI(over: {
  group?: string | null;
  sub: string;
  userId?: string;
  channelId?: string;
  isThread?: boolean;
  parentId?: string;
  strings?: Record<string, string | null>;
  ints?: Record<string, number | null>;
}) {
  const replies: Array<{ content?: string; flags?: number }> = [];
  const edits: string[] = [];
  const i = {
    options: {
      getSubcommand: () => over.sub,
      getSubcommandGroup: (_req?: boolean) => over.group ?? null,
      getString: (name: string, _req?: boolean) => over.strings?.[name] ?? null,
      getInteger: (name: string, _req?: boolean) => over.ints?.[name] ?? null,
    },
    user: { id: over.userId ?? ADMIN },
    channelId: over.channelId ?? "chan-1",
    channel: {
      isThread: () => over.isThread === true,
      parentId: over.parentId,
    },
    reply: vi.fn(async (payload: { content?: string; flags?: number }) => {
      replies.push(payload);
    }),
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async (content: string) => {
      edits.push(content);
    }),
  };
  return { i, replies, edits };
}

function autocompleteI(over: {
  group?: string | null;
  sub?: string | null;
  option?: string;
  value?: string;
  channelId?: string;
  isThread?: boolean;
  parentId?: string;
  respond?: (choices: unknown[]) => Promise<void>;
}) {
  const responded: unknown[][] = [];
  const i = {
    options: {
      getSubcommandGroup: (_req?: boolean) => over.group ?? "preset",
      getSubcommand: (_req?: boolean) => over.sub ?? "thread",
      getFocused: (_full?: boolean) => ({
        name: over.option ?? "preset",
        value: over.value ?? "",
        focused: true as const,
      }),
    },
    channelId: over.channelId ?? "chan-1",
    channel: {
      isThread: () => over.isThread === true,
      parentId: over.parentId,
    },
    responded: false,
    respond: vi.fn(async (choices: unknown[]) => {
      responded.push(choices);
      i.responded = true;
      if (over.respond) await over.respond(choices);
    }),
  };
  return { i, responded };
}

function sessionRow(over: { id: string; parentRef?: string; agentId?: string }): SessionRecord {
  return {
    id: `discord:${over.id}`,
    platform: "discord",
    channelRef: over.id,
    parentRef: over.parentRef ?? "chan-1",
    agentId: over.agentId ?? "grok",
    acpSessionId: "",
    repoPath: "/repo",
    configJson: "{}",
    createdUtc: now,
    updatedUtc: now,
  };
}

function makeOrch(over?: {
  createThread?: (parent: ChannelRef, name: string) => Promise<ChannelRef>;
  participantIds?: Set<string>;
  adminIds?: Set<string>;
  locked?: boolean;
  listPresetsForProject?: SessionStore["listPresetsForProject"];
  channelPresets?: Map<string, { locked?: boolean; threadSlug?: { value: string } }>;
  threadPresets?: Map<string, { threadSlug?: { value: string } }>;
  threadNames?: Map<string, string>;
  getThreadName?: (ch: ChannelRef) => Promise<string | undefined>;
  addThreadMember?: (ch: ChannelRef, userId: string) => Promise<void>;
}) {
  const created: Array<{ parent: ChannelRef; name: string }> = [];
  const renamed: Array<{ id: string; name: string }> = [];
  const addedMembers: Array<{ id: string; userId: string }> = [];
  const sent: Array<{ id: string; text: string }> = [];
  const openingTurns: Array<{ id: string; prompt: string; authorId: string }> = [];
  const threadNames = over?.threadNames ?? new Map<string, string>();
  const router = {
    listProfiles: () => [{ id: "grok", threadAbbr: "🌌" }, { id: "copilot", threadAbbr: "🤖🛢️" }],
    describeConfig: () => ({}),
    ensureSessionRecord: (opts: {
      platform: string;
      channelRef: string;
      parentRef?: string;
      cwd: string;
    }): SessionRecord => {
      const rec: SessionRecord = {
        id: `discord:${opts.channelRef}`,
        platform: opts.platform,
        channelRef: opts.channelRef,
        parentRef: opts.parentRef ?? null,
        agentId: "copilot",
        acpSessionId: "",
        repoPath: opts.cwd,
        configJson: JSON.stringify({ model: "default-model" }),
        createdUtc: now,
        updatedUtc: now,
      };
      store.upsert(rec);
      return rec;
    },
    getProfile: (id: string) => {
      if (id === "grok") {
        return {
          id: "grok",
          threadAbbr: "🌌",
          defaultModel: "grok-4",
          effort: { levels: ["low", "medium", "high"] },
        };
      }
      return { id, threadAbbr: "🤖🛢️", defaultModel: "default-model", effort: { levels: [] } };
    },
    invalidate: vi.fn(async () => {}),
  };
  let createdSeq = 0;
  const createThread =
    over?.createThread ??
    (async (parent: ChannelRef, name: string): Promise<ChannelRef> => {
      created.push({ parent, name });
      createdSeq += 1;
      const id = createdSeq === 1 ? "thread-new" : `thread-new-${createdSeq}`;
      threadNames.set(id, name);
      return {
        platform: "discord",
        id,
        parentId: parent.id.startsWith("thread") ? "chan-1" : parent.id,
      };
    });
  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: "/repo",
      TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_MODEL: "default-model",
      DEFAULT_AGENT: "copilot",
      CHANNEL_PRESETS_FILE: undefined,
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      REPO_EMOJIS: new Map(),
      channelPresets:
        over?.channelPresets ??
        new Map(over?.locked ? [["chan-1", { locked: true }]] : []),
      threadPresets: over?.threadPresets ?? new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: over?.adminIds ?? new Set([ADMIN]),
      SEAM_PARTICIPANT_USER_IDS: over?.participantIds,
    } as any,
    adapter: {
      createThread,
      getThreadName: over?.getThreadName ?? (async (ch: ChannelRef) => threadNames.get(ch.id)),
      renameThread: async (ch: ChannelRef, name: string) => {
        renamed.push({ id: ch.id, name });
        threadNames.set(ch.id, name);
      },
      addThreadMember:
        over?.addThreadMember ??
        (async (ch: ChannelRef, userId: string) => {
          addedMembers.push({ id: ch.id, userId });
        }),
      sendMessage: async (ch: ChannelRef, text: string) => {
        sent.push({ id: ch.id, text });
        return { id: "msg-1", channel: ch };
      },
    } as any,
    router: router as any,
    store: over?.listPresetsForProject
      ? new Proxy(store, {
          get(target, prop, receiver) {
            if (prop === "listPresetsForProject") return over.listPresetsForProject;
            return Reflect.get(target, prop, receiver);
          },
        })
      : store,
    renderer: {} as any,
  });
  (orch as any).startPresetOpeningTurn = (
    thread: ChannelRef,
    _record: SessionRecord,
    p: Preset,
    authorId: string
  ) => {
    const prompt = (p.instructions ?? "").trim();
    if (!prompt) return;
    openingTurns.push({ id: thread.id, prompt, authorId });
  };
  return { orch, created, renamed, addedMembers, sent, router, threadNames, openingTurns };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-preset-thread-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("prefixThreadNameWithAgentEmoji", () => {
  it("prefixes the agent threadAbbr (emoji) onto the user name", () => {
    expect(prefixThreadNameWithAgentEmoji("review-pr", "🌌")).toBe("🌌 review-pr");
  });

  it("does not double-prefix", () => {
    expect(prefixThreadNameWithAgentEmoji("🌌 review-pr", "🌌")).toBe("🌌 review-pr");
  });

  it("falls back to the trimmed name when no abbr", () => {
    expect(prefixThreadNameWithAgentEmoji("  review-pr  ", null)).toBe("review-pr");
    expect(prefixThreadNameWithAgentEmoji("", "🌌")).toBe("🌌 seam");
  });
});

describe("/seam preset thread handler (#93)", () => {
  it("pick + name → thread named <emoji> <name> whose session has the preset config", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", model: "grok-4" }));
    const { orch, created, router } = makeOrch();
    const { i, edits } = slashI({
      group: "preset",
      sub: "thread",
      strings: { name: "review-pr", preset: "reviewer" },
    });
    await (orch as any).cmdPresetThread(i);

    expect(created).toHaveLength(1);
    expect(created[0]!.name).toBe("🌌 review-pr");
    // D2: parent is the invocation channel (adapter walks up if it's a thread).
    expect(created[0]!.parent).toEqual({ platform: "discord", id: "chan-1" });
    expect(edits[0]).toMatch(/Created <#thread-new> from preset \*\*reviewer\*\*/);

    const rec = store.get("discord:thread-new");
    expect(rec).not.toBeNull();
    expect(rec!.agentId).toBe("grok");
    expect(rec!.repoPath).toBe("/repo/special");
    const cfg = store.readConfig(rec!);
    expect(cfg.model).toBe("grok-4");
    expect(cfg.reasoningEffort).toBe("high");
    expect(cfg.permissionPolicy).toBe("ask");
    // First turn starts fresh against the preset (ACP binding dropped).
    expect(rec!.acpSessionId).toBe("");
    expect(router.invalidate).toHaveBeenCalled();
  });

  it("applies statusCardStyle from the preset into session config (#96)", async () => {
    store.upsertPreset(
      preset({ name: "quiet-card", agentId: "grok", statusCardStyle: "simple" })
    );
    const { orch } = makeOrch();
    const { i } = slashI({
      group: "preset",
      sub: "thread",
      strings: { name: "quiet", preset: "quiet-card" },
    });
    await (orch as any).cmdPresetThread(i);
    const rec = store.get("discord:thread-new");
    expect(store.readConfig(rec!).statusCardStyle).toBe("simple");
  });

  it("unknown preset at submit → friendly ephemeral refusal (no thread)", async () => {
    const { orch, created } = makeOrch();
    const { i, replies } = slashI({
      group: "preset",
      sub: "thread",
      strings: { name: "review-pr", preset: "ghost" },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created).toHaveLength(0);
    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(replies[0]?.content).toMatch(/No preset named `ghost`/i);
  });

  it("blank preset at submit → friendly refusal", async () => {
    const { orch, created } = makeOrch();
    const { i, replies } = slashI({
      group: "preset",
      sub: "thread",
      strings: { name: "review-pr", preset: "   " },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created).toHaveLength(0);
    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(replies[0]?.content).toMatch(/can't be blank/i);
  });

  it("invoked inside a thread still creates under that channel id (adapter walks to parent)", async () => {
    store.upsertPreset(preset({ name: "reviewer" }));
    const { orch, created } = makeOrch();
    const { i } = slashI({
      group: "preset",
      sub: "thread",
      channelId: "thread-old",
      isThread: true,
      parentId: "chan-1",
      strings: { name: "sib", preset: "reviewer" },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created[0]!.parent.id).toBe("thread-old");
  });
});

describe("/seam preset thread slash routing + gates (#93)", () => {
  it("restricted participant is refused before the handler", async () => {
    store.upsertPreset(preset({ name: "reviewer" }));
    const { orch, created } = makeOrch({
      participantIds: new Set([STUDENT]),
    });
    const { i, replies } = slashI({
      group: "preset",
      sub: "thread",
      userId: STUDENT,
      strings: { name: "x", preset: "reviewer" },
    });
    await orch.handleSlashInteraction(i as any);
    expect(created).toHaveLength(0);
    expect(replies[0]?.content).toBe(PARTICIPANT_CONFIG_REFUSAL);
    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
  });

  it("admin OK in a locked channel; creates the thread", async () => {
    store.upsertPreset(preset({ name: "reviewer" }));
    const { orch, created } = makeOrch({ locked: true });
    const { i, edits } = slashI({
      group: "preset",
      sub: "thread",
      userId: ADMIN,
      strings: { name: "locked-ok", preset: "reviewer" },
    });
    await orch.handleSlashInteraction(i as any);
    expect(created).toHaveLength(1);
    expect(created[0]!.name).toBe("🌌 locked-ok");
    expect(edits[0]).toMatch(/Created <#thread-new>/);
  });

  it("non-admin refused in a locked channel", async () => {
    store.upsertPreset(preset({ name: "reviewer" }));
    const { orch, created } = makeOrch({ locked: true });
    const { i, replies } = slashI({
      group: "preset",
      sub: "thread",
      userId: OPERATOR,
      strings: { name: "nope", preset: "reviewer" },
    });
    await orch.handleSlashInteraction(i as any);
    expect(created).toHaveLength(0);
    expect(replies[0]?.content).toMatch(/locked/i);
    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
  });

  it("existing preset list/apply routing is unaffected", async () => {
    const { orch } = makeOrch();
    const seen: string[] = [];
    (orch as any).cmdPresetList = async () => {
      seen.push("list");
    };
    (orch as any).cmdPresetApply = async () => {
      seen.push("apply");
    };
    (orch as any).cmdPresetDelete = async () => {
      seen.push("delete");
    };
    (orch as any).cmdPresetCreate = async () => {
      seen.push("create");
    };
    for (const sub of ["list", "create", "apply", "delete"]) {
      const { i } = slashI({ group: "preset", sub, userId: ADMIN });
      await orch.handleSlashInteraction(i as any);
    }
    expect(seen).toEqual(["list", "create", "apply", "delete"]);
  });
});

describe("preset thread autocomplete (#93)", () => {
  it("typing shows matching project presets (≤25)", async () => {
    store.upsertPreset(preset({ name: "reviewer", projectRef: "chan-1" }));
    store.upsertPreset(preset({ id: "p-writer", name: "writer", projectRef: "chan-1", agentId: "claude" }));
    store.upsertPreset(preset({ id: "p-global", name: "review-global", projectRef: null }));
    store.upsertPreset(preset({ id: "p-other", name: "review-other", projectRef: "chan-2" }));
    const { orch } = makeOrch();
    const { i, responded } = autocompleteI({ value: "rev" });
    await orch.handleAutocompleteInteraction(i as any);
    expect(responded).toHaveLength(1);
    const names = (responded[0] as Array<{ name: string }>).map((c) => c.name);
    expect(names).toEqual(["review-global", "reviewer"]);
    expect(names).not.toContain("review-other");
    expect(names).not.toContain("writer");
  });

  it("empty scope → nothing to pick", async () => {
    store.upsertPreset(preset({ name: "reviewer" }));
    const { orch } = makeOrch();
    const { i, responded } = autocompleteI({ channelId: undefined as unknown as string, value: "rev" });
    // Simulate a missing channel entirely.
    (i as any).channelId = undefined;
    (i as any).channel = undefined;
    await orch.handleAutocompleteInteraction(i as any);
    expect(responded[0]).toEqual([]);
  });

  it("apply/delete/show/edit name return the same project-scoped presets as thread", async () => {
    store.upsertPreset(preset({ name: "reviewer", projectRef: "chan-1" }));
    store.upsertPreset(preset({ id: "p-writer", name: "writer", projectRef: "chan-1", agentId: "claude" }));
    store.upsertPreset(preset({ id: "p-global", name: "review-global", projectRef: null }));
    store.upsertPreset(preset({ id: "p-other", name: "review-other", projectRef: "chan-2" }));
    const { orch } = makeOrch();
    const expected = ["review-global", "reviewer"];
    for (const sub of ["apply", "delete", "show", "edit"] as const) {
      const { i, responded } = autocompleteI({
        group: "preset",
        sub,
        option: "name",
        value: "rev",
      });
      await orch.handleAutocompleteInteraction(i as any);
      expect(responded).toHaveLength(1);
      const names = (responded[0] as Array<{ name: string }>).map((c) => c.name);
      expect(names, sub).toEqual(expected);
      expect(names).not.toContain("review-other");
      expect(names).not.toContain("writer");
    }
  });

  it("create name is not autocompleted (new name stays free-form)", async () => {
    store.upsertPreset(preset({ name: "reviewer", projectRef: "chan-1" }));
    const { orch } = makeOrch();
    const { i, responded } = autocompleteI({
      group: "preset",
      sub: "create",
      option: "name",
      value: "rev",
    });
    await orch.handleAutocompleteInteraction(i as any);
    expect(responded[0]).toEqual([]);
  });

  it("unknown option / group → [] (does not throw)", async () => {
    const { orch } = makeOrch();
    const { i, responded } = autocompleteI({ group: "preset", sub: "apply", option: "bogus", value: "x" });
    await orch.handleAutocompleteInteraction(i as any);
    expect(responded[0]).toEqual([]);
  });

  it("store throw → respond [] and does not reject", async () => {
    const { orch } = makeOrch({
      listPresetsForProject: () => {
        throw new Error("db down");
      },
    });
    const { i, responded } = autocompleteI({ value: "rev" });
    await expect(orch.handleAutocompleteInteraction(i as any)).resolves.toBeUndefined();
    expect(responded[0]).toEqual([]);
  });
});

function seedNamedSibling(id: string, name: string, names: Map<string, string>): void {
  store.upsert(sessionRow({ id }));
  names.set(id, name);
}

describe("/seam preset thread auto-name from slug", () => {
  it("omit name + preset slug → [abbr] [slug] [1️⃣]", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const { orch, created } = makeOrch();
    const { i, edits } = slashI({
      group: "preset",
      sub: "thread",
      strings: { preset: "reviewer" },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created).toHaveLength(1);
    expect(created[0]!.name).toBe(`🌌 hist ${formatKeycap(1)}`);
    expect(edits[0]).toMatch(/Created <#thread-new> from preset \*\*reviewer\*\*/);
  });

  it("fills the lowest unused number among slug-matching siblings ({1,2,3,4,6} → 5)", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const names = new Map<string, string>();
    for (const n of [1, 2, 3, 4, 6]) {
      seedNamedSibling(`sib-${n}`, `🌌 hist ${formatKeycap(n)}`, names);
    }
    seedNamedSibling("other", "custom title", names);
    const { orch, created } = makeOrch({ threadNames: names });
    const { i } = slashI({
      group: "preset",
      sub: "thread",
      strings: { preset: "reviewer" },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created[0]!.name).toBe(`🌌 hist ${formatKeycap(5)}`);
  });

  it("9 slug-matching threads already exist → friendly limit, no create", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const names = new Map<string, string>();
    for (let n = 1; n <= 9; n++) {
      seedNamedSibling(`sib-${n}`, `🌌 hist ${formatKeycap(n)}`, names);
    }
    const { orch, created } = makeOrch({ threadNames: names });
    const { i, edits } = slashI({
      group: "preset",
      sub: "thread",
      strings: { preset: "reviewer" },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created).toHaveLength(0);
    expect(edits[0]).toContain(THREAD_LIMIT_MESSAGE);
  });

  it("omit name with no slug configured → require a name, no create", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok" }));
    const { orch, created } = makeOrch();
    const { i, edits } = slashI({
      group: "preset",
      sub: "thread",
      strings: { preset: "reviewer" },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created).toHaveLength(0);
    expect(edits[0]).toMatch(/Give the new thread a name/i);
  });

  it("acknowledges Discord before a slow sibling-name scan", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    store.upsert(sessionRow({ id: "slow-sibling" }));
    let releaseLookup!: (name: string | undefined) => void;
    const lookup = new Promise<string | undefined>((resolve) => {
      releaseLookup = resolve;
    });
    const getThreadName = vi.fn(async () => lookup);
    const { orch } = makeOrch({ getThreadName });
    const { i } = slashI({
      group: "preset",
      sub: "thread",
      strings: { preset: "reviewer" },
    });

    const run = (orch as any).cmdPresetThread(i);
    await vi.waitFor(() => expect(getThreadName).toHaveBeenCalledOnce());
    expect(i.deferReply).toHaveBeenCalledOnce();
    releaseLookup(undefined);
    await run;
  });

  it("channel-preset slug is used when the DB preset has none", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok" }));
    const { orch, created } = makeOrch({
      channelPresets: new Map([["chan-1", { threadSlug: { value: "lab" } }]]),
    });
    const { i } = slashI({
      group: "preset",
      sub: "thread",
      strings: { preset: "reviewer" },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created[0]!.name).toBe(`🌌 lab ${formatKeycap(1)}`);
  });

  it("DB preset slug wins over the channel-preset slug", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const { orch, created } = makeOrch({
      channelPresets: new Map([["chan-1", { threadSlug: { value: "lab" } }]]),
    });
    const { i } = slashI({
      group: "preset",
      sub: "thread",
      strings: { preset: "reviewer" },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created[0]!.name).toBe(`🌌 hist ${formatKeycap(1)}`);
  });

  it("explicit name still wins when a slug is set (no auto-number)", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const { orch, created, renamed } = makeOrch();
    const { i } = slashI({
      group: "preset",
      sub: "thread",
      strings: { name: "review-pr", preset: "reviewer" },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created[0]!.name).toBe("🌌 review-pr");
    expect(renamed).toEqual([]);
  });
});

describe("applyPresetToSession slug rename", () => {
  it("empty/default name allocates the next number, excluding self", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const names = new Map<string, string>([["thread-1", "seam"]]);
    store.upsert(sessionRow({ id: "thread-1" }));
    seedNamedSibling("sib-1", `🌌 hist ${formatKeycap(1)}`, names);
    seedNamedSibling("sib-2", `🌌 hist ${formatKeycap(2)}`, names);
    const { orch, renamed } = makeOrch({ threadNames: names });
    const summary = await (orch as any).applyPresetToSession(
      { platform: "discord", id: "thread-1", parentId: "chan-1" },
      store.get("discord:thread-1")!,
      store.getPresetByNameScoped("reviewer", "chan-1")!
    );
    expect(renamed).toEqual([{ id: "thread-1", name: `🌌 hist ${formatKeycap(3)}` }]);
    expect(summary).not.toMatch(/limit/);
  });

  it("keeps an existing [slug] [n] (reformats abbr, does not reallocate)", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const names = new Map<string, string>([["thread-1", `hist ${formatKeycap(3)}`]]);
    store.upsert(sessionRow({ id: "thread-1" }));
    for (const n of [1, 2, 4]) {
      seedNamedSibling(`sib-${n}`, `🌌 hist ${formatKeycap(n)}`, names);
    }
    const { orch, renamed } = makeOrch({ threadNames: names });
    await (orch as any).applyPresetToSession(
      { platform: "discord", id: "thread-1", parentId: "chan-1" },
      store.get("discord:thread-1")!,
      store.getPresetByNameScoped("reviewer", "chan-1")!
    );
    expect(renamed).toEqual([{ id: "thread-1", name: `🌌 hist ${formatKeycap(3)}` }]);
  });

  it("does not clobber a custom non-matching name", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const names = new Map<string, string>([["thread-1", "my custom review"]]);
    store.upsert(sessionRow({ id: "thread-1" }));
    const { orch, renamed } = makeOrch({ threadNames: names });
    await (orch as any).applyPresetToSession(
      { platform: "discord", id: "thread-1", parentId: "chan-1" },
      store.get("discord:thread-1")!,
      store.getPresetByNameScoped("reviewer", "chan-1")!
    );
    expect(renamed).toEqual([]);
  });

  it("9 siblings taken + empty name → limit note, no rename", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const names = new Map<string, string>([["thread-1", "seam"]]);
    store.upsert(sessionRow({ id: "thread-1" }));
    for (let n = 1; n <= 9; n++) {
      seedNamedSibling(`sib-${n}`, `🌌 hist ${formatKeycap(n)}`, names);
    }
    const { orch, renamed } = makeOrch({ threadNames: names });
    const summary = await (orch as any).applyPresetToSession(
      { platform: "discord", id: "thread-1", parentId: "chan-1" },
      store.get("discord:thread-1")!,
      store.getPresetByNameScoped("reviewer", "chan-1")!
    );
    expect(renamed).toEqual([]);
    expect(summary).toContain(THREAD_LIMIT_MESSAGE);
  });
});

describe("/seam preset thread quantity", () => {
  it("quantity 3 allocates sequential free numbers and links each thread", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const names = new Map<string, string>();
    seedNamedSibling("sib-1", `🌌 hist ${formatKeycap(1)}`, names);
    seedNamedSibling("sib-2", `🌌 hist ${formatKeycap(2)}`, names);
    const { orch, created, openingTurns } = makeOrch({ threadNames: names });
    const { i, edits } = slashI({
      group: "preset",
      sub: "thread",
      strings: { preset: "reviewer" },
      ints: { quantity: 3 },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created.map((c) => c.name)).toEqual([
      `🌌 hist ${formatKeycap(3)}`,
      `🌌 hist ${formatKeycap(4)}`,
      `🌌 hist ${formatKeycap(5)}`,
    ]);
    expect(edits[0]).toMatch(/Created 3 threads from preset \*\*reviewer\*\*/);
    expect(edits[0]).toContain("<#thread-new>");
    expect(edits[0]).toContain("<#thread-new-2>");
    expect(edits[0]).toContain("<#thread-new-3>");
    expect(openingTurns).toHaveLength(3);
    expect(openingTurns.every((t) => t.prompt === "Be a specialist.")).toBe(true);
  });

  it("quantity > remaining slots creates what fits and reports K of N", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const names = new Map<string, string>();
    for (let n = 1; n <= 8; n++) {
      seedNamedSibling(`sib-${n}`, `🌌 hist ${formatKeycap(n)}`, names);
    }
    const { orch, created } = makeOrch({ threadNames: names });
    const { i, edits } = slashI({
      group: "preset",
      sub: "thread",
      strings: { preset: "reviewer" },
      ints: { quantity: 3 },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created).toHaveLength(1);
    expect(created[0]!.name).toBe(`🌌 hist ${formatKeycap(9)}`);
    expect(edits[0]).toMatch(/Created 1 of 3 from preset \*\*reviewer\*\*/);
    expect(edits[0]).toMatch(/the limit \(9\) for this kind of thread was reached/);
  });

  it("quantity > 1 with no slug refuses before creating", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok" }));
    const { orch, created } = makeOrch();
    const { i, edits } = slashI({
      group: "preset",
      sub: "thread",
      strings: { preset: "reviewer", name: "ignored" },
      ints: { quantity: 3 },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created).toHaveLength(0);
    expect(edits[0]).toMatch(/multiple threads need a preset slug/i);
  });

  it("quantity 9 with an empty channel fills 1–9 and never a 10th", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const { orch, created } = makeOrch();
    const { i, edits } = slashI({
      group: "preset",
      sub: "thread",
      strings: { preset: "reviewer" },
      ints: { quantity: 9 },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created).toHaveLength(9);
    expect(created.map((c) => c.name)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `🌌 hist ${formatKeycap(n)}`)
    );
    expect(edits[0]).toMatch(/Created 9 threads from preset \*\*reviewer\*\*/);
    expect(edits[0]).not.toMatch(/limit/);
  });

  it("quantity above 9 is clamped to 9", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const { orch, created } = makeOrch();
    const { i } = slashI({
      group: "preset",
      sub: "thread",
      strings: { preset: "reviewer" },
      ints: { quantity: 99 },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created).toHaveLength(9);
  });

  it("quantity > 1 ignores the name option and auto-numbers", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const { orch, created } = makeOrch();
    const { i } = slashI({
      group: "preset",
      sub: "thread",
      strings: { preset: "reviewer", name: "custom-title" },
      ints: { quantity: 2 },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created.map((c) => c.name)).toEqual([
      `🌌 hist ${formatKeycap(1)}`,
      `🌌 hist ${formatKeycap(2)}`,
    ]);
  });
});

describe("preset thread opening turn from instructions", () => {
  it("kicks off a live first turn with the preset instructions after spawn", async () => {
    store.upsertPreset(
      preset({ name: "reviewer", agentId: "grok", threadSlug: "hist", instructions: "Start the lab." })
    );
    const { orch, openingTurns } = makeOrch();
    const { i } = slashI({
      group: "preset",
      sub: "thread",
      userId: ADMIN,
      strings: { preset: "reviewer" },
    });
    await (orch as any).cmdPresetThread(i);
    expect(openingTurns).toEqual([
      { id: "thread-new", prompt: "Start the lab.", authorId: ADMIN },
    ]);
  });

  it("does not start a turn when instructions are empty", async () => {
    store.upsertPreset(
      preset({ name: "reviewer", agentId: "grok", threadSlug: "hist", instructions: "   " })
    );
    const { orch, openingTurns } = makeOrch();
    const { i } = slashI({
      group: "preset",
      sub: "thread",
      strings: { preset: "reviewer" },
    });
    await (orch as any).cmdPresetThread(i);
    expect(openingTurns).toEqual([]);
  });

  it("does not start a turn on /seam preset apply", async () => {
    store.upsertPreset(
      preset({ name: "reviewer", agentId: "grok", threadSlug: "hist", instructions: "Start the lab." })
    );
    const names = new Map<string, string>([["thread-1", "my custom review"]]);
    store.upsert(sessionRow({ id: "thread-1" }));
    const { orch, openingTurns } = makeOrch({ threadNames: names });
    await (orch as any).applyPresetToSession(
      { platform: "discord", id: "thread-1", parentId: "chan-1" },
      store.get("discord:thread-1")!,
      store.getPresetByNameScoped("reviewer", "chan-1")!
    );
    expect(openingTurns).toEqual([]);
  });
});

describe("createChildThread adds the invoking user", () => {
  it("adds the caller to a preset thread with no mention on success", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const { orch, addedMembers, sent } = makeOrch();
    const { i } = slashI({
      group: "preset",
      sub: "thread",
      userId: ADMIN,
      strings: { preset: "reviewer" },
    });
    await (orch as any).cmdPresetThread(i);
    expect(addedMembers).toEqual([{ id: "thread-new", userId: ADMIN }]);
    expect(sent).toEqual([]);
  });

  it("adds the caller to each thread in a quantity run", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const { orch, addedMembers, sent } = makeOrch();
    const { i } = slashI({
      group: "preset",
      sub: "thread",
      userId: ADMIN,
      strings: { preset: "reviewer" },
      ints: { quantity: 3 },
    });
    await (orch as any).cmdPresetThread(i);
    expect(addedMembers).toEqual([
      { id: "thread-new", userId: ADMIN },
      { id: "thread-new-2", userId: ADMIN },
      { id: "thread-new-3", userId: ADMIN },
    ]);
    expect(sent).toEqual([]);
  });

  it("falls back to a bare mention only when addThreadMember fails", async () => {
    store.upsertPreset(preset({ name: "reviewer", agentId: "grok", threadSlug: "hist" }));
    const { orch, addedMembers, sent, created } = makeOrch({
      addThreadMember: async () => {
        throw new Error("Missing Access");
      },
    });
    const { i, edits } = slashI({
      group: "preset",
      sub: "thread",
      userId: ADMIN,
      strings: { preset: "reviewer" },
    });
    await (orch as any).cmdPresetThread(i);
    expect(created).toHaveLength(1);
    expect(addedMembers).toEqual([]);
    expect(sent).toEqual([{ id: "thread-new", text: `<@${ADMIN}>` }]);
    expect(edits[0]).toMatch(/Created <#thread-new>/);
  });

  it("/seam new also adds the invoking user", async () => {
    const { orch, addedMembers, sent } = makeOrch();
    const { i } = slashI({ group: null, sub: "new", userId: ADMIN, strings: { name: "hello" } });
    const thread = await (orch as any).createChildThread(i.channelId, "hello", i.user.id);
    expect(thread.id).toBe("thread-new");
    expect(addedMembers).toEqual([{ id: "thread-new", userId: ADMIN }]);
    expect(sent).toEqual([]);
  });
});
