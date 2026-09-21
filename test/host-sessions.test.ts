/**
 * #446 — reverse index of thread→host assignment for warm-set enumeration.
 *
 * This is a READ of channel-presets.json (the owner of location) joined with
 * session recency. It does not write. A test that still passes with the
 * isolated-dispatch filter or the no-preset→local rule deleted is not covering
 * that classification.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listSessionsForHost,
  locationOfThread,
  type HostSessionInput,
} from "../packages/core/src/core/host-sessions.js";
import { resolveThreadLocation } from "../packages/core/src/config.js";
import { LOCAL_LOCATION } from "../packages/core/src/core/location.js";

function session(over: Partial<HostSessionInput> & Pick<HostSessionInput, "id" | "channelRef">): HostSessionInput {
  return {
    agentId: "claude",
    updatedUtc: "2026-09-20T00:00:00.000Z",
    ...over,
  };
}

describe("locationOfThread matches resolveThreadLocation", () => {
  it("treats omit / empty as local, and trims an explicit host", () => {
    const presets = new Map([
      ["explicit", { location: "rhc-server" }],
      ["blank", { location: "  " }],
      ["local-written", { location: "local" }],
    ]);
    expect(locationOfThread(presets, "explicit")).toEqual({ location: "rhc-server", explicit: true });
    expect(locationOfThread(presets, "blank")).toEqual({ location: LOCAL_LOCATION, explicit: false });
    expect(locationOfThread(presets, "missing")).toEqual({ location: LOCAL_LOCATION, explicit: false });
    expect(locationOfThread(presets, "local-written")).toEqual({ location: LOCAL_LOCATION, explicit: true });
    for (const id of ["explicit", "blank", "missing", "local-written"]) {
      expect(locationOfThread(presets, id).location).toBe(resolveThreadLocation({ threadPresets: presets }, id));
    }
  });
});

describe("listSessionsForHost", () => {
  const presets = new Map([
    ["remote-a", { location: "rhc-server" }],
    ["remote-b", { location: "rhc-server" }],
    ["other-host", { location: "fhr-server" }],
  ]);
  const sessions: HostSessionInput[] = [
    session({ id: "discord:remote-a", channelRef: "remote-a", updatedUtc: "2026-09-20T12:00:00.000Z", agentId: "codex" }),
    session({ id: "discord:remote-b", channelRef: "remote-b", updatedUtc: "2026-09-19T12:00:00.000Z", agentId: "claude" }),
    session({ id: "discord:other-host", channelRef: "other-host", updatedUtc: "2026-09-21T12:00:00.000Z" }),
    session({ id: "discord:no-preset", channelRef: "no-preset", updatedUtc: "2026-09-18T12:00:00.000Z", agentId: "grok" }),
    session({ id: "dispatch:ephemeral", channelRef: "remote-a", updatedUtc: "2026-09-22T12:00:00.000Z" }),
  ];

  it("lists only the requested host, newest first, and does not invent a session for a preset with no row", () => {
    const rhc = listSessionsForHost("rhc-server", { threadPresets: presets, sessions });
    expect(rhc.map((row) => row.sessionId)).toEqual(["discord:remote-a", "discord:remote-b"]);
    expect(rhc[0]).toMatchObject({
      channelRef: "remote-a", agentId: "codex", location: "rhc-server", explicit: true,
    });
    expect(listSessionsForHost("media-server", { threadPresets: presets, sessions })).toEqual([]);
  });

  it("assigns a session with no preset to local — a missing binding is not a hole in the reverse index", () => {
    const local = listSessionsForHost("local", { threadPresets: presets, sessions });
    expect(local.map((row) => row.sessionId)).toEqual(["discord:no-preset"]);
    expect(local[0]).toMatchObject({ location: "local", explicit: false, agentId: "grok" });
  });

  it("excludes isolated dispatch: ids even when their channel is bound to the host", () => {
    const rhc = listSessionsForHost("rhc-server", { threadPresets: presets, sessions });
    expect(rhc.some((row) => row.sessionId.startsWith("dispatch:"))).toBe(false);
  });

  it("partitions every durable session onto exactly one host", () => {
    const hosts = ["local", "rhc-server", "fhr-server"];
    const durable = sessions.filter((row) => !row.id.startsWith("dispatch:"));
    const seen = hosts.flatMap((host) => listSessionsForHost(host, { threadPresets: presets, sessions }).map((row) => row.sessionId));
    expect(seen.sort()).toEqual(durable.map((row) => row.id).sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("does not add a location column to the sessions schema — presets remain the owner", () => {
    const schema = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/core/src/core/session-store.ts"),
      "utf8",
    );
    const create = schema.match(/CREATE TABLE IF NOT EXISTS sessions \(([^;]+)\)/)?.[1] ?? "";
    expect(create.toLowerCase()).not.toContain("location");
    expect(schema).not.toMatch(/ALTER TABLE sessions ADD COLUMN location/i);
  });
});
