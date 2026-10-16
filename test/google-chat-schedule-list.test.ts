import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { scheduleUiPorts } from "../packages/core/src/core/schedule-ui.js";
import { GoogleChatAdapter } from "../packages/core/src/platforms/google-chat/adapter.js";
import { PubSubPullTransport } from "../packages/core/src/platforms/google-chat/transport.js";
import type { ScheduledPrompt } from "../packages/core/src/core/scheduled-prompts/types.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const logger = pino({ level: "silent" });
const space = { name: "spaces/home", spaceType: "SPACE", spaceThreadingState: "THREADED_MESSAGES" };
const user = (id: string) => ({ name: `users/${id}`, displayName: id, type: "HUMAN" });
const schedule = (i: number, overrides: Partial<ScheduledPrompt> = {}): ScheduledPrompt => ({
  id: `sch_${i}`, platform: "google-chat", channelRef: "home", parentRef: null, name: `schedule ${i}`,
  promptText: "run the report", cron: "0 9 * * *", timezone: "America/Chicago", sessionMode: "isolated",
  model: null, cwd: null, targetChannel: null, outputType: "card", catchupSeconds: 7200, enabled: true,
  legacyAttachmentCount: 0, createdBy: "42", createdUtc: `2026-10-01T00:00:0${i}Z`, updatedUtc: "2026-10-01T00:00:00Z",
  lastRunUtc: null, lastStatus: null, nextRunUtc: "2026-10-16T14:00:00Z", pinnedSessionId: null, ...overrides,
});

function fixture(count = 5, admins = new Set(["users/42"])) {
  const store = new SessionStore(":memory:"); cleanups.push(() => store.close());
  for (let i = 0; i < count; i++) store.upsertScheduled(schedule(i));
  store.upsertScheduled(schedule(8, { id: "discord-only", platform: "discord", name: "Discord private row" }));
  store.upsertScheduled(schedule(9, { id: "other-space", channelRef: "other", name: "Other Space row" }));
  const manager = { armFromRow: vi.fn(), disarm: vi.fn(), reschedule: vi.fn(), runNow: vi.fn(async (id: string) => {
    store.upsertScheduled({ ...store.getScheduled(id)!, lastStatus: "ok" });
  }) };
  const ports = scheduleUiPorts({ store, logger, config: { REPOS_ROOT: "/fixture" },
    manager: () => manager, runNow: vi.fn(), router: {}, modelCatalog: {} } as any,
    () => { throw new Error("not a Discord interaction"); }, () => { throw new Error("not a Discord component"); });
  const messages = new Map<string, any>();
  let sent = 0;
  const request = vi.fn(async (scope: string, r: any): Promise<any> => {
    if (scope === "pubsub") return {};
    if (r.method === "GET") return messages.get(r.url.split("/v1/")[1]);
    if (r.method === "PATCH") {
      const name = r.url.split("/v1/")[1];
      const result = { ...messages.get(name), ...r.data }; messages.set(name, result); return result;
    }
    const name = `spaces/home/messages/${r.params?.messageId ?? `sent-${++sent}`}`;
    if (messages.has(name)) throw Object.assign(new Error("already exists"), { response: { status: 409 } });
    const result = { ...r.data, name, thread: r.data.thread ?? { name: "spaces/home/threads/private-list" }, sender: { name: "users/app", type: "BOT" } };
    messages.set(name, result); return result;
  });
  const adapter = new GoogleChatAdapter({ api: { request }, subscription: "projects/test/subscriptions/events", logger,
    defaultCwd: "/fixture", allowedUserIds: new Set(["users/42", "users/43"]), writeIntervalMs: 0 });
  adapter.setCommandDeps({ store, router: {}, mutation: { readThreadPresetEntry: () => undefined },
    runtimeTransition: {}, cancelChannel: vi.fn(), configPlan: {}, modelCatalog: {},
    scheduleList: { ports, adminUserIds: admins } } as any);
  const transport = new PubSubPullTransport({ api: { request }, subscription: "projects/test/subscriptions/events", logger,
    receive: (...args) => adapter.receiveEvent(...args) });
  let publications = 0;
  const deliver = (event: unknown, id = `delivery-${++publications}`) => transport.process({ ackId: `ack-${id}`,
    message: { messageId: id, data: Buffer.from(JSON.stringify(event)).toString("base64") } });
  const open = async (actor = "42", name = `command-${actor}`) => {
    await deliver({ type: "MESSAGE", space, user: user(actor), message: {
      name: `spaces/home/messages/${name}`, text: "/schedules", argumentText: "/schedules", slashCommand: { commandId: 7 },
      thread: { name: "spaces/home/threads/invocation" }, threadReply: true,
    } });
    const card = [...messages.values()].find(m => m.cardsV2 && m.privateMessageViewer?.name === `users/${actor}`);
    expect(card, "a private schedule list must be sent through the real command path").toBeDefined();
    return card.name as string;
  };
  const button = (name: string, label: string, row?: string) => {
    const sections = messages.get(name)?.cardsV2?.flatMap((c: any) => c.card.sections) ?? [];
    const controls = sections.filter((s: any) => !row || JSON.stringify(s).includes(row))
      .flatMap((s: any) => s.widgets.flatMap((w: any) => w.buttonList?.buttons ?? []));
    const found = controls.find((b: any) => b.text === label);
    expect(found, `button ${label} for ${row ?? "list"}`).toBeDefined(); return found;
  };
  const clickRaw = (name: string, control: any, actor = "42", id?: string) => deliver({ type: "CARD_CLICKED", space,
    user: user(actor), message: messages.get(name), action: {
      actionMethodName: control.onClick.action.function, parameters: control.onClick.action.parameters,
    } }, id);
  const click = (name: string, label: string, row?: string, actor = "42", id?: string) => clickRaw(name, button(name, label, row), actor, id);
  return { store, manager, request, messages, open, click, clickRaw, button, deliver };
}

describe("private Google Chat schedule list", () => {
  it("lists only this Space's schedules privately, including native-thread schedules, and PATCHes complete pages", async () => {
    const h = fixture();
    h.store.upsertScheduled(schedule(7, { channelRef: "home.topic", parentRef: "home", name: "thread schedule" }));
    const name = await h.open();
    const text = () => JSON.stringify(h.messages.get(name));
    expect(text()).toContain("schedule 0");
    expect(text()).toContain("At 09:00 AM");
    expect(text()).toContain("2026");
    expect(text()).toContain("On");
    expect(text()).not.toContain("Discord private row");
    expect(text()).not.toContain("Other Space row");
    expect(text()).not.toContain("schedule 4");
    expect(h.messages.get(name).privateMessageViewer).toEqual({ name: "users/42" });
    await h.click(name, "Next");
    expect(text()).toContain("schedule 4"); expect(text()).toContain("thread schedule");
    expect(text()).not.toContain("schedule 0");
    await h.click(name, "Prev");
    expect(text()).toContain("schedule 0");
    const patches = h.request.mock.calls.filter(([, r]) => r.method === "PATCH").map(([, r]) => r);
    expect(patches).toHaveLength(2);
    for (const patch of patches) {
      expect(patch.url).toBe(`https://chat.googleapis.com/v1/${name}`);
      expect(patch.params).toEqual({ updateMask: "cardsV2" });
      expect(patch.data.cardsV2).toHaveLength(1);
      expect(patch.data.privateMessageViewer).toBeUndefined();
    }
    expect(h.messages.get(name).privateMessageViewer).toEqual({ name: "users/42" });
  });

  it("lets a member run now, while admins alone pause/resume and confirm deletion", async () => {
    const h = fixture(1), member = await h.open("43");
    const memberView = JSON.stringify(h.messages.get(member));
    expect(memberView).not.toContain('"text":"Pause"'); expect(memberView).not.toContain('"text":"Delete"');
    await h.click(member, "Run now", "schedule 0", "43");
    expect(h.manager.runNow).toHaveBeenCalledExactlyOnceWith("sch_0");
    const admin = await h.open();
    await h.click(admin, "Pause", "schedule 0");
    expect(h.store.getScheduled("sch_0")?.enabled).toBe(false);
    expect(h.manager.disarm).toHaveBeenCalledExactlyOnceWith("sch_0");
    await h.click(admin, "Resume", "schedule 0");
    expect(h.store.getScheduled("sch_0")?.enabled).toBe(true);
    expect(h.manager.armFromRow).toHaveBeenCalledWith(expect.objectContaining({ id: "sch_0", enabled: true }));
    await h.click(admin, "Delete", "schedule 0");
    expect(h.store.getScheduled("sch_0")).not.toBeNull();
    expect(JSON.stringify(h.messages.get(admin))).toContain('"text":"Confirm"');
    await h.click(admin, "Cancel", "schedule 0");
    expect(h.store.getScheduled("sch_0")).not.toBeNull();
    await h.click(admin, "Delete", "schedule 0");
    await h.click(admin, "Confirm", "schedule 0");
    expect(h.store.getScheduled("sch_0")).toBeNull();
    expect(JSON.stringify(h.messages.get(admin))).toContain("No schedules");
  });

  it("has no mutation admins when the set is empty and never lets another viewer operate a private list", async () => {
    const h = fixture(1, new Set()), name = await h.open();
    expect(JSON.stringify(h.messages.get(name))).not.toContain('"text":"Pause"');
    const run = h.button(name, "Run now");
    await h.clickRaw(name, run, "43");
    expect(h.manager.runNow).not.toHaveBeenCalled();
    expect(h.request.mock.calls.filter(([, r]) => r.method === "PATCH")).toHaveLength(0);
    expect([...h.messages.values()].some(m => m.privateMessageViewer?.name === "users/43" && /own|another|belongs/i.test(m.text))).toBe(true);
  });

  it("checks mutation permission and Space scope even when button parameters are altered", async () => {
    const h = fixture(1), admin = await h.open(), member = await h.open("43");
    const pause = h.button(admin, "Pause");
    const changed = (values: Record<string, string>) => ({ ...pause, onClick: { action: { ...pause.onClick.action,
      parameters: pause.onClick.action.parameters.map((p: any) => ({ ...p, value: values[p.key] ?? p.value })),
    } } });
    await h.clickRaw(member, changed({ viewer: "users/43" }), "43");
    expect(h.store.getScheduled("sch_0")?.enabled).toBe(true);
    expect(h.manager.disarm).not.toHaveBeenCalled();
    await h.clickRaw(admin, changed({ id: "other-space" }));
    await h.clickRaw(admin, changed({ id: "discord-only" }));
    expect(h.store.getScheduled("other-space")?.enabled).toBe(true);
    expect(h.store.getScheduled("discord-only")?.enabled).toBe(true);
    expect(h.manager.disarm).not.toHaveBeenCalled();
  });

  it("retains the page through mutations and reclamps after deleting the final row", async () => {
    const h = fixture(), name = await h.open();
    await h.click(name, "Next");
    await h.click(name, "Pause", "schedule 4");
    expect(JSON.stringify(h.messages.get(name))).not.toContain("schedule 0");
    await h.click(name, "Delete", "schedule 4");
    await h.click(name, "Confirm", "schedule 4");
    expect(h.store.getScheduled("sch_4")).toBeNull();
    expect(JSON.stringify(h.messages.get(name))).toContain("schedule 0");
  });

  it("does not repeat Run now after a failed PATCH and Pub/Sub redelivery", async () => {
    const h = fixture(1), name = await h.open(), control = h.button(name, "Run now");
    const normal = h.request.getMockImplementation()!;
    let fail = true;
    h.request.mockImplementation(async (scope, r) => {
      if (r.method === "PATCH" && fail) { fail = false; throw new Error("Chat PATCH connection lost"); }
      return normal(scope, r);
    });
    await expect(h.clickRaw(name, control, "42", "same-publication")).rejects.toThrow("Chat PATCH connection lost");
    await h.clickRaw(name, control, "42", "same-publication");
    expect(h.manager.runNow).toHaveBeenCalledExactlyOnceWith("sch_0");
    expect(JSON.stringify(h.messages.get(name))).toContain("finished");
  });

  it("preserves the real scheduler error in the private refreshed list", async () => {
    const h = fixture(1), name = await h.open();
    h.manager.runNow.mockRejectedValueOnce(new Error("bridge worker unavailable: original cause"));
    await h.click(name, "Run now", "schedule 0");
    expect(JSON.stringify(h.messages.get(name))).toContain("bridge worker unavailable: original cause");
    expect(h.messages.get(name).privateMessageViewer).toEqual({ name: "users/42" });
  });
});
