import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { Events } from "discord.js";
import { Readable } from "node:stream";
import {
  SyntheticInteraction,
  validateSlashSpec,
} from "../packages/core/src/platforms/discord/synthetic-interaction.js";
import { buildSlashRegistrationBody } from "../packages/core/src/platforms/discord/commands.js";
import {
  makeTestDispatchHandler,
  makeTestInteractionHandler,
  makeTestRestartHandler,
} from "../packages/core/src/core/test-driver.js";

function context(now: { t: number }) {
  const sent: Array<{ content?: string }> = [];
  const message = {
    id: "m1",
    edit: vi.fn(async (o: { content?: string }) => ({ id: "m1", ...o })),
    delete: vi.fn(async () => {}),
  };
  const channel = {
    id: "c1",
    guildId: "g1",
    send: vi.fn(async (o: { content?: string }) => { sent.push(o); return { id: `s${sent.length}`, edit: vi.fn(async () => ({ id: `s${sent.length}` })) }; }),
  };
  return {
    sent,
    message,
    ctx: { client: {} as never, channel: channel as never, user: { id: "tester" } as never, member: null, message: message as never, now: () => now.t },
  };
}

describe("SyntheticInteraction keeps Discord's interaction rules", () => {
  it("acknowledges once; a second acknowledgement is 40060", async () => {
    const now = { t: 0 };
    const { ctx } = context(now);
    const i = new SyntheticInteraction({ kind: "button", channelId: "c1", messageId: "m1", customId: "x" }, ctx);
    expect(i.isButton()).toBe(true);
    await i.deferUpdate();
    await expect(i.reply("again")).rejects.toMatchObject({ code: 40060 });
    expect(i.transcript.map((e) => e.op)).toEqual(["deferUpdate", "reply"]);
  });

  it("acknowledging after 3 s is 10062 Unknown interaction", async () => {
    const now = { t: 0 };
    const { ctx } = context(now);
    const i = new SyntheticInteraction({ kind: "button", channelId: "c1", messageId: "m1", customId: "x" }, ctx);
    now.t = 3_001;
    await expect(i.reply("late")).rejects.toMatchObject({ code: 10062 });
  });

  it("follow-ups need an acknowledgement and stop after 15 minutes (50027)", async () => {
    const now = { t: 0 };
    const { ctx } = context(now);
    const i = new SyntheticInteraction({ kind: "slash", channelId: "c1", command: "seam" }, ctx);
    await expect(i.followUp("early")).rejects.toMatchObject({ code: "InteractionNotReplied" });
    await i.deferReply({ ephemeral: true });
    now.t = 14 * 60_000;
    await i.editReply("done");
    now.t = 15 * 60_000 + 1;
    await expect(i.followUp("too late")).rejects.toMatchObject({ code: 50027 });
  });

  it("posts ephemeral replies for real with a marker, and update edits the clicked message", async () => {
    const now = { t: 0 };
    const { ctx, sent, message } = context(now);
    const a = new SyntheticInteraction({ kind: "slash", channelId: "c1", command: "seam" }, ctx);
    await a.reply({ content: "secret", flags: 64 });
    expect(sent[0]!.content).toMatch(/^👁️ \*ephemeral.*\nsecret$/);
    expect(a.transcript[0]).toMatchObject({ op: "reply", ephemeral: true, content: "secret" });
    const b = new SyntheticInteraction({ kind: "select", channelId: "c1", messageId: "m1", customId: "pick", values: ["2"] }, ctx);
    expect(b.values).toEqual(["2"]);
    await b.update({ content: "picked 2" });
    expect(message.edit).toHaveBeenCalled();
  });

  it("records the form a handler opens, and serves submitted fields", async () => {
    const now = { t: 0 };
    const { ctx } = context(now);
    const i = new SyntheticInteraction({ kind: "button", channelId: "c1", messageId: "m1", customId: "x" }, ctx);
    await i.showModal({ custom_id: "form", title: "Tell me", components: [{ components: [{ custom_id: "note", label: "Note" }] }] });
    expect(i.transcript[0]!.modal).toEqual({ customId: "form", title: "Tell me", inputs: [{ id: "note", label: "Note" }] });
    const m = new SyntheticInteraction({ kind: "modal", channelId: "c1", customId: "form", fields: { note: "hi" } }, ctx);
    expect(m.fields!.getTextInputValue("note")).toBe("hi");
    expect(() => m.fields!.getTextInputValue("missing")).toThrow();
  });

  it("edits a named follow-up without replacing the component's original reply", async () => {
    const now = { t: 0 };
    const { ctx, message } = context(now);
    const target = { id: "editor", content: "👁️ *ephemeral — only the tester would see this*\nold", edit: vi.fn(async () => ({ id: "editor" })) };
    Object.assign(ctx.channel, { messages: { fetch: vi.fn(async () => target) } });
    const i = new SyntheticInteraction({ kind: "button", channelId: "c1", messageId: "m1", customId: "sl:edit:test" }, ctx);
    await i.deferUpdate();
    await i.editReply({ content: "updated", message: "editor" });
    expect(target.edit).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("updated") }));
    expect(message.edit).not.toHaveBeenCalled();
    expect(i.transcript.at(-1)).toMatchObject({ op: "editReply", ephemeral: true, messageId: "editor" });
  });

  it("resolves a slash command's modal waiter from a later submission", async () => {
    const now = { t: 0 };
    const { ctx } = context(now);
    const client = new EventEmitter();
    const slash = new SyntheticInteraction(
      { kind: "slash", channelId: "c1", command: "seam" },
      { ...ctx, client: client as never },
    );
    const submission = slash.awaitModalSubmit({
      filter: (i) => i.customId === "form" && i.user.id === "tester",
      time: 1_000,
    });
    const modal = new SyntheticInteraction(
      { kind: "modal", channelId: "c1", customId: "form", fields: { note: "hi" } },
      { ...ctx, client: client as never },
    );
    client.emit(Events.InteractionCreate, modal);
    await expect(submission).resolves.toBe(modal);
  });
});

describe("validateSlashSpec checks against the registered commands", () => {
  const commands = buildSlashRegistrationBody();
  it("accepts a real subcommand and rejects unknown ones and bad options", () => {
    expect(() => validateSlashSpec({ kind: "slash", channelId: "c", command: "seam", subcommand: "cancel" }, commands)).not.toThrow();
    expect(() => validateSlashSpec({ kind: "slash", channelId: "c", command: "seam", subcommand: "nope" }, commands)).toThrow(/no subcommand "nope"/);
    expect(() => validateSlashSpec({ kind: "slash", channelId: "c", command: "nope" }, commands)).toThrow(/unknown command/);
    expect(() => validateSlashSpec({ kind: "slash", channelId: "c", command: "seam" }, commands)).toThrow(/needs a subcommand/);
    expect(() => validateSlashSpec({ kind: "slash", channelId: "c", command: "seam", subcommand: "cancel", options: { bogus: "x" } }, commands)).toThrow(/not declared/);
  });
});

describe("test interaction HTTP handler", () => {
  function req(body: unknown, auth?: string) {
    const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as Record<string, unknown>;
    r.method = "POST";
    r.headers = auth ? { authorization: auth } : {};
    return r as never;
  }
  function res() {
    const out: { status?: number; body?: string } = {};
    return { out, r: { writeHead: (s: number) => { out.status = s; }, end: (b: string) => { out.body = b; } } as never };
  }
  it("refuses a wrong key and injects with the right one", async () => {
    const inject = vi.fn(async () => ({ transcript: [], replied: true, deferred: false }));
    const handler = makeTestInteractionHandler({ key: "k", actorId: "tester", inject, logger: { info: vi.fn() } as never });
    const bad = res();
    await handler(req({ kind: "button" }, "Bearer nope"), bad.r);
    expect(bad.out.status).toBe(401);
    expect(inject).not.toHaveBeenCalled();
    const good = res();
    await handler(req({ kind: "button", channelId: "c" }, "Bearer k"), good.r);
    expect(good.out.status).toBe(200);
    expect(inject).toHaveBeenCalledWith({ kind: "button", channelId: "c" }, "tester");
  });
});

describe("test restart HTTP handler", () => {
  function req(body: unknown, auth = "Bearer k") {
    const r = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as Record<string, unknown>;
    r.method = "POST";
    r.headers = { authorization: auth };
    return r as never;
  }

  it("answers before it performs an allowlisted restart", async () => {
    let ended = false;
    const restart = vi.fn(() => expect(ended).toBe(true));
    const prepare = vi.fn(() => restart);
    const out: { status?: number; body?: string } = {};
    const res = {
      writeHead: (status: number) => { out.status = status; },
      end: (body: string) => { out.body = body; ended = true; },
    } as never;
    const handler = makeTestRestartHandler({
      key: "k",
      prepare,
      logger: { warn: vi.fn(), error: vi.fn() } as never,
      delayMs: 0,
    });
    await handler(req({ action: "sessiond" }), res);
    expect(out.status).toBe(202);
    expect(restart).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(prepare).toHaveBeenCalledWith("sessiond");
    expect(restart).toHaveBeenCalledOnce();
  });
});

describe("test dispatch HTTP handler", () => {
  function request(body: unknown, auth = "Bearer k") {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as Record<string, unknown>;
    req.method = "POST";
    req.headers = { authorization: auth };
    return req as never;
  }

  it("authenticates and enqueues the exact live dispatch request", async () => {
    const enqueue = vi.fn(async () => {});
    const handler = makeTestDispatchHandler({
      key: "k",
      enqueue,
      logger: { info: vi.fn() } as never,
    });
    const out: { status?: number; body?: string } = {};
    const response = {
      writeHead: (status: number) => { out.status = status; },
      end: (body: string) => { out.body = body; },
    } as never;
    const spec = {
      id: "canary-dispatch-id",
      channelId: "1553671326785339402",
      prompt: "run two tools",
    };

    await handler(request(spec), response);

    expect(out.status).toBe(202);
    expect(JSON.parse(out.body ?? "{}")).toEqual({ accepted: true, id: spec.id });
    expect(enqueue).toHaveBeenCalledWith(spec);
  });
});
