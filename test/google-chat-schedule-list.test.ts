import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { scheduleUiPorts } from "../packages/core/src/core/schedule-ui.js";
import { ScheduledPromptManager } from "../packages/core/src/core/scheduled-prompts/manager.js";
import { syntheticScheduleExecution } from "./scheduled-admission-fixture.js";
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
  const manager = { armFromRow: vi.fn(), disarm: vi.fn(), reschedule: vi.fn(), runNow: vi.fn(async (id: string, onReserved?: () => void) => {
    onReserved?.();
    store.upsertScheduled({ ...store.getScheduled(id)!, lastStatus: "ok" });
  }) };
  const ports = scheduleUiPorts({ store, logger, config: { REPOS_ROOT: "/fixture" },
    manager: () => manager, runNow: vi.fn(), router: {}, modelCatalog: {} } as any,
    () => { throw new Error("not a Discord interaction"); }, () => { throw new Error("not a Discord component"); });
  ports.builderDefaults = vi.fn(() => ({ agent: "codex", registered: true, model: "session-model", cwd: "/fixture/repo",
    models: [{ modelId: "other-model", name: "Other model" }] }));
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
  const clickRaw = (name: string, control: any, actor = "42", id?: string, fields?: Record<string, string>) => deliver({ type: "CARD_CLICKED", space,
    user: user(actor), message: messages.get(name), ...(fields ? { common: { formInputs: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, { stringInputs: { value: [value] } }])) } } : {}), action: {
      actionMethodName: control.onClick.action.function, parameters: control.onClick.action.parameters,
    } }, id);
  const click = (name: string, label: string, row?: string, actor = "42", id?: string) => clickRaw(name, button(name, label, row), actor, id);
  const widgets = (name: string): any[] => messages.get(name).cardsV2.flatMap((c: any) => c.card.sections.flatMap((s: any) => s.widgets));
  const fields = (name: string): Record<string, string> => Object.fromEntries(widgets(name).flatMap(w => w.textInput
    ? [[w.textInput.name, w.textInput.value ?? ""]]
    : w.selectionInput ? [[w.selectionInput.name, w.selectionInput.items.find((i: any) => i.selected)?.value ?? ""]] : []));
  const submit = (name: string, values: Record<string, string> = {}, id?: string) => clickRaw(name, button(name, "Save"), "42", id, { ...fields(name), ...values });
  const change = (name: string, field: string, value: string, overrides: Record<string, string> = {}) => {
    const input = widgets(name).find(w => w.selectionInput?.name === field).selectionInput;
    return clickRaw(name, { onClick: { action: input.onChangeAction } }, "42", undefined, { ...fields(name), ...overrides, [field]: value });
  };
  return { store, manager, ports, request, messages, open, click, clickRaw, button, deliver, widgets, fields, submit, change };
}

describe("private Google Chat schedule list", () => {
  it.each(["live", "isolated"] as const)("acknowledges Run now after durable reservation while the %s turn is still running", async sessionMode => {
    const h = fixture(1), name = await h.open(), control = h.button(name, "Run now");
    h.store.upsertScheduled({ ...h.store.getScheduled("sch_0")!, sessionMode });
    let finish!: () => void, completed = false, acknowledged = false;
    const execution = new Promise<void>(resolve => { finish = resolve; });
    const onFire = vi.fn(async (_id, key) => {
      await execution;
      completed = true;
      h.store.scheduledOccurrences.settle(key.id);
      h.store.upsertScheduled({ ...h.store.getScheduled("sch_0")!, lastStatus: "ok" });
    });
    const manager = new ScheduledPromptManager({ store: h.store, logger, onFire, resolveExecution: syntheticScheduleExecution });
    h.manager.runNow.mockImplementation(manager.runNow.bind(manager));
    const click = h.clickRaw(name, control, "42", "running-click").then(() => { acknowledged = true; });
    try {
      await vi.waitFor(() => expect(acknowledged, "the click must not await the scheduled turn").toBe(true), { timeout: 500 });
      expect(completed).toBe(false);
      expect(h.store.scheduledOccurrences.pending()).toHaveLength(1);
      expect(h.store.listInboundNonterminal()).toEqual([]);
      expect(JSON.stringify(h.messages.get(name))).toContain("started");
      expect(JSON.stringify(h.messages.get(name))).not.toContain("finished");
      await h.clickRaw(name, control, "42", "running-click");
      expect(onFire).toHaveBeenCalledOnce();
      expect(h.store.scheduledOccurrences.pending()).toHaveLength(1);
      expect(h.request.mock.calls.filter(([scope, r]) => scope === "pubsub" && r.data.ackIds?.includes("ack-running-click"))).toHaveLength(2);
      await h.open("43");
      expect(completed).toBe(false);
    } finally {
      finish();
      await click;
      await manager.drain();
      manager.stop();
    }
  });

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
    expect(h.manager.runNow).toHaveBeenCalledExactlyOnceWith("sch_0", expect.any(Function));
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

  it("does not repeat Run now after a retried PATCH and failed Pub/Sub ACK", async () => {
    const h = fixture(1), name = await h.open(), control = h.button(name, "Run now");
    const normal = h.request.getMockImplementation()!;
    let failPatch = true, failAck = true;
    h.request.mockImplementation(async (scope, r) => {
      if (r.method === "PATCH" && failPatch) { failPatch = false; throw new Error("Chat PATCH connection lost"); }
      if (scope === "pubsub" && failAck) { failAck = false; throw new Error("Pub/Sub ACK connection lost"); }
      return normal(scope, r);
    });
    await expect(h.clickRaw(name, control, "42", "same-publication")).rejects.toThrow("Pub/Sub ACK connection lost");
    await h.clickRaw(name, control, "42", "same-publication");
    expect(h.manager.runNow).toHaveBeenCalledExactlyOnceWith("sch_0", expect.any(Function));
    expect(h.request.mock.calls.filter(([, r]) => r.method === "PATCH")).toHaveLength(2);
    expect(JSON.stringify(h.messages.get(name))).toContain("started");
  });

  it("preserves the real scheduler error in the private refreshed list", async () => {
    const h = fixture(1), name = await h.open();
    h.manager.runNow.mockRejectedValueOnce(new Error("bridge worker unavailable: original cause"));
    await h.click(name, "Run now", "schedule 0");
    expect(JSON.stringify(h.messages.get(name))).toContain("bridge worker unavailable: original cause");
    expect(h.messages.get(name).privateMessageViewer).toEqual({ name: "users/42" });
  });

  it("reports an occurrence reservation failure without claiming that the run started", async () => {
    const h = fixture(1), name = await h.open(), onFire = vi.fn(async () => {});
    const manager = new ScheduledPromptManager({ store: h.store, logger, onFire, resolveExecution: syntheticScheduleExecution });
    h.manager.runNow.mockImplementation(manager.runNow.bind(manager));
    vi.spyOn(h.store.scheduledOccurrences, "reserve").mockImplementationOnce(() => { throw new Error("SQLITE_FULL: occurrence reservation failed"); });
    try {
      await h.click(name, "Run now");
      expect(JSON.stringify(h.messages.get(name))).toContain("SQLITE_FULL: occurrence reservation failed");
      expect(JSON.stringify(h.messages.get(name))).not.toContain("started");
      expect(h.store.scheduledOccurrences.pending()).toEqual([]);
      expect(onFire).not.toHaveBeenCalled();
    } finally { await manager.drain(); manager.stop(); }
  });

  it.each(["overlap", "quarantine"])("retains the existing %s notice when Run now is not reserved", async reason => {
    const h = fixture(1), name = await h.open(), onFire = vi.fn(async () => {});
    if (reason === "quarantine") (h.store as any).db.prepare("UPDATE scheduled_prompts SET attachments_json = ? WHERE id = ?")
      .run('[{"filename":"legacy.txt"}]', "sch_0");
    else h.store.scheduledOccurrences.reserve({ id: "prior-occurrence", scheduledFor: null }, h.store.getScheduled("sch_0")!);
    const manager = new ScheduledPromptManager({ store: h.store, logger, onFire, resolveExecution: syntheticScheduleExecution });
    h.manager.runNow.mockImplementation(manager.runNow.bind(manager));
    try {
      await h.click(name, "Run now");
      const card = JSON.stringify(h.messages.get(name));
      expect(card).toContain(reason === "quarantine" ? "quarantined" : "already running");
      expect(card).not.toContain("started");
      expect(onFire).not.toHaveBeenCalled();
    } finally { await manager.drain(); manager.stop(); }
  });
});


describe("Google Chat inline schedule editor", () => {
  it("offers Add and Edit only to admins and keeps the form on the original private message", async () => {
    const h = fixture(1), member = await h.open("43"), name = await h.open();
    expect(JSON.stringify(h.messages.get(member))).not.toContain('"text":"Add schedule"');
    expect(JSON.stringify(h.messages.get(member))).not.toContain('"text":"Edit"');
    await h.click(name, "Add schedule");
    expect(h.fields(name)).toMatchObject({ name: "", prompt: "", timezone: "America/Chicago", mode: "isolated", model: "__default__", cwd: "", target: "", output: "card" });
    expect(h.messages.get(name).privateMessageViewer).toEqual({ name: "users/42" });
    expect(h.request.mock.calls.filter(([, r]) => r.method === "PATCH").at(-1)?.[1]).toMatchObject({
      url: `https://chat.googleapis.com/v1/${name}`, params: { updateMask: "cardsV2" }, data: { cardsV2: expect.any(Array) },
    });
    const save = h.button(name, "Save");
    const forged = { ...save, onClick: { action: { ...save.onClick.action, parameters: save.onClick.action.parameters.map((p: any) => ({ ...p, value: p.key === "viewer" ? "users/43" : p.value })) } } };
    await h.clickRaw(member, forged, "43", undefined, { ...h.fields(name), name: "not allowed", prompt: "run", cadence: "0 * * * *" });
    expect(h.store.listScheduledByChannel("google-chat", "home")).toHaveLength(1);
    expect(h.manager.armFromRow).not.toHaveBeenCalled();
  });

  it("saves a preset with the shared defaults, repo path and native Chat target", async () => {
    const h = fixture(0), name = await h.open();
    await h.click(name, "Add schedule");
    await h.submit(name, { name: "  Weekly report  ", prompt: "  Read the runbook.  ", cadence: "0 9 * * 1", timezone: "UTC",
      model: "other-model", cwd: "repo", output: "messages", target: "spaces/destination/threads/topic" });
    const rows = h.store.listScheduledByChannel("google-chat", "home");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: "google-chat", channelRef: "home", name: "Weekly report", promptText: "Read the runbook.",
      cron: "0 9 * * 1", timezone: "UTC", sessionMode: "isolated", model: "other-model", cwd: "/fixture/repo", targetChannel: "destination.topic",
      outputType: "messages", createdBy: "42", catchupSeconds: 7200, enabled: true, legacyAttachmentCount: 0, lastStatus: null, pinnedSessionId: null });
    expect(rows[0]?.nextRunUtc).toBeTruthy();
    expect(h.manager.armFromRow).toHaveBeenCalledExactlyOnceWith(rows[0]);
    expect(JSON.stringify(h.messages.get(name))).toContain("Weekly report");
    expect(h.widgets(name).some(w => w.textInput)).toBe(false);
  });

  it("keeps invalid custom cron and all entered values until a corrected Save", async () => {
    const h = fixture(0), name = await h.open();
    await h.click(name, "Add schedule");
    await h.submit(name, { name: "custom", prompt: "keep this\nwhole prompt", cadence: "__custom__", cron: "not a cron", timezone: "Asia/Tokyo", cwd: "repo", target: "destination.topic", output: "messages", model: "other-model" });
    expect(h.store.listScheduledByChannel("google-chat", "home")).toHaveLength(0);
    expect(JSON.stringify(h.messages.get(name))).toContain("Invalid cron:");
    expect(h.fields(name)).toMatchObject({ name: "custom", prompt: "keep this\nwhole prompt", cron: "not a cron", timezone: "Asia/Tokyo", cwd: "repo", target: "destination.topic", output: "messages", model: "other-model" });
    await h.submit(name, { cron: "0 17 * * 1-5" });
    expect(h.store.listScheduledByChannel("google-chat", "home")[0]).toMatchObject({ cron: "0 17 * * 1-5", timezone: "Asia/Tokyo" });
    expect(h.manager.armFromRow).toHaveBeenCalledOnce();
  });

  it("prefills an edit, retains disabled/history fields and returns to the same page", async () => {
    const h = fixture(), old = { ...h.store.getScheduled("sch_4")!, enabled: false, cron: "0 17 * * 1-5", timezone: "UTC",
      model: "model-no-longer-in-catalog", cwd: "/fixture/original", targetChannel: "destination.topic", outputType: "messages" as const, pinnedSessionId: "original-acp", lastStatus: "ok", legacyAttachmentCount: 2 };
    h.store.upsertScheduled(old);
    const name = await h.open(); await h.click(name, "Next"); await h.click(name, "Edit", "schedule 4");
    expect(h.fields(name)).toMatchObject({ name: old.name, prompt: old.promptText, cadence: "__custom__", cron: old.cron, timezone: "UTC", model: old.model, cwd: old.cwd, target: old.targetChannel, output: "messages" });
    await h.submit(name, { name: "edited", prompt: "new prompt" });
    expect(h.store.getScheduled(old.id)).toMatchObject({ ...old, name: "edited", promptText: "new prompt", legacyAttachmentCount: 0,
      updatedUtc: expect.any(String), nextRunUtc: expect.any(String) });
    expect(h.manager.reschedule).toHaveBeenCalledExactlyOnceWith(old.id);
    expect(h.manager.armFromRow).not.toHaveBeenCalled();
    expect(JSON.stringify(h.messages.get(name))).toContain("Page 2/2");
    expect(JSON.stringify(h.messages.get(name))).not.toContain("schedule 0");
  });

  it("edits a native-thread schedule against that thread's defaults and keeps its binding", async () => {
    const h = fixture(0);
    h.store.upsertScheduled(schedule(0, { channelRef: "home.topic", parentRef: "home" }));
    const name = await h.open(); await h.click(name, "Edit", "schedule 0");
    expect(h.ports.builderDefaults).toHaveBeenCalledWith({ platform: "google-chat", id: "home.topic", parentId: "home" });
    await h.submit(name, { name: "thread edit" });
    expect(h.store.getScheduled("sch_0")).toMatchObject({ name: "thread edit", channelRef: "home.topic", parentRef: "home", model: null, cwd: null });
  });

  it("cancels an unsaved form without changing schedules or its list page", async () => {
    const h = fixture(), before = h.store.listScheduledByChannel("google-chat", "home"), name = await h.open();
    await h.click(name, "Next"); await h.click(name, "Edit", "schedule 4");
    await h.change(name, "cadence", "__custom__", { name: "unsaved", prompt: "not persisted", cron: "bad cron" });
    await h.click(name, "Cancel");
    expect(h.store.listScheduledByChannel("google-chat", "home")).toEqual(before);
    expect(JSON.stringify(h.messages.get(name))).toContain("Page 2/2");
    expect(h.manager.reschedule).not.toHaveBeenCalled();
  });

  it("keeps typed values across mode changes, hides isolated fields in live mode and clears overrides on Save", async () => {
    const h = fixture(0), name = await h.open(); await h.click(name, "Add schedule");
    await h.change(name, "mode", "live", { name: "live report", prompt: "use this context", cadence: "0 * * * *", cwd: "repo", model: "other-model", target: "destination", output: "messages" });
    expect(h.fields(name)).toMatchObject({ name: "live report", prompt: "use this context", mode: "live" });
    expect(h.fields(name)).not.toHaveProperty("cwd"); expect(h.fields(name)).not.toHaveProperty("model");
    await h.change(name, "mode", "isolated");
    expect(h.fields(name)).toMatchObject({ cwd: "repo", model: "other-model", target: "destination", output: "messages" });
    await h.change(name, "mode", "live"); await h.submit(name);
    expect(h.store.listScheduledByChannel("google-chat", "home")[0]).toMatchObject({ sessionMode: "live", model: null, cwd: null, targetChannel: null, outputType: "card" });
  });

  it("validates required fields and target while preserving raw invalid values", async () => {
    const h = fixture(0), name = await h.open(); await h.click(name, "Add schedule");
    await h.submit(name, { cadence: "0 * * * *" });
    expect(JSON.stringify(h.messages.get(name))).toContain("a name");
    expect(JSON.stringify(h.messages.get(name))).toContain("a prompt");
    await h.submit(name, { name: "target", prompt: "read", cwd: '"', target: "not a channel!" });
    expect(h.store.listScheduledByChannel("google-chat", "home")).toHaveLength(0);
    expect(h.fields(name).target).toBe("not a channel!");
    expect(h.fields(name).cwd).toBe('"');
    expect(JSON.stringify(h.messages.get(name))).toContain("Repo path is required");
    expect(JSON.stringify(h.messages.get(name))).toContain("Space/thread");
  });

  it("never creates twice after Save PATCH retry and Pub/Sub ACK redelivery", async () => {
    const h = fixture(0), name = await h.open(); await h.click(name, "Add schedule");
    const control = h.button(name, "Save"), values = { ...h.fields(name), name: "exactly once", prompt: "report", cadence: "0 * * * *" };
    const normal = h.request.getMockImplementation()!; let failPatch = true, failAck = true;
    h.request.mockImplementation(async (scope, r) => {
      if (r.method === "PATCH" && failPatch) { failPatch = false; throw new Error("Chat PATCH connection lost"); }
      if (scope === "pubsub" && failAck) { failAck = false; throw new Error("Pub/Sub ACK connection lost"); }
      return normal(scope, r);
    });
    await expect(h.clickRaw(name, control, "42", "same-save", values)).rejects.toThrow("Pub/Sub ACK connection lost");
    await h.clickRaw(name, control, "42", "same-save", values);
    expect(h.store.listScheduledByChannel("google-chat", "home")).toHaveLength(1);
    expect(h.manager.armFromRow).toHaveBeenCalledOnce();
  });
});
