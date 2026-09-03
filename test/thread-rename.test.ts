import { describe, expect, it, vi } from "vitest";
import { MessageFlags } from "discord.js";
import {
  buildSeamAdminCommand,
  buildSeamCommand,
} from "../packages/core/src/platforms/discord/commands.js";
import { Orchestrator } from "../packages/core/src/platforms/discord/orchestrator.js";

const ADMIN_ID = "admin-1";
const ADMINS = new Set([ADMIN_ID]);

describe("/seamadmin naming rename and namer surfaces", () => {
  it("publishes thread/channel rename, explicit legacy migration, and namer editor", () => {
    // #151 moved both leaves out of `/seam config` into `/seamadmin naming`.
    const command = buildSeamAdminCommand().toJSON();
    const naming = command.options?.find((option) => option.name === "naming");
    const rename = naming?.options?.find((option) => option.name === "rename");
    const namer = naming?.options?.find((option) => option.name === "namer");

    expect(rename).toBeDefined();
    expect(rename?.options?.find((option) => option.name === "scope")?.choices)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "thread", value: "thread" }),
        expect.objectContaining({ name: "channel", value: "channel" }),
      ]));
    expect(rename?.options?.find((option) => option.name === "migrate-legacy")?.type).toBe(5);
    expect(rename?.options?.map((option) => option.name)).toEqual([
      "scope",
      "migrate-legacy",
      "role-name",
    ]);
    expect(rename?.options?.find((option) => option.name === "role-name")?.type).toBe(5);
    expect(namer).toBeDefined();

    // …and are gone from `/seam config`, so a non-admin has no path to them.
    const seamConfig = buildSeamCommand()
      .toJSON()
      .options?.find((option) => option.name === "config");
    const configLeaves = (seamConfig?.options ?? []).map((option) => option.name);
    expect(configLeaves).not.toContain("rename");
    expect(configLeaves).not.toContain("namer");
  });

  it("restores the descriptions #150 had to delete for the 8,000-char budget", () => {
    const naming = buildSeamAdminCommand()
      .toJSON()
      .options?.find((option) => option.name === "naming");
    const rename = naming?.options?.find((option) => option.name === "rename");
    expect(rename?.description).toBe("Refresh/migrate names");
    expect(rename?.options?.find((o) => o.name === "scope")?.description).toBe("Rename scope");
    expect(rename?.options?.find((o) => o.name === "migrate-legacy")?.description).toBe(
      "Migrate legacy prefix"
    );
  });

  it("shows naming state without reapplying after core configure already ran the funnel", async () => {
    const target = {
      id: "discord:thread-123",
      platform: "discord",
      channelRef: "thread-123",
      parentRef: "channel-456",
    };
    const applyThreadName = vi.fn(async () => ({ status: "renamed" }));
    let posted: any;
    const mock = {
      store: { get: () => target },
      applyThreadName,
      adapter: {
        sendPanel: async (_channel: unknown, panel: unknown) => {
          posted = panel;
          return { id: "card-1", channelId: "thread-123" };
        },
      },
      router: {
        getProfile: () => ({ id: "claude", displayName: "Claude" }),
      },
      logger: { warn: () => {} },
      presentThreadConfigurationChange: Orchestrator.prototype.presentThreadConfigurationChange,
    } as any;

    const result = await mock.presentThreadConfigurationChange(
      { channelRef: "caller" },
      target,
      {
        ok: true,
        applied: {
          agent: "claude",
          model: "claude-opus-5",
          effort: "high",
          role: "orch",
          disableThreadPrefix: false,
          fastMode: false,
        },
        changes: {
          agent: { before: "agy", after: "claude", changed: true },
          model: { before: "gemini", after: "claude-opus-5", changed: true },
          effort: { before: "high", after: "high", changed: false },
          role: { before: "auto", after: "orch", changed: true },
          disableThreadPrefix: { before: "enabled", after: "enabled", changed: false },
          fastMode: { before: "off", after: "off", changed: false },
        },
        sessionReset: true,
        resetReason: "agent-switch",
        runtimeReloaded: false,
        threadIdentityUpdated: true,
        warnings: [],
      }
    );

    expect(result).toMatchObject({ confirmationPosted: true, threadIdentityUpdated: true });
    expect(applyThreadName).not.toHaveBeenCalled();
    expect(posted.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Agent", value: expect.stringContaining("Changed from") }),
      expect.objectContaining({ name: "Role", value: expect.stringContaining("orch") }),
    ]));
  });

  it("defers channel recompaction before work and edits a failure-aware summary", async () => {
    const events: string[] = [];
    const reply = vi.fn(async () => { events.push("reply"); });
    const deferReply = vi.fn(async () => { events.push("defer"); });
    const editReply = vi.fn(async () => { events.push("edit"); });
    const recompactChannel = vi.fn(async () => {
      events.push("recompact");
      expect(deferReply).toHaveBeenCalledOnce();
      return [
        { status: "rebuilt" },
        { status: "renamed" },
        { status: "unchanged" },
        { status: "unmanaged" },
        { status: "gone" },
        { status: "failed" },
      ];
    });
    const mock = {
      recordFromInteraction: () => ({
        id: "discord:thread-123",
        platform: "discord",
        channelRef: "thread-123",
        parentRef: "channel-456",
      }),
      threadNamer: { recompactChannel },
      config: { SEAM_CONFIG_ADMIN_USER_IDS: ADMINS },
    } as any;
    const interaction = {
      user: { id: ADMIN_ID },
      options: {
        getString: () => "channel",
        getBoolean: (name: string) => name === "role-name",
      },
      reply,
      deferReply,
      editReply,
    } as any;

    await (Orchestrator.prototype as any).cmdThreadRename.call(mock, interaction);

    expect(events).toEqual(["defer", "recompact", "edit"]);
    expect(reply).not.toHaveBeenCalled();
    expect(recompactChannel).toHaveBeenCalledWith("discord", "channel-456", {
      migrateLegacy: false,
      roleName: true,
    });
    expect(editReply).toHaveBeenCalledWith({
      content: "Recomputed 6 channel thread(s): 1 rebuilt, 1 renamed, 1 unchanged, 1 left untouched, 1 gone, 1 failed.",
    });
  });

  it("defers the single-thread rename and edits instead of replying twice", async () => {
    const events: string[] = [];
    const reply = vi.fn(async () => { events.push("reply"); });
    const deferReply = vi.fn(async () => { events.push("defer"); });
    const editReply = vi.fn(async () => { events.push("edit"); });
    const applyThreadName = vi.fn(async () => {
      events.push("rename");
      expect(deferReply).toHaveBeenCalledOnce();
      return { status: "rebuilt", name: "🤖 worker" };
    });
    const mock = {
      recordFromInteraction: () => ({
        id: "discord:thread-123",
        platform: "discord",
        channelRef: "thread-123",
        parentRef: "channel-456",
      }),
      applyThreadName,
      config: { SEAM_CONFIG_ADMIN_USER_IDS: ADMINS },
    } as any;
    const interaction = {
      user: { id: ADMIN_ID },
      options: {
        getString: () => "thread",
        getBoolean: () => true,
      },
      reply,
      deferReply,
      editReply,
    } as any;

    await (Orchestrator.prototype as any).cmdThreadRename.call(mock, interaction);

    expect(events).toEqual(["defer", "rename", "edit"]);
    expect(reply).not.toHaveBeenCalled();
    expect(applyThreadName).toHaveBeenCalledWith(expect.any(Object), {
      migrateLegacy: true,
      roleName: true,
    });
    expect(editReply).toHaveBeenCalledWith({ content: "Rebuilt as 🤖 worker." });
  });
});

/**
 * `/seam config rename` shipped with NO privilege check (#151): its only guards
 * were "Use inside a thread" and "This thread has no parent channel", so any
 * user who could invoke `/seam` could trigger a channel-wide destructive rename
 * — including `migrate-legacy:true` and `role-name:true`, which rebuild every
 * thread name in the channel from scratch.
 *
 * The gate matches `cmdNamerEditor`: an UNSET `SEAM_CONFIG_ADMIN_USER_IDS` is
 * opt-out, NOT deny-all (see config-admin-ids.test.ts), and the refusal happens
 * before `deferReply` so nothing is started for a refused caller.
 *
 * The leaf now lives at `/seamadmin naming rename`, whose ManageGuild default
 * permission hides it from non-admins — but that is VISIBILITY, not authorization
 * (a guild admin can grant the command to anyone), so this handler gate stays.
 */
describe("/seamadmin naming rename admin gate (#151/#160)", () => {
  const RENAME_REFUSAL = "Renaming threads requires a config admin.";

  function harness(opts: {
    admins?: Set<string>;
    userId: string;
    scope: "thread" | "channel";
  }) {
    const reply = vi.fn(async () => {});
    const deferReply = vi.fn(async () => {});
    const editReply = vi.fn(async () => {});
    const applyThreadName = vi.fn(async () => ({ status: "renamed", name: "🤖 worker" }));
    const recompactChannel = vi.fn(async () => [{ status: "renamed" }]);
    const recordFromInteraction = vi.fn(() => ({
      id: "discord:thread-123",
      platform: "discord",
      channelRef: "thread-123",
      parentRef: "channel-456",
    }));
    const mock = {
      recordFromInteraction,
      applyThreadName,
      threadNamer: { recompactChannel },
      config: { SEAM_CONFIG_ADMIN_USER_IDS: opts.admins },
    } as any;
    const interaction = {
      user: { id: opts.userId },
      options: {
        getString: () => opts.scope,
        getBoolean: () => false,
      },
      reply,
      deferReply,
      editReply,
    } as any;
    const run = () => (Orchestrator.prototype as any).cmdThreadRename.call(mock, interaction);
    return { run, reply, deferReply, editReply, applyThreadName, recompactChannel, recordFromInteraction };
  }

  it("refuses a non-admin ephemerally without deferring or renaming anything", async () => {
    const h = harness({ admins: ADMINS, userId: "rando", scope: "thread" });
    await h.run();

    expect(h.reply).toHaveBeenCalledWith({
      content: RENAME_REFUSAL,
      flags: MessageFlags.Ephemeral,
    });
    expect(h.deferReply).not.toHaveBeenCalled();
    expect(h.editReply).not.toHaveBeenCalled();
    expect(h.applyThreadName).not.toHaveBeenCalled();
    expect(h.recompactChannel).not.toHaveBeenCalled();
    // Gate runs before any state is inspected, so a refused caller learns
    // nothing about whether this thread is even a bound session.
    expect(h.recordFromInteraction).not.toHaveBeenCalled();
  });

  it("refuses a non-admin on the channel-wide scope — the destructive one", async () => {
    const h = harness({ admins: ADMINS, userId: "rando", scope: "channel" });
    await h.run();

    expect(h.reply).toHaveBeenCalledWith({
      content: RENAME_REFUSAL,
      flags: MessageFlags.Ephemeral,
    });
    expect(h.deferReply).not.toHaveBeenCalled();
    expect(h.recompactChannel).not.toHaveBeenCalled();
  });

  it("allows a config admin to rename this thread", async () => {
    const h = harness({ admins: ADMINS, userId: ADMIN_ID, scope: "thread" });
    await h.run();

    expect(h.reply).not.toHaveBeenCalled();
    expect(h.deferReply).toHaveBeenCalledOnce();
    expect(h.applyThreadName).toHaveBeenCalledOnce();
  });

  it("allows a config admin to recompact the whole channel", async () => {
    const h = harness({ admins: ADMINS, userId: ADMIN_ID, scope: "channel" });
    await h.run();

    expect(h.reply).not.toHaveBeenCalled();
    expect(h.deferReply).toHaveBeenCalledOnce();
    expect(h.recompactChannel).toHaveBeenCalledOnce();
  });

  it("unset SEAM_CONFIG_ADMIN_USER_IDS stays allowed (opt-out, not deny-all)", async () => {
    const h = harness({ admins: undefined, userId: "anyone", scope: "channel" });
    await h.run();

    expect(h.reply).not.toHaveBeenCalled();
    expect(h.deferReply).toHaveBeenCalledOnce();
    expect(h.recompactChannel).toHaveBeenCalledOnce();
  });
});
