import { randomBytes } from "node:crypto";

export type LiveHelpStatus = "starting" | "live" | "ended" | "cancelled";

export interface LiveHelpSession {
  id: string;
  voiceChannelId: string;
  guildId: string | null;
  channelName: string | null;
  system: string;
  historySummary: string | null;
  notifyThread: string | null;
  preset: string | null;
  authoringChannelRef: string;
  authoringParentRef: string | null;
  platform: string;
  status: LiveHelpStatus;
  createdBy: string;
  createdUtc: string;
  endedUtc: string | null;
  endReason: string | null;
}

export interface LiveHelpMintSpec {
  voiceChannelId: string;
  system: string;
  historySummary?: string;
  notifyThread?: string;
  preset?: string;
}

export function newLiveHelpId(): string {
  return `lh_${randomBytes(9).toString("base64url")}`;
}

export const LIVE_HELP_EMPTY_VC_IDLE_MS = 45_000;
export const LIVE_HELP_WAIT_JOIN_MS = 3 * 60_000;
export const LIVE_HELP_MAX_MS = 9 * 60_000;
export const LIVE_HELP_MODEL = "gemini-3.1-flash-live-preview";
