import type { Logger } from "../../lib/logger.js";
import type { SessionRecord } from "../types.js";
import type { SessionStore } from "../session-store.js";
import {
  newLiveHelpId,
  type LiveHelpSession,
  type LiveHelpStatus,
} from "./types.js";
import { checkLiveHelpVoiceChannel, parseLiveHelpMintSpec } from "./voice-policy.js";
import { VoiceLeaseManager, type VoiceLease } from "../voice-lease.js";

export interface LiveHelpHost {
  inspectVoiceChannel(voiceChannelId: string): Promise<
    | {
        ok: true;
        guildId: string;
        channelName: string;
        type: number;
        parentName?: string;
        obfuscated: boolean;
      }
    | { ok: false; reason: string }
  >;
  runCall(opts: {
    row: LiveHelpSession;
    signal: AbortSignal;
    onLive: () => void;
    onTranscript: (side: "input" | "output", text: string) => void;
  }): Promise<{ reason: string }>;
  notify(threadId: string, text: string): Promise<void>;
}

export class LiveHelpManager {
  private readonly store: SessionStore;
  private readonly logger: Logger;
  private readonly host: LiveHelpHost;
  private readonly apiKey: () => string;
  private readonly leases: VoiceLeaseManager;
  private readonly running = new Map<string, AbortController>();

  constructor(opts: {
    store: SessionStore;
    logger: Logger;
    host: LiveHelpHost;
    apiKey: () => string;
    leases: VoiceLeaseManager;
  }) {
    this.store = opts.store;
    this.logger = opts.logger.child({ comp: "live-help" });
    this.host = opts.host;
    this.apiKey = opts.apiKey;
    this.leases = opts.leases;
  }

  /** Process start: in-flight rows cannot keep a voice connection. Mark ended. */
  reconcileOnBoot(): number {
    const n = this.store.markInFlightLiveHelpEnded(
      "process restart — live call cannot survive v1"
    );
    if (n > 0) this.logger.info({ count: n }, "live-help: marked in-flight rows ended on boot");
    return n;
  }

  async mint(
    record: SessionRecord,
    raw: unknown,
    createdBy: string
  ): Promise<
    | { ok: true; liveId: string; guildId: string; channelName: string }
    | { ok: false; error: string }
  > {
    if (!this.apiKey().trim()) {
      return { ok: false, error: "SEAM_GEMINI_API_KEY is not set — live help needs Studio Live." };
    }
    const parsed = parseLiveHelpMintSpec(raw);
    if (!parsed.ok) return parsed;
    const spec = parsed.spec;

    const inspected = await this.host.inspectVoiceChannel(spec.voiceChannelId);
    if (!inspected.ok) return { ok: false, error: inspected.reason };
    const policy = checkLiveHelpVoiceChannel({
      id: spec.voiceChannelId,
      name: inspected.channelName,
      type: inspected.type,
      parentName: inspected.parentName,
      obfuscated: inspected.obfuscated,
    });
    if (!policy.ok) return { ok: false, error: policy.reason };

    const busyVc = this.store.getActiveLiveHelpForVoiceChannel(spec.voiceChannelId);
    if (busyVc) {
      return {
        ok: false,
        error: `Voice channel already has a live-help session (${busyVc.id}). Cancel it first.`,
      };
    }
    const busyGuild = this.store.getActiveLiveHelpForGuild(inspected.guildId);
    if (busyGuild) {
      return {
        ok: false,
        error: `This guild already has a live-help session (${busyGuild.id}) — Discord allows one bot voice connection per guild. Cancel it first.`,
      };
    }

    const now = new Date().toISOString();
    const row: LiveHelpSession = {
      id: newLiveHelpId(),
      voiceChannelId: spec.voiceChannelId,
      guildId: inspected.guildId,
      channelName: inspected.channelName,
      system: spec.system,
      historySummary: spec.historySummary ?? null,
      notifyThread: spec.notifyThread ?? null,
      preset: spec.preset ?? null,
      authoringChannelRef: record.channelRef,
      authoringParentRef: record.parentRef,
      platform: record.platform,
      status: "starting",
      createdBy,
      createdUtc: now,
      endedUtc: null,
      endReason: null,
    };
    const acquired = this.leases.acquire({
      kind: "live_help",
      sessionId: row.id,
      guildId: inspected.guildId,
      voiceChannelId: row.voiceChannelId,
    });
    if (!acquired.ok) return { ok: false, error: acquired.error };
    try {
      this.store.insertLiveHelp(row);
    } catch (err) {
      this.leases.release(acquired.lease);
      throw err;
    }
    this.logger.info(
      { liveId: row.id, vc: row.voiceChannelId, thread: record.channelRef },
      "live-help minted"
    );
    this.startCall(row, acquired.lease);
    return {
      ok: true,
      liveId: row.id,
      guildId: inspected.guildId,
      channelName: inspected.channelName,
    };
  }

  cancel(
    liveId: string,
    opts?: { authoringChannelRef?: string }
  ): { ok: true } | { ok: false; error: string } {
    const row = this.store.getLiveHelp(liveId);
    if (!row) return { ok: false, error: "No live-help session with that id." };
    if (opts?.authoringChannelRef && row.authoringChannelRef !== opts.authoringChannelRef) {
      return { ok: false, error: "That live-help session is not from this thread." };
    }
    if (row.status === "ended" || row.status === "cancelled") {
      return { ok: false, error: "That live-help session has already ended." };
    }
    const ac = this.running.get(liveId);
    if (ac) ac.abort();
    this.store.updateLiveHelp(liveId, {
      status: "cancelled",
      endedUtc: new Date().toISOString(),
      endReason: "cancelled",
    });
    this.logger.info({ liveId }, "live-help cancel requested");
    return { ok: true };
  }

  listForThread(platform: string, channelRef: string): LiveHelpSession[] {
    return this.store.listLiveHelpForThread(platform, channelRef);
  }

  listActive(): LiveHelpSession[] {
    return this.store.listActiveLiveHelp();
  }

  stopAll(): void {
    for (const ac of this.running.values()) ac.abort();
    this.running.clear();
  }

  private startCall(row: LiveHelpSession, lease: VoiceLease): void {
    const ac = new AbortController();
    this.running.set(row.id, ac);
    const notifyBuf = { input: "", output: "" };
    void Promise.resolve()
      .then(() => this.host.runCall({
        row,
        signal: ac.signal,
        onLive: () => {
          this.store.updateLiveHelp(row.id, { status: "live" });
        },
        onTranscript: (side, text) => {
          if (side === "input") notifyBuf.input += text;
          else notifyBuf.output += text;
        },
      }))
      .then(async ({ reason }) => {
        const cancelled = reason === "cancelled" || ac.signal.aborted;
        const status: LiveHelpStatus = cancelled ? "cancelled" : "ended";
        this.store.updateLiveHelp(row.id, {
          status,
          endedUtc: new Date().toISOString(),
          endReason: reason,
        });
        const summary =
          `🎙️ Live help ended in **${row.channelName ?? row.voiceChannelId}** (\`${row.id}\`): ${reason}.`;
        const inn = notifyBuf.input.trim();
        const out = notifyBuf.output.trim();
        const transcript =
          inn || out
            ? `${summary}\nHeard: ${inn || "(none)"}\nSaid: ${out || "(none)"}`
            : summary;
        if (row.notifyThread) {
          await this.host.notify(row.notifyThread, transcript).catch(() => {});
        }
        await this.host.notify(row.authoringChannelRef, summary).catch(() => {});
      })
      .catch((err) => {
        this.logger.warn({ err, liveId: row.id }, "live-help run failed");
        this.store.updateLiveHelp(row.id, {
          status: "ended",
          endedUtc: new Date().toISOString(),
          endReason: (err as Error).message ?? "error",
        });
      })
      .finally(() => {
        this.running.delete(row.id);
        this.leases.release(lease);
      });
  }
}
