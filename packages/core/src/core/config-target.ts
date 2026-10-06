import type { ChannelRef } from "../platforms/chat-adapter.js";

export type ConfigTarget = { kind: "thread" | "channel"; id: string; parentRef?: string };

/** A category is never a configuration parent; ChannelRef.parentId is a thread parent. */
export function configTarget(channel: ChannelRef, scope?: string | null): ConfigTarget {
  return !channel.parentId || scope === "channel"
    ? { kind: "channel", id: channel.parentId ?? channel.id }
    : { kind: "thread", id: channel.id, parentRef: channel.parentId };
}

export const CONFIG_DEFAULT_FIELDS = ["agent", "model", "effort", "cwd", "role", "disableThreadPrefix", "statusCardStyle", "simpleCardGif", "rider"] as const;
export type ConfigDefaultField = typeof CONFIG_DEFAULT_FIELDS[number];
export type OverrideCounts = Partial<Record<ConfigDefaultField, number>>;

export function formatOverrideCounts(counts: OverrideCounts): string {
  return Object.entries(counts).map(([key, count]) => `${key}: ${count}`).join(", ") || "none";
}
