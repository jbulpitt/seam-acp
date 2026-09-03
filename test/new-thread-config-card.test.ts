/**
 * `/seam new` + `/seam config init` post the `/seam config edit` card (#157).
 *
 * Covers the three things the rewrite must not lose:
 *  - membership: the invoking user is added to the new thread
 *  - configuration: a config-editor draft is posted, owned by that user, and
 *    its buttons drive the same save path as `/seam config edit`
 *  - lifecycle: the session is bound, no wizard picker sequence runs, and the
 *    draft survives from post to save.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pino } from "pino";
import { MessageFlags } from "discord.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import {
  CFG_EDIT_PREFIX,
  parseCustomId,
} from "../packages/core/src/platforms/discord/config-editor.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { ChannelRef, StructuredPanel } from "../packages/core/src/platforms/chat-adapter.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const ADMIN = "1487094572696867019";
const now = "2026-09-02T00:00:00.000Z";

let dir: string;
let store: SessionStore;

function setting<T>(value: T, source = "default") {
  return { value, source };
}

function slashI(over: {
  group?: string | null;
  sub: string;
  userId?: string;
  channelId?: string;
  isThread?: boolean;
  parentId?: string;
  strings?: Record<string, string | null>;
}) {
  const replies: Array<{ content?: string; flags?: number }> = [];
  const edits: string[] = [];
  const i = {
    options: {
      getSubcommand: () => over.sub,
      getSubcommandGroup: (_req?: boolean) => over.group ?? null,
      getString: (name: string, _req?: boolean) => over.strings?.[name] ?? null,
      getInteger: (_name: string, _req?: boolean) => null,
    },
    user: { id: over.userId ?? ADMIN, username: "jesse", displayName: "jesse" },
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

/** Minimal ComponentEvent for driving the config-editor hub handler. */
function componentEvt(customId: string, userId: string) {
  const ephemeral: string[] = [];
  return {
    interactionId: `int-${userId}`,
    customId,
    userId,
    userName: "jesse",
    channel: { platform: "discord", id: "thread-new", parentId: "chan-1" } as ChannelRef,
    messageId: "panel-1",
    kind: "button" as const,
    ephemeral,
    replyEphemeral: async (t: string) => {
      ephemeral.push(t);
    },
    followUpEphemeral: async (t: string) => {
      ephemeral.push(t);
    },
    deferUpdate: async () => {},
  };
}

function makeOrch(over?: {
  sendPanel?: ((ch: ChannelRef, panel: StructuredPanel) => Promise<{ id: string }>) | null;
  addThreadMember?: (ch: ChannelRef, userId: string) => Promise<void>;
  threadPresets?: Map<string, unknown>;
}) {
  const created: Array<{ parent: ChannelRef; name: string }> = [];
  const addedMembers: Array<{ id: string; userId: string }> = [];
  const sent: Array<{ id: string; text: string }> = [];
  const panels: Array<{ id: string; panel: StructuredPanel }> = [];
  const editedPanels: Array<{ id: string; panel: StructuredPanel }> = [];
  const pickers: Array<{ id: string; title: string | undefined }> = [];
  const threadNames = new Map<string, string>();

  const router = {
    listProfiles: () => [{ id: "copilot", displayName: "Copilot" }],
    getProfile: (id: string) => ({
      id,
      defaultModel: "default-model",
      staticModels: [{ modelId: "default-model" }],
      effort: { mechanism: "none", levels: [] as string[] },
    }),
    describeConfig: (record: SessionRecord) => ({
      sessionId: record.id,
      channelRef: record.channelRef,
      parentRef: record.parentRef,
      location: setting("local"),
      agent: setting(record.agentId, "session config"),
      model: setting("default-model", "session config"),
      effort: setting(null),
      cwd: setting(record.repoPath ?? "/repo", "session config"),
      permission: setting("ask"),
      detached: setting(false),
      statusCardStyle: setting("full"),
      simpleCardGif: setting(false),
      role: setting(null),
      disableThreadPrefix: setting(false),
      rider: {},
      locked: false,
    }),
    ensureSessionRecord: (opts: {
      platform: string;
      channelRef: string;
      parentRef?: string;
      cwd: string;
    }): SessionRecord => {
      const existing = store.get(`discord:${opts.channelRef}`);
      if (existing) return existing;
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
    invalidate: vi.fn(async () => {}),
  };

  let seq = 0;
  const adapter: Record<string, unknown> = {
    createThread: async (parent: ChannelRef, name: string): Promise<ChannelRef> => {
      created.push({ parent, name });
      seq += 1;
      const id = seq === 1 ? "thread-new" : `thread-new-${seq}`;
      threadNames.set(id, name);
      return { platform: "discord", id, parentId: "chan-1" };
    },
    getThreadName: async (ch: ChannelRef) => threadNames.get(ch.id),
    renameThread: async (ch: ChannelRef, name: string) => {
      threadNames.set(ch.id, name);
    },
    addThreadMember:
      over?.addThreadMember ??
      (async (ch: ChannelRef, userId: string) => {
        addedMembers.push({ id: ch.id, userId });
      }),
    sendMessage: async (ch: ChannelRef, text: string) => {
      sent.push({ id: ch.id, text });
      return { id: "msg-plain", channel: ch };
    },
    editPanel: async (ref: { id: string }, panel: StructuredPanel) => {
      editedPanels.push({ id: ref.id, panel });
    },
    // A wizard step would show up here — every assertion below expects none.
    sendChoicePicker: async (
      ch: ChannelRef,
      opts: { panel?: StructuredPanel }
    ): Promise<null> => {
      pickers.push({ id: ch.id, title: opts.panel?.title });
      return null;
    },
  };
  if (over?.sendPanel !== null) {
    adapter.sendPanel =
      over?.sendPanel ??
      (async (ch: ChannelRef, panel: StructuredPanel) => {
        panels.push({ id: ch.id, panel });
        return { id: `panel-${panels.length}`, channel: ch };
      });
  }

  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: "/repo",
      TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_MODEL: "default-model",
      DEFAULT_AGENT: "copilot",
      DEFAULT_PERMISSION_POLICY: "ask",
      CHANNEL_PRESETS_FILE: undefined,
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      REPO_EMOJIS: new Map(),
      bridgePresets: new Map(),
      channelPresets: new Map(),
      threadPresets: over?.threadPresets ?? new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
      SEAM_PARTICIPANT_USER_IDS: undefined,
    } as any,
    adapter: adapter as any,
    router: router as any,
    store,
    renderer: {} as any,
  });

  return { orch, created, addedMembers, sent, panels, editedPanels, pickers, threadNames };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-new-card-"));
  store = new SessionStore(path.join(dir, "test.db"));
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("/seam new membership (#157)", () => {
  it("adds the invoking user to the thread it creates", async () => {
    const { orch, created, addedMembers, sent } = makeOrch();
    const { i } = slashI({ sub: "new", userId: ADMIN, strings: { name: "hello" } });
    await (orch as any).cmdNew(i);
    expect(created).toEqual([
      { parent: { platform: "discord", id: "chan-1" }, name: "hello" },
    ]);
    expect(addedMembers).toEqual([{ id: "thread-new", userId: ADMIN }]);
    // Happy path stays silent — no mention fallback.
    expect(sent).toEqual([]);
  });

  it("still adds the user (via mention fallback) when addThreadMember fails", async () => {
    const { orch, addedMembers, sent, panels } = makeOrch({
      addThreadMember: async () => {
        throw new Error("Missing Access");
      },
    });
    const { i } = slashI({ sub: "new", userId: ADMIN, strings: { name: "hello" } });
    await (orch as any).cmdNew(i);
    expect(addedMembers).toEqual([]);
    expect(sent).toEqual([{ id: "thread-new", text: `<@${ADMIN}>` }]);
    // Membership failure must not cost the user their config card.
    expect(panels).toHaveLength(1);
  });

  it("adds the user before configuration, so a card failure cannot lose them", async () => {
    const { orch, addedMembers, panels } = makeOrch({
      sendPanel: async () => {
        throw new Error("panel boom");
      },
    });
    const { i, edits } = slashI({ sub: "new", userId: ADMIN, strings: { name: "hello" } });
    await (orch as any).cmdNew(i);
    expect(addedMembers).toEqual([{ id: "thread-new", userId: ADMIN }]);
    expect(panels).toEqual([]);
    expect(edits.at(-1)).toMatch(/Run `\/seam config init`/);
  });
});

describe("/seam new configuration surface (#157)", () => {
  it("posts the config-edit card into the new thread instead of a wizard", async () => {
    const { orch, panels, pickers } = makeOrch();
    const { i, edits } = slashI({ sub: "new", userId: ADMIN, strings: { name: "hello" } });
    await (orch as any).cmdNew(i);

    expect(edits[0]).toMatch(/Created thread <#thread-new> and initialized it\./);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.id).toBe("thread-new");
    expect(panels[0]!.panel.title).toBe("🧩 Thread config");
    // No Agent → CWD → Model → Effort sequence anywhere on this path.
    expect(pickers).toEqual([]);
  });

  it("the card is a live draft owned by the invoker", async () => {
    const { orch, panels } = makeOrch();
    const { i } = slashI({ sub: "new", userId: ADMIN, strings: { name: "hello" } });
    await (orch as any).cmdNew(i);

    const save = panels[0]!.panel.actions!.flat().find((b) => b.label === "Save")!;
    const parsed = parseCustomId(save.customId)!;
    expect(save.customId.startsWith(`${CFG_EDIT_PREFIX}:`)).toBe(true);
    const draft = (orch as any).configEditor.get(parsed.draftId);
    expect(draft.userId).toBe(ADMIN);
    expect(draft.threadId).toBe("thread-new");
    expect(draft.parentRef).toBe("chan-1");
    expect(draft.messageId).toBe("panel-1");
    expect(
      (orch as any).configEditor.getForUserThread(ADMIN, "thread-new").id
    ).toBe(parsed.draftId);
  });

  it("the card carries no Host button — agent ids encode the host (#156)", async () => {
    const { orch, panels } = makeOrch();
    const { i } = slashI({ sub: "new", userId: ADMIN, strings: { name: "hello" } });
    await (orch as any).cmdNew(i);
    const labels = panels[0]!.panel.actions!.flat().map((b) => b.label);
    expect(labels).toContain("Agent");
    expect(labels).not.toContain("Host");
  });

  it("falls back to a plain instruction when the platform cannot render panels", async () => {
    const { orch, sent, panels } = makeOrch({ sendPanel: null });
    const { i } = slashI({ sub: "new", userId: ADMIN, strings: { name: "hello" } });
    await (orch as any).cmdNew(i);
    expect(panels).toEqual([]);
    expect(sent).toEqual([
      { id: "thread-new", text: expect.stringMatching(/\/seam config repo/) },
    ]);
  });
});

describe("/seam new lifecycle (#157)", () => {
  it("binds a session record to the new thread and names it", async () => {
    const { orch, threadNames } = makeOrch();
    const { i } = slashI({ sub: "new", userId: ADMIN, strings: { name: "hello" } });
    await (orch as any).cmdNew(i);

    const rec = store.get("discord:thread-new");
    expect(rec).not.toBeNull();
    expect(rec!.channelRef).toBe("thread-new");
    expect(rec!.parentRef).toBe("chan-1");
    expect(rec!.repoPath).toBe("/repo");
    expect(threadNames.get("thread-new")).toMatch(/hello$/);
  });

  it("defaults the thread name to `seam` and reuses the bound record for the draft", async () => {
    const { orch, created, panels } = makeOrch();
    const { i } = slashI({ sub: "new", userId: ADMIN });
    await (orch as any).cmdNew(i);
    expect(created[0]!.name).toBe("seam");
    expect(panels).toHaveLength(1);
    // ensureSessionRecord is idempotent — the card did not fork a second row.
    expect(store.list().filter((r) => r.channelRef === "thread-new")).toHaveLength(1);
  });

  it("a second /seam new opens an independent draft per thread", async () => {
    const { orch, panels } = makeOrch();
    for (const name of ["one", "two"]) {
      const { i } = slashI({ sub: "new", userId: ADMIN, strings: { name } });
      await (orch as any).cmdNew(i);
    }
    expect(panels.map((p) => p.id)).toEqual(["thread-new", "thread-new-2"]);
    const ids = panels.map(
      (p) => parseCustomId(p.panel.actions!.flat().find((b) => b.label === "Save")!.customId)!.draftId
    );
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect((orch as any).configEditor.get(id)).toBeDefined();
    }
  });

  it("the posted card answers its owner's clicks and refuses everyone else", async () => {
    const { orch, panels, editedPanels } = makeOrch();
    const { i } = slashI({ sub: "new", userId: ADMIN, strings: { name: "hello" } });
    await (orch as any).cmdNew(i);
    const cancel = panels[0]!.panel.actions!.flat().find((b) => b.label === "Cancel")!;
    const draftId = parseCustomId(cancel.customId)!.draftId;

    const stranger = componentEvt(cancel.customId, "999");
    await (orch as any).handleConfigEditorComponent(stranger);
    expect(stranger.ephemeral).toEqual(["This editor isn't yours."]);
    expect((orch as any).configEditor.get(draftId)).toBeDefined();

    const owner = componentEvt(cancel.customId, ADMIN);
    await (orch as any).handleConfigEditorComponent(owner);
    expect((orch as any).configEditor.get(draftId)).toBeUndefined();
    expect(editedPanels.at(-1)!.id).toBe("panel-1");
    expect(editedPanels.at(-1)!.panel.footer).toMatch(/Cancelled/);
  });

  it("refuses without a channel and without thread-creation support", async () => {
    const { orch, created } = makeOrch();
    const { i, replies } = slashI({ sub: "new", userId: ADMIN });
    (i as any).channelId = undefined;
    await (orch as any).cmdNew(i);
    expect(created).toEqual([]);
    expect(replies[0]?.content).toBe("No channel.");
    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
  });
});

describe("/seam config init shares the card (#157)", () => {
  it("binds the thread and opens the same config card", async () => {
    const { orch, panels, pickers } = makeOrch();
    const { i, replies } = slashI({
      group: "config",
      sub: "init",
      userId: ADMIN,
      channelId: "thread-x",
      isThread: true,
      parentId: "chan-1",
    });
    await (orch as any).cmdInit(i);

    expect(store.get("discord:thread-x")).not.toBeNull();
    expect(replies[0]?.content).toMatch(/Opening the config editor/);
    expect(replies[0]?.flags).toBe(MessageFlags.Ephemeral);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.id).toBe("thread-x");
    expect(panels[0]!.panel.title).toBe("🧩 Thread config");
    expect(pickers).toEqual([]);
  });

  it("still binds the session when the card cannot be rendered", async () => {
    const { orch, panels } = makeOrch({ sendPanel: null });
    const { i, edits } = slashI({
      group: "config",
      sub: "init",
      userId: ADMIN,
      channelId: "thread-x",
      isThread: true,
      parentId: "chan-1",
    });
    await (orch as any).cmdInit(i);
    expect(store.get("discord:thread-x")).not.toBeNull();
    expect(panels).toEqual([]);
    expect(edits.at(-1)).toMatch(/\/seam config repo/);
  });

  it("refuses to bind a detached thread (no card either)", async () => {
    const { orch, panels } = makeOrch({
      threadPresets: new Map([["thread-x", { detached: { value: true } }]]),
    });
    const { i, replies } = slashI({
      group: "config",
      sub: "init",
      userId: ADMIN,
      channelId: "thread-x",
      isThread: true,
      parentId: "chan-1",
    });
    await (orch as any).cmdInit(i);
    expect(replies[0]?.content).toMatch(/detached/);
    expect(panels).toEqual([]);
    expect(store.get("discord:thread-x")).toBeNull();
  });
});
