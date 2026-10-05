import type { SessionActions } from "./session-actions.js";
import type { SlashInvocation } from "../plugins/slash-registry.js";
import type { ComponentEvent, ChannelRef } from "../platforms/chat-adapter.js";
import type { CardLifecycle, CardView } from "../platforms/discord/collector-lifecycle.js";

export interface BrowserReply {
  readonly target: string;
  readonly user: { id: string };
  readonly channelId: string;
  editReply(view: CardView): Promise<void>;
  deleteReply(): Promise<void>;
  followUp(view: CardView & { flags?: number }): Promise<void>;
}

export interface BrowserClick {
  readonly customId: string;
  readonly user: { id: string };
  readonly values: string[];
  readonly fields: { getTextInputValue(name: string): string };
  isStringSelectMenu(): boolean;
  isModalSubmit(): boolean;
  deferUpdate(): Promise<void>;
  editReply(view: CardView): Promise<void>;
  reply(view: { content: string; flags?: number }): Promise<void>;
  followUp(view: { content: string; flags?: number }): Promise<void>;
  deleteReply(): Promise<void>;
  showModal(modal: { toJSON(): unknown }): Promise<void>;
}

export interface BrowserSettlement {
  lifecycle: CardLifecycle;
  view: CardView;
  mode?: "repeatable" | "terminal";
  reason?: string;
  channel: ChannelRef | null;
  fallback: {
    kind: "compaction" | "summary" | "rebuild" | "compact_thread" | "import" | "migration";
    outcome: "ok" | "failed";
    recordId?: string;
    userId?: string;
  };
  fallbackFile?: { filename: string; body: string };
}

/** Bootstrap-only capabilities; browser code never receives the kernel objects. */
export interface SessionBrowserFacade {
  open(invocation: SlashInvocation): Promise<{ actions: SessionActions; reply: BrowserReply } | undefined>;
  resume(snapshot: string): SessionActions;
  reply(target: string, userId: string, channelId: string): BrowserReply;
  click(event: ComponentEvent): BrowserClick;
  collectParked(reply: BrowserReply, recordId: string): Promise<number>;
  runJob(work: () => Promise<void>): void;
  track(work: Promise<void>): Promise<void>;
  settle(input: BrowserSettlement): Promise<"live" | "inert" | "fallback">;
  repoDisplay(cwd: string): string;
}
