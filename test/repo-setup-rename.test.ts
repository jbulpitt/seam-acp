/**
 * #206: selecting a repo must not author the Discord thread title.
 *
 * Covers the real `/seam config edit` Save transaction (not a stubbed helper)
 * plus a source search that repo-selection/setup paths never call the Discord
 * rename API or derive the thread base from a repo.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pino } from "pino";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import { SessionRouter } from "../packages/core/src/core/session-router.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import {
  applyPickerValue,
  isDirty,
  parseCustomId,
} from "../packages/core/src/platforms/discord/config-editor.js";
import { stripStoredThreadPrefix } from "../packages/core/src/platforms/discord/thread-namer.js";
import type { Logger } from "../packages/core/src/lib/logger.js";
import type { AgentProfile } from "@seam/adapters";
import type { ChannelPreset, ThreadPreset } from "../packages/core/src/config.js";
import type { ChannelRef, StructuredPanel } from "../packages/core/src/platforms/chat-adapter.js";
import type { Preset } from "../packages/core/src/core/types.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caps = () => undefined;

const silent = pino({ level: "silent" }) as unknown as Logger;
const ADMIN = "1487094572696867019";
const PARENT = "111111111111111111";
const THREAD = "333333333333333333";
const THREAD_INIT = "444444444444444444";

const profiles = [
  {
    id: "copilot",
    displayName: "Copilot",
    defaultModel: "gpt-5.4",
    staticModels: [{ modelId: "gpt-5.4" }],
    effort: { mechanism: "none", levels: [] as string[] },
  },
] as unknown as AgentProfile[];

let dir: string;
let reposRoot: string;
let store: SessionStore;

function slashI(over: {
  sub?: string;
  group?: string | null;
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
      getSubcommand: () => over.sub ?? "new",
      getSubcommandGroup: (_req?: boolean) => over.group ?? null,
      getString: (name: string, _req?: boolean) => over.strings?.[name] ?? null,
      getInteger: (_name: string, _req?: boolean) => null,
    },
    user: { id: over.userId ?? ADMIN, username: "jesse", displayName: "jesse" },
    channelId: over.channelId ?? PARENT,
    channel: {
      isThread: () => over.isThread === true,
      parentId: over.parentId,
    },
    deferred: false,
    replied: false,
    reply: async (payload: { content?: string; flags?: number }) => {
      i.replied = true;
      replies.push(payload);
    },
    deferReply: async () => {
      i.deferred = true;
    },
    editReply: async (content: string) => {
      edits.push(content);
    },
  };
  return { i, replies, edits };
}

function componentEvt(customId: string, channel: ChannelRef, messageId: string) {
  const ephemeral: string[] = [];
  return {
    interactionId: "int-1",
    customId,
    userId: ADMIN,
    userName: "jesse",
    channel,
    messageId,
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

function makeOrch() {
  const presetsFile = path.join(dir, "channel-presets.json");
  fs.writeFileSync(presetsFile, JSON.stringify({ channels: {}, threads: {} }));
  const channelPresets = new Map<string, ChannelPreset>();
  const threadPresets = new Map<string, ThreadPreset>();
  store = new SessionStore(path.join(dir, "seam.db"));
  const router = new SessionRouter({
    logger: silent,
    store,
    profiles,
    defaultAgentId: "copilot",
    defaultModel: "gpt-5.4",
    defaultPermissionMode: "ask",
    channelPresets,
    threadPresets,
  });

  const created: Array<{ parent: ChannelRef; name: string }> = [];
  const renamed: Array<{ id: string; name: string }> = [];
  const threadNames = new Map<string, string>();
  const panels: Array<{ id: string; panel: StructuredPanel; messageId: string }> = [];
  let seq = 0;

  const adapter: Record<string, unknown> = {
    createThread: async (parent: ChannelRef, name: string): Promise<ChannelRef> => {
      created.push({ parent, name });
      seq += 1;
      const id = seq === 1 ? THREAD : `${BigInt(THREAD) + BigInt(seq - 1)}`;
      threadNames.set(id, name);
      return { platform: "discord", id, parentId: parent.id };
    },
    getThreadName: async (ch: ChannelRef) => threadNames.get(ch.id),
    renameThread: async (ch: ChannelRef, name: string) => {
      renamed.push({ id: ch.id, name });
      threadNames.set(ch.id, name);
    },
    addThreadMember: async () => {},
    sendMessage: async (ch: ChannelRef, text: string) => ({
      id: "msg-plain",
      channel: ch,
      text,
    }),
    sendPanel: async (ch: ChannelRef, panel: StructuredPanel) => {
      const messageId = `panel-${panels.length + 1}`;
      panels.push({ id: ch.id, panel, messageId });
      return { id: messageId, channel: ch };
    },
    editPanel: async () => {},
  };

  const orch = new Orchestrator({
    logger: silent,
    config: {
      DATA_DIR: dir,
      REPOS_ROOT: reposRoot,
      TURN_TIMEOUT_SECONDS: 60,
      DEFAULT_MODEL: "gpt-5.4",
      DEFAULT_AGENT: "copilot",
      DEFAULT_PERMISSION_POLICY: "ask",
      CHANNEL_PRESETS_FILE: presetsFile,
      SEAM_CONFIG_MUTATION_TIER_C_ENABLED: false,
      channelPresets,
      threadPresets,
      bridgePresets: new Map(),
      REPO_EMOJIS: new Map(),
      SEAM_CONFIG_ADMIN_USER_IDS: new Set([ADMIN]),
    } as any,
    adapter: adapter as any,
    router,
    store,
    renderer: { codeBlock: (value: string) => value } as any,
  });

  return {
    orch,
    router,
    created,
    renamed,
    threadNames,
    panels,
    threadPresets,
  };
}

function threadBase(store_: SessionStore, threadId: string, name: string | undefined): string | null {
  const rec = store_.get(`discord:${threadId}`);
  if (!rec || name === undefined) return null;
  if (rec.namePrefix === null || rec.namePrefix === undefined) return name;
  return stripStoredThreadPrefix(name, rec.namePrefix);
}

async function saveRepoOnPostedCard(
  orch: Orchestrator,
  panels: Array<{ id: string; panel: StructuredPanel; messageId: string }>,
  repoPath: string
): Promise<void> {
  const posted = panels.at(-1)!;
  const save = posted.panel.actions!.flat().find((b) => b.label === "Save")!;
  const draftId = parseCustomId(save.customId)!.draftId;
  const draft = (orch as any).configEditor.get(draftId);
  const dirty = applyPickerValue(draft, "repo", repoPath, caps);
  expect(dirty.overlay.cwd).toBe(repoPath);
  expect(isDirty(dirty)).toBe(true);
  (orch as any).configEditor.put(dirty);
  const evt = componentEvt(
    save.customId,
    { platform: "discord", id: posted.id, parentId: PARENT },
    posted.messageId
  );
  await (orch as any).handleConfigEditorComponent(evt);
  expect(evt.ephemeral, evt.ephemeral.join(" | ")).toEqual([]);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-repo-rename-"));
  reposRoot = path.join(dir, "repos");
  fs.mkdirSync(path.join(reposRoot, "seam-acp"), { recursive: true });
  fs.mkdirSync(path.join(reposRoot, "other-app"), { recursive: true });
});

afterEach(() => {
  if (store) {
    store.close();
    store = undefined as unknown as SessionStore;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("#206 config Save does not rename from the selected repo", () => {
  it("saving a repo on a thread whose base is exactly `seam` does not call rename and does not change the name", async () => {
    const { orch, created, renamed, threadNames, panels } = makeOrch();
    const { i } = slashI({ sub: "new" });
    await (orch as any).cmdNew(i);

    expect(created[0]!.name).toBe("seam");
    const afterCreate = [...renamed];
    const nameBefore = threadNames.get(THREAD);
    expect(threadBase(store, THREAD, nameBefore)?.toLowerCase()).toBe("seam");

    await saveRepoOnPostedCard(orch, panels, path.join(reposRoot, "seam-acp"));

    expect(threadPresetsCwd(orch, THREAD)).toBe(path.resolve(reposRoot, "seam-acp"));
    expect(renamed.slice(afterCreate.length)).toEqual([]);
    expect(threadNames.get(THREAD)).toBe(nameBefore);
    expect(threadBase(store, THREAD, threadNames.get(THREAD))?.toLowerCase()).toBe("seam");
    expect(threadNames.get(THREAD)).not.toMatch(/seam-acp/i);
  });

  it("saving a repo on an already named thread does not change its name", async () => {
    const { orch, renamed, threadNames, panels } = makeOrch();
    const { i } = slashI({ sub: "new", strings: { name: "hello" } });
    await (orch as any).cmdNew(i);

    const afterCreate = [...renamed];
    const nameBefore = threadNames.get(THREAD);
    expect(threadBase(store, THREAD, nameBefore)).toBe("hello");

    await saveRepoOnPostedCard(orch, panels, path.join(reposRoot, "seam-acp"));

    expect(renamed.slice(afterCreate.length)).toEqual([]);
    expect(threadNames.get(THREAD)).toBe(nameBefore);
    expect(threadBase(store, THREAD, threadNames.get(THREAD))).toBe("hello");
  });

  it("saving a role still updates the ThreadNamer prefix while the base stays `seam`", async () => {
    const { orch, threadNames, panels } = makeOrch();
    const { i } = slashI({ sub: "new" });
    await (orch as any).cmdNew(i);
    const posted = panels.at(-1)!;
    const save = posted.panel.actions!.flat().find((b) => b.label === "Save")!;
    const draftId = parseCustomId(save.customId)!.draftId;
    let draft = (orch as any).configEditor.get(draftId);
    draft = applyPickerValue(draft, "role", "worker", caps);
    expect(draft.overlay.role).toBe("worker");
    expect(isDirty(draft)).toBe(true);
    (orch as any).configEditor.put(draft);
    const evt = componentEvt(
      save.customId,
      { platform: "discord", id: posted.id, parentId: PARENT },
      posted.messageId
    );
    await (orch as any).handleConfigEditorComponent(evt);
    expect(evt.ephemeral, evt.ephemeral.join(" | ")).toEqual([]);
    const rec = store.get(`discord:${THREAD}`)!;
    expect(rec.namePrefix).toContain("🛠️");
    expect(threadBase(store, THREAD, threadNames.get(THREAD))?.toLowerCase()).toBe("seam");
  });
});

function threadPresetsCwd(orch: Orchestrator, threadId: string): string | undefined {
  return (orch as any).config.threadPresets.get(threadId)?.cwd?.value;
}

describe("#206 repo-selection/setup paths do not derive the thread base from a repo", () => {
  it("/seam new names the thread from the given name, not from any repo", async () => {
    const { orch, created, threadNames } = makeOrch();
    const { i } = slashI({ sub: "new", strings: { name: "notes" } });
    await (orch as any).cmdNew(i);
    expect(created[0]!.name).toBe("notes");
    expect(threadBase(store, THREAD, threadNames.get(THREAD))).toBe("notes");
    expect(store.get(`discord:${THREAD}`)?.repoPath).toBe(reposRoot);
  });

  it("/seam config init binds cwd without renaming", async () => {
    const { orch, renamed, threadNames } = makeOrch();
    threadNames.set(THREAD_INIT, "seam");
    const { i } = slashI({
      group: "config",
      sub: "init",
      channelId: THREAD_INIT,
      isThread: true,
      parentId: PARENT,
    });
    await (orch as any).cmdInit(i);
    expect(renamed).toEqual([]);
    expect(threadNames.get(THREAD_INIT)).toBe("seam");
    expect(store.get(`discord:${THREAD_INIT}`)).not.toBeNull();
  });

  it("/seam config repo writes cwd and does not rename", async () => {
    const { orch, renamed, threadNames } = makeOrch();
    const { i: newI } = slashI({ sub: "new", strings: { name: "hello" } });
    await (orch as any).cmdNew(newI);
    const afterCreate = [...renamed];
    const nameBefore = threadNames.get(THREAD);

    const { i, replies, edits } = slashI({
      group: "config",
      sub: "repo",
      channelId: THREAD,
      isThread: true,
      parentId: PARENT,
      strings: { path: "seam-acp", scope: "session" },
    });
    await (orch as any).cmdRepo(i);

    const ack = edits.at(-1) ?? replies[0]?.content ?? "";
    expect(ack).toMatch(/Repo set to/);
    expect(store.get(`discord:${THREAD}`)?.repoPath).toBe(path.resolve(reposRoot, "seam-acp"));
    expect(renamed.slice(afterCreate.length)).toEqual([]);
    expect(threadNames.get(THREAD)).toBe(nameBefore);
    expect(threadBase(store, THREAD, threadNames.get(THREAD))).toBe("hello");
  });

  it("/seam config set repo: does not replace the thread base with the repo display", async () => {
    const { orch, renamed, threadNames } = makeOrch();
    const { i: newI } = slashI({ sub: "new" });
    await (orch as any).cmdNew(newI);
    const afterCreate = [...renamed];
    const nameBefore = threadNames.get(THREAD);

    const { i } = slashI({
      group: "config",
      sub: "set",
      channelId: THREAD,
      isThread: true,
      parentId: PARENT,
      strings: { repo: "seam-acp" },
    });
    await (orch as any).cmdConfigSet(i);

    expect(store.get(`discord:${THREAD}`)?.repoPath).toBe(path.resolve(reposRoot, "seam-acp"));
    expect(renamed.slice(afterCreate.length)).toEqual([]);
    expect(threadNames.get(THREAD)).toBe(nameBefore);
    expect(threadBase(store, THREAD, threadNames.get(THREAD))?.toLowerCase()).toBe("seam");
  });

  it("applying a preset with a repoPath does not rename the thread after the repo", async () => {
    const { orch, renamed, threadNames } = makeOrch();
    const { i: newI } = slashI({ sub: "new", strings: { name: "review-pr" } });
    await (orch as any).cmdNew(newI);
    const afterCreate = [...renamed];
    const nameBefore = threadNames.get(THREAD);
    const rec = store.get(`discord:${THREAD}`)!;
    const preset: Preset = {
      id: "p-reviewer",
      name: "reviewer",
      projectRef: PARENT,
      description: null,
      agentId: "copilot",
      model: "gpt-5.4",
      effort: null,
      repoPath: path.join(reposRoot, "seam-acp"),
      role: null,
      disableThreadPrefix: null,
      permission: null,
      toolsAllow: null,
      toolsExclude: null,
      instructions: null,
      statusCardStyle: null,
      createdBy: ADMIN,
      createdUtc: "2026-09-05T00:00:00.000Z",
      updatedUtc: "2026-09-05T00:00:00.000Z",
    };

    await (orch as any).applyPresetToSession(
      { platform: "discord", id: THREAD, parentId: PARENT },
      rec,
      preset
    );

    expect(store.get(`discord:${THREAD}`)?.repoPath).toBe(path.join(reposRoot, "seam-acp"));
    expect(renamed.slice(afterCreate.length)).toEqual([]);
    expect(threadNames.get(THREAD)).toBe(nameBefore);
    expect(threadBase(store, THREAD, threadNames.get(THREAD))).toBe("review-pr");
  });
});

function extractMethod(src: string, name: string): string {
  const header = new RegExp(
    String.raw`(?:private |public |protected )(?:async )?${name}\s*\(`
  );
  const match = header.exec(src);
  if (!match || match.index === undefined) {
    throw new Error(`method ${name} not found`);
  }
  const brace = src.indexOf("{", match.index);
  if (brace < 0) throw new Error(`method ${name} has no body`);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(match.index, i + 1);
    }
  }
  throw new Error(`method ${name} unclosed`);
}

const REPO_SELECTION_METHODS = [
  "saveConfigEditorDraft",
  "applyPickedRepo",
  "applyRepoAtScope",
  "cmdRepo",
  "cmdNew",
  "cmdInit",
  "cmdConfigSet",
  "cmdPresetApply",
  "cmdPresetThread",
  "applyPresetToSession",
  "promptRepoPath",
  "bindSessionToThread",
] as const;

const RENAME_FROM_REPO = /renameThreadForSetup|renameThreadBase|adapter\.renameThread/;

describe("#206 negative search: no repo-selection path invokes a Discord rename", () => {
  const orchestratorSrc = fs.readFileSync(
    path.join(REPO_ROOT, "packages/core/src/platforms/discord/orchestrator.ts"),
    "utf8"
  );
  const mcpSrc = fs.readFileSync(
    path.join(REPO_ROOT, "packages/core/src/core/mcp/seam-mcp-server.ts"),
    "utf8"
  );
  const indexSrc = fs.readFileSync(path.join(REPO_ROOT, "packages/core/src/index.ts"), "utf8");
  const controlSrc = fs.readFileSync(
    path.join(REPO_ROOT, "packages/core/src/core/thread-session-control.ts"),
    "utf8"
  );
  const mutationSrc = fs.readFileSync(
    path.join(REPO_ROOT, "packages/core/src/core/config-mutation.ts"),
    "utf8"
  );

  it("the repo-driven setup helper is gone", () => {
    expect(orchestratorSrc).not.toContain("renameThreadForSetup");
    expect(orchestratorSrc).not.toContain("setup thread naming failed");
    expect(orchestratorSrc).not.toMatch(/renameThreadBase\([\s\S]{0,240}repoDisplay/);
    expect(orchestratorSrc).not.toMatch(/repoDisplay\([\s\S]{0,80}renameThreadBase/);
  });

  it("every repo-selection/setup method leaves Discord rename to ThreadNamer applyThreadName only", () => {
    for (const name of REPO_SELECTION_METHODS) {
      const body = extractMethod(orchestratorSrc, name);
      expect(body, name).not.toMatch(RENAME_FROM_REPO);
    }
  });

  it("MCP configure_thread cannot set cwd, and rename_thread is the explicit naming tool", () => {
    expect(mcpSrc).not.toContain("renameThreadForSetup");
    const configure = mcpSrc.slice(
      mcpSrc.indexOf('name: "configure_thread"'),
      mcpSrc.indexOf('name: "reset_thread_session"')
    );
    expect(configure).toContain("configure_thread");
    expect(configure).not.toMatch(/\bcwd\b/);
    expect(configure).not.toMatch(/repoPath/);
    expect(mcpSrc).toMatch(/name: "rename_thread"/);
    expect(controlSrc).not.toContain("renameThreadForSetup");
    expect(controlSrc).not.toMatch(/renameThreadBase/);
    expect(mutationSrc).not.toContain("renameThread");
    expect(indexSrc).toMatch(/orchestrator\.renameThreadBase\(record, name\)/);
  });
});
