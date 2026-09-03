/**
 * #158 — scheduled prompts no longer carry file attachments.
 *
 * These are the regression tests for a removal, so they mostly assert absence:
 * no command, no autocomplete, no editor control, no mutation key, no bytes on
 * the wire. The one thing that is *added* is the legacy quarantine — an enabled
 * pre-removal row must never arm, and its bytes must never be deleted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { pino } from "pino";
import { buildSeamCommand } from "../packages/core/src/platforms/discord/commands.js";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { ScheduledPromptManager } from "../packages/core/src/core/scheduled-prompts/manager.js";
import {
  hasLegacyAttachments,
  legacyAttachmentQuarantine,
  legacyAttachmentStatus,
} from "../packages/core/src/core/scheduled-prompts/quarantine.js";
import { ConfigMutationService } from "../packages/core/src/core/config-mutation.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import type { Logger } from "../packages/core/src/lib/logger.js";

const silent = pino({ level: "silent" }) as unknown as Logger;

const ATTACHMENT_OPTION_TYPE = 11; // ApplicationCommandOptionType.Attachment

function schedule(over: Partial<ScheduledPrompt> = {}): ScheduledPrompt {
  return {
    id: "sch_1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "chan-1",
    name: "Cleanup stories",
    promptText: "Follow docs/runbooks/cleanup-stories.md.",
    cron: "30 4 * * *",
    timezone: "America/Chicago",
    model: null,
    cwd: null,
    targetChannel: null,
    outputType: "card",
    sessionMode: "isolated",
    catchupSeconds: 7200,
    enabled: true,
    legacyAttachmentCount: 0,
    createdBy: "user-jesse",
    createdUtc: "2026-01-01T00:00:00.000Z",
    updatedUtc: "2026-01-01T00:00:00.000Z",
    lastRunUtc: null,
    lastStatus: null,
    nextRunUtc: null,
    pinnedSessionId: null,
    ...over,
  };
}

// --- command registration ---------------------------------------------------

describe("#158 command surface", () => {
  const json = buildSeamCommand().toJSON() as {
    options?: Array<{ name: string; options?: Array<{ name: string; type?: number; options?: Array<{ name: string; type?: number }> }> }>;
  };
  const group = json.options?.find((o) => o.name === "schedule");

  it("exposes exactly add/list/remove/toggle/edit — no addfile or removefile", () => {
    expect((group?.options ?? []).map((o) => o.name)).toEqual([
      "add",
      "list",
      "remove",
      "toggle",
      "edit",
    ]);
  });

  it("`/seam schedule add` takes no options at all (file/file2/file3 are gone)", () => {
    const add = (group?.options ?? []).find((o) => o.name === "add");
    expect(add?.options ?? []).toEqual([]);
  });

  it("no /seam schedule subcommand accepts an attachment option", () => {
    const attachmentOptions = (group?.options ?? []).flatMap((sub) =>
      (sub.options ?? []).filter((o) => o.type === ATTACHMENT_OPTION_TYPE).map((o) => `${sub.name}.${o.name}`)
    );
    expect(attachmentOptions).toEqual([]);
  });
});

// --- legacy row detection + retention ---------------------------------------

describe("#158 legacy attachment_json detection (SessionStore)", () => {
  let dir: string;
  let store: SessionStore;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-158-store-"));
    dbPath = path.join(dir, "test.db");
    store = new SessionStore(dbPath);
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write a pre-#158 manifest straight into the column, as a legacy row has. */
  function seedLegacy(id: string, entries: unknown): void {
    store.upsertScheduled(schedule({ id }));
    const raw = new Database(dbPath);
    raw
      .prepare("UPDATE scheduled_prompts SET attachments_json = ? WHERE id = ?")
      .run(typeof entries === "string" ? entries : JSON.stringify(entries), id);
    raw.close();
  }

  function storedJson(id: string): string {
    const raw = new Database(dbPath);
    const row = raw
      .prepare<[string], { attachments_json: string }>("SELECT attachments_json FROM scheduled_prompts WHERE id = ?")
      .get(id)!;
    raw.close();
    return row.attachments_json;
  }

  it("a fresh row is written with an empty manifest", () => {
    store.upsertScheduled(schedule({ id: "clean" }));
    expect(store.getScheduled("clean")!.legacyAttachmentCount).toBe(0);
    expect(storedJson("clean")).toBe("[]");
  });

  it("counts a legacy manifest instead of exposing it as a managed list", () => {
    seedLegacy("legacy", [
      { filename: "snippet-1-17.txt", mime: "text/plain", size: 120 },
      { filename: "snippet-1-39.txt", mime: "text/plain", size: 240 },
    ]);
    const row = store.getScheduled("legacy")!;
    expect(row.legacyAttachmentCount).toBe(2);
    expect(row).not.toHaveProperty("attachments");
  });

  it("corrupt or non-array attachments_json degrades to 0 rather than throwing", () => {
    seedLegacy("corrupt", "not-json");
    seedLegacy("object", { filename: "x" });
    expect(store.getScheduled("corrupt")!.legacyAttachmentCount).toBe(0);
    expect(store.getScheduled("object")!.legacyAttachmentCount).toBe(0);
  });

  it("a routine update preserves the legacy manifest (evidence is not erased)", () => {
    seedLegacy("legacy", [{ filename: "snippet-1-17.txt", mime: "text/plain", size: 120 }]);
    const row = store.getScheduled("legacy")!;
    // The shape every non-revising caller uses: spread + patch a field.
    store.upsertScheduled({ ...row, enabled: false, lastStatus: "skipped" });
    expect(store.getScheduled("legacy")!.legacyAttachmentCount).toBe(1);
    expect(JSON.parse(storedJson("legacy"))).toHaveLength(1);
  });

  it("an explicit legacyAttachmentCount: 0 clears the manifest (the deliberate revision)", () => {
    seedLegacy("legacy", [{ filename: "snippet-1-17.txt", mime: "text/plain", size: 120 }]);
    const row = store.getScheduled("legacy")!;
    store.upsertScheduled({ ...row, promptText: "Follow docs/runbooks/x.md.", legacyAttachmentCount: 0 });
    expect(store.getScheduled("legacy")!.legacyAttachmentCount).toBe(0);
    expect(storedJson("legacy")).toBe("[]");
  });
});

// --- quarantine helpers ------------------------------------------------------

describe("#158 quarantine helpers", () => {
  it("reports nothing for a clean row", () => {
    const row = schedule();
    expect(hasLegacyAttachments(row)).toBe(false);
    expect(legacyAttachmentQuarantine(row)).toBeNull();
    expect(legacyAttachmentStatus(row)).toBeNull();
  });

  it("names the count and the fix for a legacy row", () => {
    const row = schedule({ legacyAttachmentCount: 2 });
    expect(hasLegacyAttachments(row)).toBe(true);
    expect(legacyAttachmentStatus(row)).toContain("2 legacy attachments");
    expect(legacyAttachmentQuarantine(row)).toContain("runbook");
    expect(legacyAttachmentQuarantine(row)).toContain("left on disk");
  });
});

// --- scheduler arming boundary ----------------------------------------------

describe("#158 scheduler arming boundary", () => {
  function makeStore(rows: ScheduledPrompt[]) {
    const byId = new Map(rows.map((r) => [r.id, { ...r }]));
    const upserts: ScheduledPrompt[] = [];
    const store = {
      getScheduled: (id: string) => {
        const r = byId.get(id);
        return r ? { ...r } : null;
      },
      upsertScheduled: (s: ScheduledPrompt) => {
        upserts.push(s);
        byId.set(s.id, { ...s });
      },
      listScheduledEnabled: () => [...byId.values()].filter((r) => r.enabled).map((r) => ({ ...r })),
    } as unknown as SessionStore;
    return { store, upserts, byId };
  }

  it("refuses to arm an enabled legacy row and stamps an actionable status", () => {
    const { store, upserts } = makeStore([schedule({ id: "sch_legacy", cron: "* * * * *", legacyAttachmentCount: 1 })]);
    const onFire = vi.fn(async () => {});
    const mgr = new ScheduledPromptManager({ store, onFire, logger: silent });

    mgr.start();

    expect(mgr.armedCount).toBe(0);
    expect(onFire).not.toHaveBeenCalled();
    expect(upserts.at(-1)!.lastStatus).toContain("quarantined");
    expect(upserts.at(-1)!.nextRunUtc).toBeNull();
    mgr.stop();
  });

  it("does not catch up a missed fire on a legacy row", () => {
    const { store } = makeStore([
      schedule({
        id: "sch_legacy",
        cron: "* * * * *",
        legacyAttachmentCount: 1,
        nextRunUtc: new Date(Date.now() - 3_600_000).toISOString(), // long overdue
      }),
    ]);
    const onFire = vi.fn(async () => {});
    const mgr = new ScheduledPromptManager({ store, onFire, logger: silent });

    mgr.start();

    expect(onFire).not.toHaveBeenCalled();
    mgr.stop();
  });

  it("refuses a manual Run now on a legacy row", async () => {
    const { store, upserts } = makeStore([schedule({ id: "sch_legacy", legacyAttachmentCount: 3 })]);
    const onFire = vi.fn(async () => {});
    const mgr = new ScheduledPromptManager({ store, onFire, logger: silent });

    await mgr.runNow("sch_legacy");

    expect(onFire).not.toHaveBeenCalled();
    expect(upserts.at(-1)!.lastStatus).toContain("3 legacy attachments");
    mgr.stop();
  });

  it("still arms and fires a clean row (the quarantine is not a blanket stop)", async () => {
    const { store } = makeStore([schedule({ id: "sch_ok", cron: "* * * * *" })]);
    const onFire = vi.fn(async () => {});
    const mgr = new ScheduledPromptManager({ store, onFire, logger: silent });

    mgr.start();
    expect(mgr.armedCount).toBe(1);

    await mgr.runNow("sch_ok");
    expect(onFire).toHaveBeenCalledWith("sch_ok");
    mgr.stop();
  });

  it("re-arms once the manifest is cleared", () => {
    const { store, byId } = makeStore([schedule({ id: "sch_legacy", cron: "* * * * *", legacyAttachmentCount: 1 })]);
    const mgr = new ScheduledPromptManager({ store, onFire: vi.fn(async () => {}), logger: silent });

    mgr.start();
    expect(mgr.armedCount).toBe(0);

    byId.set("sch_legacy", { ...byId.get("sch_legacy")!, legacyAttachmentCount: 0 });
    mgr.reschedule("sch_legacy");

    expect(mgr.armedCount).toBe(1);
    mgr.stop();
  });
});

// --- mutation surface --------------------------------------------------------

describe("#158 config_propose schedule mutations", () => {
  let dir: string;
  let store: SessionStore;
  let rescheduled: string[];

  const record: SessionRecord = {
    id: "discord:thread-1",
    platform: "discord",
    channelRef: "thread-1",
    parentRef: "chan-1",
    agentId: "claude",
    acpSessionId: "",
    repoPath: "/repo",
    configJson: "{}",
    namePrefix: null,
    createdUtc: "2026-01-01T00:00:00.000Z",
    updatedUtc: "2026-01-01T00:00:00.000Z",
  };

  function makeService(): ConfigMutationService {
    return new ConfigMutationService({
      store,
      describeConfig: (() => ({})) as never,
      profiles: new Map(),
      defaultModel: "default",
      presetsFile: undefined,
      tierCEnabled: false,
      reloadPresets: () => ({ ok: true }),
      reschedule: (id) => rescheduled.push(id),
      defaultTimezone: "America/Chicago",
      logger: silent,
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-158-mut-"));
    store = new SessionStore(path.join(dir, "test.db"));
    store.upsert(record);
    rescheduled = [];
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const attachmentShapes = [
    { attachments: [{ filename: "notes.txt" }] },
    { attachment: "notes.txt" },
    { files: ["notes.txt"] },
    { file: "notes.txt" },
    { file2: "notes.txt" },
    { file3: "notes.txt" },
    { addFile: "notes.txt" },
    { removeFile: "notes.txt" },
  ];

  it.each(attachmentShapes)("refuses a create carrying %o and writes nothing", (extra) => {
    const svc = makeService();
    const built = svc.buildProposal(record, {
      schedule: {
        action: "create",
        name: "Nightly",
        promptText: "Follow the runbook",
        cron: "0 7 * * *",
        ...(extra as object),
      },
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatch(/no longer carry file attachments|not supported/i);
    expect(built.error).toContain("runbook");
    expect(store.listScheduledByChannel("discord", "thread-1")).toEqual([]);
  });

  it("refuses an attachment-bearing update before the id is even resolved", () => {
    const svc = makeService();
    const built = svc.buildProposal(record, {
      schedule: { action: "update", id: "sch_nope", file: "notes.txt" } as never,
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toContain("schedule.file");
  });

  it("an ordinary create still works and records no attachments", () => {
    const svc = makeService();
    const built = svc.buildProposal(record, {
      schedule: { action: "create", name: "Nightly", promptText: "Follow docs/runbooks/n.md", cron: "0 7 * * *" },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    built.proposal.apply({ id: "user-jesse", name: "Jesse" });
    const rows = store.listScheduledByChannel("discord", "thread-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.legacyAttachmentCount).toBe(0);
  });

  it("updating a quarantined row warns, clears the manifest, and re-arms it", () => {
    store.upsertScheduled(schedule({ id: "sch_legacy", channelRef: "thread-1" }));
    const raw = new Database(path.join(dir, "test.db"));
    raw
      .prepare("UPDATE scheduled_prompts SET attachments_json = ? WHERE id = 'sch_legacy'")
      .run(JSON.stringify([{ filename: "snippet-1-17.txt", mime: "text/plain", size: 12 }]));
    raw.close();
    expect(store.getScheduled("sch_legacy")!.legacyAttachmentCount).toBe(1);

    const svc = makeService();
    const built = svc.buildProposal(record, {
      schedule: { action: "update", id: "sch_legacy", promptText: "Follow docs/runbooks/cleanup-stories.md." },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.warnings.join(" ")).toMatch(/quarantined/i);
    expect(built.proposal.warnings.join(" ")).toContain("left on disk");

    built.proposal.apply({ id: "user-jesse", name: "Jesse" });
    expect(store.getScheduled("sch_legacy")!.legacyAttachmentCount).toBe(0);
    expect(rescheduled).toEqual(["sch_legacy"]);
  });

  it("enabling a quarantined row warns that enabling alone will not arm it", () => {
    store.upsertScheduled(schedule({ id: "sch_legacy", channelRef: "thread-1", enabled: false }));
    const raw = new Database(path.join(dir, "test.db"));
    raw
      .prepare("UPDATE scheduled_prompts SET attachments_json = ? WHERE id = 'sch_legacy'")
      .run(JSON.stringify([{ filename: "snippet-1-17.txt", mime: "text/plain", size: 12 }]));
    raw.close();

    const svc = makeService();
    const built = svc.buildProposal(record, { schedule: { action: "enable", id: "sch_legacy" } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.warnings.join(" ")).toContain("will NOT run");

    // Enabling preserves the manifest — only an edit lifts the quarantine.
    built.proposal.apply({ id: "user-jesse", name: "Jesse" });
    expect(store.getScheduled("sch_legacy")!.legacyAttachmentCount).toBe(1);
  });

  it("deleting a legacy row keeps its bytes and says where they are", () => {
    store.upsertScheduled(schedule({ id: "sch_legacy", channelRef: "thread-1" }));
    const raw = new Database(path.join(dir, "test.db"));
    raw
      .prepare("UPDATE scheduled_prompts SET attachments_json = ? WHERE id = 'sch_legacy'")
      .run(JSON.stringify([{ filename: "snippet-1-17.txt", mime: "text/plain", size: 12 }]));
    raw.close();

    const svc = makeService();
    const built = svc.buildProposal(record, { schedule: { action: "delete", id: "sch_legacy" } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.warnings.join(" ")).toContain("Seam does not delete them");
    built.proposal.apply({ id: "user-jesse", name: "Jesse" });
    expect(store.getScheduled("sch_legacy")).toBeNull();
  });
});

// --- editor rendering --------------------------------------------------------

interface RenderedCard {
  embeds: Array<{ data: { description?: string; fields?: Array<{ name: string }> } }>;
  components: Array<{ components?: unknown[]; data?: { components?: unknown[] } }>;
}

/** Drive `cmdScheduleAdd` far enough to capture the card it first renders. */
async function renderBuilderCard(existing?: ScheduledPrompt): Promise<RenderedCard> {
  let card: RenderedCard | undefined;
  const interaction = {
    isChatInputCommand: () => true,
    user: { id: "user-jesse" },
    options: { getAttachment: () => null },
    reply: async (payload: RenderedCard) => {
      card = payload;
    },
    fetchReply: async () => ({
      id: "msg-1",
      createMessageComponentCollector: () => ({ on: () => {}, stop: () => {} }),
    }),
    editReply: async () => {},
  };
  const self = {
    channelRefFromInteraction: () => ({ platform: "discord", id: "thread-1", parentId: "chan-1" }),
    config: { REPOS_ROOT: "/repo" },
    router: {
      ensureSessionRecord: () => ({ id: "discord:thread-1", agentId: "claude", repoPath: "/repo" }),
      getProfile: () => ({ defaultModel: "default", staticModels: [] }),
    },
    store: { readConfig: () => ({ model: null }) },
    logger: silent,
    // #159 pairs every collector with a card lifecycle. This helper only
    // exercises the render path, so a no-op lifecycle is enough.
    attachListLifecycle: () => ({
      settled: false,
      state: null,
      reason: null,
      refresh: async () => true,
      transition: async () => true,
      terminal: async () => true,
      dispose: async () => true,
      expire: async () => true,
      handleEnd: async () => {},
    }),
  };
  await (
    Orchestrator.prototype as unknown as {
      cmdScheduleAdd(this: unknown, i: unknown, existing?: ScheduledPrompt): Promise<void>;
    }
  ).cmdScheduleAdd.call(self, interaction, existing);
  if (!card) throw new Error("builder card was never rendered");
  return card;
}

describe("#158 schedule builder card", () => {
  it("has no Files field and points at a runbook instead", async () => {
    const card = await renderBuilderCard();
    const fieldNames = (card.embeds[0]!.data.fields ?? []).map((f) => f.name);
    expect(fieldNames.some((n) => n.includes("Files"))).toBe(false);
    expect(card.embeds[0]!.data.description).toContain("runbook");
    expect(card.embeds[0]!.data.description).not.toContain("re-sent every run");
  });

  it("has no remove-file select in edit mode", async () => {
    const card = await renderBuilderCard(schedule({ legacyAttachmentCount: 2 }));
    const customIds = JSON.stringify(card.components);
    expect(customIds).not.toContain("sched:rmfile");
  });

  it("surfaces the quarantine on a legacy row so the operator knows what saving does", async () => {
    const card = await renderBuilderCard(schedule({ legacyAttachmentCount: 2 }));
    expect(card.embeds[0]!.data.description).toContain("will NOT run");
  });
});

// --- file-free dispatch ------------------------------------------------------

describe("#158 file-free dispatch", () => {
  it("a live scheduled fire synthesizes a message with no attachments key", async () => {
    const row = schedule({ sessionMode: "live", promptText: "Follow docs/runbooks/pr-status.md." });
    const seen: Array<Record<string, unknown>> = [];
    const statuses: string[] = [];
    const self = {
      adapter: { getThreadLiveState: async () => ({ locked: false, archived: false }) },
      logger: silent,
      store: { getScheduled: () => row },
      channelGenerations: new Map<string, number>(),
      queueOnChannel: async (_c: string, fn: () => Promise<void>) => fn(),
      handleIncomingMessageInner: async (m: Record<string, unknown>) => {
        seen.push(m);
      },
      patchScheduledStatus: (_id: string, status: string) => statuses.push(status),
    };
    await (
      Orchestrator.prototype as unknown as {
        runScheduledPromptInner(this: unknown, row: ScheduledPrompt): Promise<void>;
      }
    ).runScheduledPromptInner.call(self, row);

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("attachments");
    expect(seen[0]!.text).toContain("Follow docs/runbooks/pr-status.md.");
    expect(statuses).toEqual(["ok"]);
  });
});
