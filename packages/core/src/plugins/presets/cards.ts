import fs from "node:fs";
import type { Preset } from "../../core/types.js";
import type { ChannelRef } from "../../platforms/chat-adapter.js";
import { CardLifecycle, type CardView } from "../../platforms/discord/collector-lifecycle.js";
import type { PresetClick, PresetUiPorts } from "./ports.js";

interface CardState {
  id: string; owner: string; channel?: ChannelRef; projectRef: string | null;
  target: string; expires: number;
}
export interface PresetListCard extends CardState { kind: "list"; page: number }
export type PresetDraft = Pick<Preset, "name" | "agentId" | "model" | "effort" | "repoPath" | "permission" | "toolsAllow" | "toolsExclude" | "instructions" | "statusCardStyle" | "role" | "disableThreadPrefix"> & { description: string };
export interface PresetBuilderCard extends CardState {
  kind: "builder"; existing?: Preset; draft: PresetDraft;
  location: string; profiles: Array<{ id: string; displayName: string }>; repoDirs: string[];
  modals: Record<string, number>;
}
export type PresetCard = PresetListCard | PresetBuilderCard;
export interface PresetController { lifecycle: CardLifecycle; handle(click: PresetClick): Promise<void> }

/** Persistent state and the original fixed collector deadlines. */
export class PresetCards {
  readonly states = new Map<string, PresetCard>();
  private readonly controllers = new Map<string, Promise<PresetController>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly work = new Set<Promise<void>>();
  private file?: string;
  private stopped = true;
  constructor(private readonly ports: PresetUiPorts, private readonly resume: (card: PresetCard) => Promise<PresetController>) {}

  load(file: string): void {
    if (fs.existsSync(file)) for (const card of JSON.parse(fs.readFileSync(file, "utf8")) as PresetCard[]) this.states.set(card.id, card);
    this.file = file;
  }
  checkpoint(card: PresetCard): void {
    this.states.set(card.id, card);
    this.persist();
    if (!this.stopped) this.arm(card);
  }
  private persist(): void { if (this.file) fs.writeFileSync(this.file, JSON.stringify([...this.states.values()])); }
  private remove(id: string): void {
    this.states.delete(id); this.controllers.delete(id);
    clearTimeout(this.timers.get(id)); this.timers.delete(id); this.persist();
  }
  bind(card: PresetCard, render: (view: CardView) => Promise<void>, expired: () => CardView, handle: (click: PresetClick, lifecycle: CardLifecycle) => Promise<void>): PresetController {
    const lifecycle = new CardLifecycle({
      render: view => render(routePresetView(view, card.id)), stop: () => this.remove(card.id), expired,
      onError: err => this.ports.logger.warn({ err }, "preset card render failed"),
    });
    const controller = { lifecycle, handle: (click: PresetClick) => handle(click, lifecycle) };
    this.controllers.set(card.id, Promise.resolve(controller));
    return controller;
  }
  private controller(card: PresetCard): Promise<PresetController> {
    let pending = this.controllers.get(card.id);
    if (!pending) { pending = this.resume(card); this.controllers.set(card.id, pending); }
    return pending;
  }
  async handle(click: PresetClick): Promise<boolean> {
    const split = click.customId.lastIndexOf(":");
    const card = this.states.get(click.customId.slice(split + 1));
    if (!card || card.owner !== click.user.id) return false;
    const controller = await this.controller(card);
    if (controller.lifecycle.settled) return false;
    if (card.expires <= Date.now()) {  await controller.lifecycle.expire("time"); return false; }
    const customId = click.customId.slice(0, split);
    if (click.isModalSubmit()) {
      if (card.kind !== "builder" || !card.modals[customId] || card.modals[customId]! <= Date.now()) return false;
      delete card.modals[customId]; this.checkpoint(card);
    }
    try { await controller.handle({ ...click, customId, get deferred() { return click.deferred; }, get replied() { return click.replied; } }); }
    finally { if (this.states.has(card.id)) this.checkpoint(card); }
    return true;
  }
  private arm(card: PresetCard): void {
    clearTimeout(this.timers.get(card.id));
    const timer = setTimeout(() => {
      this.timers.delete(card.id);
      const pending = this.ports.track(this.controller(card).then(controller => controller.lifecycle.expire("time")).then(() => {}));
      this.work.add(pending);
      void pending.catch(err => this.ports.logger.warn({ err }, "preset card expiry failed")).finally(() => this.work.delete(pending));
    }, Math.max(0, card.expires - Date.now()));
    timer.unref(); this.timers.set(card.id, timer);
  }
  start(): void { this.stopped = false; for (const card of this.states.values()) this.arm(card); }
  stop(): void { this.stopped = true; for (const timer of this.timers.values()) clearTimeout(timer); this.timers.clear(); }
  async drain(): Promise<void> { await Promise.allSettled([...this.work]); }
}

export function routePresetView(view: CardView, id: string): CardView {
  const components = view.components?.map(row => {
    const json = typeof (row as any).toJSON === "function" ? (row as any).toJSON() : row;
    return { ...json, components: json.components.map((component: any) => ({ ...component,
      ...(component.custom_id ? { custom_id: `${component.custom_id}:${id}` } : {}),
    })) };
  });
  return { ...view, ...(components ? { components } : {}) };
}
