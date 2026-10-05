import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SessionStore } from "../packages/core/src/core/session-store.js";
import { PluginHost } from "../packages/core/src/plugins/host.js";
import { PresetUi, createPresetPlugin } from "../packages/core/src/plugins/presets/index.js";
import type { PresetInteraction, PresetClick, PresetUiPorts } from "../packages/core/src/plugins/presets/ports.js";
import type { Preset } from "../packages/core/src/core/types.js";

const logger = pino({ level: "silent" });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });
const channel = { platform: "discord", id: "thread", parentId: "project" };
const preset = (n: number): Preset => ({ id: `pre_${n}`, name: `preset-${n}`, projectRef: "project", description: null,
  agentId: "claude", model: "sonnet", effort: "low", repoPath: "/repo", permission: "ask", toolsAllow: ["Read"], toolsExclude: null,
  instructions: "Original instructions", statusCardStyle: "simple", role: "worker", disableThreadPrefix: null,
  createdBy: "owner", createdUtc: "created", updatedUtc: "updated" });

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seam-preset-cards-"));
  const store = new SessionStore(path.join(dir, "seam.db"));
  const outputs = new Map<string, any[]>();
  const hosts: PluginHost[] = [];
  cleanups.push(async () => { await Promise.all(hosts.map(host => host.dispose())); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let sequence = 0;
  const reply = (target: string, owner = "owner") => ({ target, user: { id: owner }, channelId: channel.id,
    editReply: async (view: unknown) => { outputs.get(target)!.push(view); }, followUp: async () => {}, deleteReply: async () => {} });
  function interaction(): PresetInteraction {
    const target = `reply-${++sequence}`; outputs.set(target, []);
    return { cardReply: reply(target), user: { id: "owner" }, channelRef: channel, channelId: channel.id, parentId: channel.parentId,
      projectScopeId: channel.parentId, deferred: false, replied: false,
      options: { getString: (() => "") as any, getInteger: () => null, getBoolean: () => null },
      reply: async view => { outputs.get(target)!.push(view); }, editReply: async view => { outputs.get(target)!.push(view); },
      deferReply: async () => {}, fetchReply: async () => ({ id: target }),
    };
  }
  const apply = vi.fn(async (_channel: unknown, _preset: Preset) => "unchanged apply result");
  async function open() {
    const ports = { logger, repository: store.presets, repoDisplay: (repo: string) => repo,
      catalog: { models: () => [], model: () => undefined }, builderDefaults: () => ({ location: "local", profiles: [{ id: "claude", displayName: "Claude" }] }),
      listWorkspace: async () => ["/repo"], transport: {}, reply, track: (work: Promise<void>) => work,
      apply, component: (event: unknown) => event, interaction: () => { throw new Error("direct UI fixture"); },
    } as unknown as PresetUiPorts;
    const ui = new PresetUi(ports); const host = new PluginHost(logger, { storageRoot: dir }); hosts.push(host);
    await host.loadBuiltins([{ id: "presets", load: async () => createPresetPlugin(ui) }]);
    return { ui, host };
  }
  function click(customId: string, target: string, values: string[] = [], fields?: Record<string, string>, owner = "owner", refusal?: string): PresetClick {
    const i = interaction();
    return { ...i, user: { id: owner }, customId, cardReply: reply(target, owner), values,
      isButton: () => !fields && !values.length, isStringSelectMenu: () => !!values.length, isModalSubmit: () => !!fields,
      fields: { getTextInputValue: name => fields?.[name] ?? "" }, mutationRefusal: () => refusal,
      reply: vi.fn(async () => {}), deferUpdate: vi.fn(async () => {}),
      update: async view => { outputs.get(target)!.push(view); }, showModal: vi.fn(async () => {}),
    };
  }
  return { store, dir, outputs, interaction, open, click, apply };
}
const ids = (view: any) => view.components.flatMap((row: any) => (row.toJSON?.() ?? row).components.map((c: any) => c.custom_id));

describe("persistent preset cards", () => {
  it("resumes list paging, applies through the same port and deletes without touching other rows", async () => {
    const h = await fixture(); for (let n = 0; n < 5; n++) h.store.upsertPreset(preset(n));
    const before = h.store.listPresetsForProject("project");
    const first = await h.open(); const i = h.interaction(); await first.ui.cmdPresetList(i);
    const target = i.cardReply.target;
    const next = ids(h.outputs.get(target)!.at(-1)).find((id: string) => id.startsWith("pr:page:1:"));
    await first.ui.cards.handle(h.click(next, target));
    const deadline = [...first.ui.cards.states.values()][0]!.expires;
    await first.host.dispose(); const restarted = await h.open();
    expect([...restarted.ui.cards.states.values()][0]).toMatchObject({ page: 1, owner: "owner", expires: deadline });
    expect(h.store.listPresetsForProject("project")).toEqual(before);
    const applyId = ids(h.outputs.get(target)!.at(-1)).find((id: string) => id.startsWith("pr:apply:"));
    expect(await restarted.ui.cards.handle(h.click(applyId, target, [], undefined, "other"))).toBe(false);
    const refused = h.click(applyId, target, [], undefined, "owner", "existing mutation refusal");
    await restarted.ui.cards.handle(refused); expect(h.apply).not.toHaveBeenCalled();
    expect(refused.reply).toHaveBeenCalledWith({ content: "existing mutation refusal", flags: 64 });
    await restarted.ui.cards.handle(h.click(applyId, target)); expect(h.apply).toHaveBeenCalledWith(channel, preset(4));
    const deleteId = applyId.replace("pr:apply:", "pr:del:");
    await restarted.ui.cards.handle(h.click(deleteId, target));
    expect(h.store.getPreset("pre_4")).toBeNull();
    expect(h.store.listPresetsForProject("project")).toEqual(before.slice(0, 4));
    expect([...restarted.ui.cards.states.values()][0]).toMatchObject({ page: 0, expires: deadline });
  });

  it("restores an unsaved builder and an open modal, then saves exactly its draft", async () => {
    const h = await fixture(); h.store.upsertPreset(preset(0)); const before = h.store.getPreset("pre_0");
    const first = await h.open(); const i = h.interaction(); await first.ui.cmdPresetBuilder(i, undefined, "project", "qa");
    const target = i.cardReply.target;
    const details = ids(h.outputs.get(target)!.at(-1)).find((id: string) => id.startsWith("preset:details:"));
    const opened = h.click(details, target); await first.ui.cards.handle(opened);
    const modalId = (opened.showModal as any).mock.calls[0][0].data.custom_id;
    const deadline = [...first.ui.cards.states.values()][0]!.expires;
    await first.host.dispose(); const restarted = await h.open();
    await restarted.ui.cards.handle(h.click(modalId, target, [], { name: "unsaved", desc: "restored", permission: "always", instr: "Draft instructions" }));
    const save = ids(h.outputs.get(target)!.at(-1)).find((id: string) => id.startsWith("preset:save:"));
    expect([...restarted.ui.cards.states.values()][0]).toMatchObject({ expires: deadline, draft: { name: "unsaved", role: "qa", instructions: "Draft instructions" } });
    const again = await h.open(); await restarted.host.dispose();
    await again.ui.cards.handle(h.click(save, target));
    expect(h.store.getPresetByNameScoped("unsaved", "project")).toMatchObject({ name: "unsaved", projectRef: "project", role: "qa", permission: "always", instructions: "Draft instructions", createdBy: "owner" });
    expect(h.store.getPreset("pre_0")).toEqual(before);
    expect(JSON.parse(fs.readFileSync(`${h.dir}/plugins/presets/cards.json`, "utf8"))).toEqual([]);
    expect(await again.ui.cards.handle(h.click(save, target))).toBe(false);
  });

  it("expires a restored builder at the original scheduled deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const h = await fixture(); const first = await h.open(); const i = h.interaction();
    await first.ui.cmdPresetBuilder(i, undefined, "project");
    const target = i.cardReply.target;
    await first.host.dispose(); vi.setSystemTime(1_599_000);
    const restarted = await h.open(); restarted.ui.cards.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(restarted.ui.cards.states.size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(restarted.ui.cards.states.size).toBe(0);
    expect(h.outputs.get(target)!.at(-1)).toMatchObject({ components: [], content: expect.stringContaining("timed out") });
    expect(h.store.listPresetsForProject("project")).toEqual([]);
  });

  it("does not extend card or modal expiry across restarts or edits", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const h = await fixture(); const first = await h.open(); const i = h.interaction(); await first.ui.cmdPresetBuilder(i, undefined, "project");
    const target = i.cardReply.target;
    const details = ids(h.outputs.get(target)!.at(-1)).find((id: string) => id.startsWith("preset:details:"));
    const opened = h.click(details, target); await first.ui.cards.handle(opened);
    const modalId = (opened.showModal as any).mock.calls[0][0].data.custom_id;
    await first.host.dispose(); vi.setSystemTime(1_300_001); const restarted = await h.open();
    expect(await restarted.ui.cards.handle(h.click(modalId, target, [], { name: "late" }))).toBe(false);
    vi.setSystemTime(1_600_000);
    const card = [...restarted.ui.cards.states.values()][0]!;
    expect(await restarted.ui.cards.handle(h.click(`preset:save:${card.id}`, target))).toBe(false);
    expect(h.outputs.get(target)!.at(-1)).toMatchObject({ components: [], content: expect.stringContaining("timed out") });
    expect(h.store.listPresetsForProject("project")).toEqual([]);
    expect(JSON.parse(fs.readFileSync(`${h.dir}/plugins/presets/cards.json`, "utf8"))).toEqual([]);
  });
});
