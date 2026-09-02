import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ConfigDescription } from "../packages/core/src/core/session-router.js";
import type { SessionRecord } from "../packages/core/src/core/types.js";
import {
  DEFAULT_THREAD_NAMER_CONFIG,
  ThreadNamer,
  ThreadNamerConfigStore,
  computeThreadPrefix,
  formatThreadOrdinal,
  joinThreadName,
  lowestUnusedThreadOrdinal,
  parseThreadOrdinal,
  parseThreadOrdinalSuffix,
  parseThreadNamerRules,
  formatThreadNamerRules,
  stripLegacyThreadPrefix,
  stripStoredThreadPrefix,
  type ThreadNamerConfig,
} from "../packages/core/src/platforms/discord/thread-namer.js";

const config = DEFAULT_THREAD_NAMER_CONFIG;

function record(id: string, createdUtc = "2026-01-01T00:00:00.000Z"): SessionRecord {
  return {
    id: `discord:${id}`,
    platform: "discord",
    channelRef: id,
    parentRef: "parent",
    agentId: "copilot",
    acpSessionId: "",
    repoPath: null,
    configJson: "{}",
    namePrefix: null,
    createdUtc,
    updatedUtc: createdUtc,
  };
}

function description(
  rec: SessionRecord,
  values: { agent?: string; model?: string; role?: string | null; disabled?: boolean } = {}
): ConfigDescription {
  return {
    sessionId: rec.id,
    channelRef: rec.channelRef,
    parentRef: rec.parentRef,
    agent: { value: values.agent ?? "copilot", source: "session config" },
    model: { value: values.model ?? "gpt-5.6-sol", source: "session config" },
    role: { value: values.role ?? null, source: "session config" },
    effort: { value: null, source: "default" },
    cwd: { value: "/tmp", source: "default" },
    permission: { value: "ask", source: "default" },
    locked: false,
    detached: { value: false, source: "default" },
    tts: { value: false, source: "default" },
    ttsVoice: { value: null, source: "default" },
    ttsPace: { value: "natural", source: "default" },
    ttsStyle: { value: "neutral", source: "default" },
    location: { value: "local", source: "default" },
    rider: {},
    statusCardStyle: { value: "full", source: "default" },
    simpleCardGif: { value: false, source: "default" },
    disableThreadPrefix: {
      value: values.disabled ?? false,
      source: values.disabled ? "thread preset" : "default",
    },
  };
}

describe("computeThreadPrefix", () => {
  it("uses ordered substring matches and the specific model suffix before gpt", () => {
    expect(computeThreadPrefix({
      agentSlug: "claude-vertex",
      modelSlug: "gpt-5.6-sol",
      role: "orchestrator",
      enumNumber: 1,
      config,
    })).toEqual({
      prefix: "💠🌞🪄1️⃣",
      slots: { agent: "💠", model: "🌞", role: "🪄", enumeration: "1️⃣" },
    });
  });

  it("honors first-match order and an optional model agent qualifier", () => {
    const qualified: ThreadNamerConfig = {
      agents: [],
      roles: [],
      models: [
        { match: "shared", agent: "claude", replacement: "C" },
        { match: "shared", replacement: "G" },
      ],
    };
    expect(computeThreadPrefix({ agentSlug: "claude", modelSlug: "shared-v1", config: qualified }).prefix).toBe("C");
    expect(computeThreadPrefix({ agentSlug: "copilot", modelSlug: "shared-v1", config: qualified }).prefix).toBe("G");
  });

  it("omits unmatched slots, enumeration without a role slot, and a leading space", () => {
    expect(computeThreadPrefix({
      agentSlug: "unknown",
      modelSlug: "unknown",
      role: "worker",
      enumNumber: 7,
      config,
    }).prefix).toBe("🛠️7️⃣");
    expect(computeThreadPrefix({
      agentSlug: "unknown",
      modelSlug: "unknown",
      role: "unknown",
      enumNumber: 1,
      config,
    }).prefix).toBe("");
    expect(joinThreadName("", "base")).toBe("base");
  });

  it("preserves a compound emoji replacement exactly", () => {
    const compound: ThreadNamerConfig = {
      agents: [], models: [], roles: [{ match: "qa", replacement: "🕵🏻‍♀️" }],
    };
    expect(computeThreadPrefix({ role: "qa", enumNumber: 1, config: compound }).prefix)
      .toBe("🕵🏻‍♀️1️⃣");
  });
});

describe("thread ordinal", () => {
  it("renders 1–9, the special ten glyph, and concatenated keycaps above ten", () => {
    expect(formatThreadOrdinal(1)).toBe("1️⃣");
    expect(formatThreadOrdinal(9)).toBe("9️⃣");
    expect(formatThreadOrdinal(10)).toBe("🔟");
    expect(formatThreadOrdinal(11)).toBe("1️⃣1️⃣");
    expect(formatThreadOrdinal(20)).toBe("2️⃣0️⃣");
    expect(parseThreadOrdinal("🔟")).toBe(10);
    expect(parseThreadOrdinal("1️⃣1️⃣")).toBe(11);
    expect(parseThreadOrdinalSuffix("🤖🛠️1️⃣2️⃣")).toBe(12);
  });

  it("uses the lowest gap without an upper cap", () => {
    expect(lowestUnusedThreadOrdinal([1, 2, 4, 10, 11])).toBe(3);
    expect(lowestUnusedThreadOrdinal(Array.from({ length: 25 }, (_, i) => i + 1))).toBe(26);
    expect(() => formatThreadOrdinal(0)).toThrow(/positive/);
  });
});

describe("prefix boundaries", () => {
  it("strips a stored prefix only at the exact front boundary", () => {
    expect(stripStoredThreadPrefix("🤖🌞 base", "🤖🌞")).toBe("base");
    expect(stripStoredThreadPrefix("🤖🌞", "🤖🌞")).toBe("");
    expect(stripStoredThreadPrefix("hand 🤖🌞 base", "🤖🌞")).toBeNull();
    expect(stripStoredThreadPrefix("base", "")).toBe("base");
  });

  it("strips any leading emoji cluster only during explicit legacy cleanup", () => {
    expect(stripLegacyThreadPrefix("🧬🚾4️⃣", config)).toBe("");
    expect(stripLegacyThreadPrefix("🧬🕵🏻‍♀️1️⃣", config)).toBe("");
    expect(stripLegacyThreadPrefix("🤖 👨‍💻☁️ server", config)).toBe("server");
    expect(stripLegacyThreadPrefix("👾🪄 orchestrator", config)).toBe("orchestrator");
    expect(stripLegacyThreadPrefix("🌌 automation 🔃", config)).toBe("automation 🔃");
    expect(stripLegacyThreadPrefix("🧬 release 🚀", config)).toBe("release 🚀");
    expect(stripLegacyThreadPrefix("🧬🌞🛠️4️⃣ 🚾4️⃣", config)).toBe("");
    expect(stripLegacyThreadPrefix("ordinary 👾 title", config)).toBe("ordinary 👾 title");
    expect(stripLegacyThreadPrefix("BOT worker", {
      agents: [{ match: "bot", replacement: "BOT" }],
      models: [],
      roles: [],
    })).toBe("worker");
    expect(joinThreadName("🤖🌞🛠️4️⃣", "")).toBe("🤖🌞🛠️4️⃣");
  });
});

describe("ThreadNamerConfigStore", () => {
  it("starts with seeds, writes atomically, and protects the last valid snapshot", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-namer-"));
    const file = path.join(dir, "thread-namer.json");
    const store = new ThreadNamerConfigStore(file);
    expect(store.get().agents[0]).toEqual({ match: "copilot", replacement: "🤖" });
    const next = { agents: [{ match: "a", replacement: "A" }], models: [], roles: [] };
    store.save(next);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(next);
    expect(() => store.save({ ...next, agents: [{ match: "", replacement: "A" }] }))
      .toThrow();
    expect(store.get()).toEqual(next);
  });

  it("falls back to defaults on a malformed boot file while explicit reload stays strict", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seam-namer-invalid-"));
    const file = path.join(dir, "thread-namer.json");
    writeFileSync(file, "{ malformed", "utf8");
    const warnings: Array<{ obj: unknown; msg?: string }> = [];

    const store = new ThreadNamerConfigStore(file, {
      warn: (obj, msg) => warnings.push({ obj, ...(msg ? { msg } : {}) }),
    });

    expect(store.get()).toEqual(DEFAULT_THREAD_NAMER_CONFIG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      obj: { file, err: expect.any(Error) },
      msg: "thread namer config load failed; using defaults",
    });
    expect(() => store.reload()).toThrow();
  });
});

describe("namer card rule grammar", () => {
  it("parses comments, colon-bearing matches, first equals, and model qualifiers", () => {
    const parsed = parseThreadNamerRules(
      "# ordered\nsonnet=📜\n:cloud=🦙\ndefault=💫 @copilot\nvalue=a=b",
      "model"
    );
    expect(parsed).toEqual([
      { match: "sonnet", replacement: "📜" },
      { match: ":cloud", replacement: "🦙" },
      { match: "default", replacement: "💫", agent: "copilot" },
      { match: "value", replacement: "a=b" },
    ]);
    expect(formatThreadNamerRules(parsed, "model")).toContain("default=💫 @copilot");
  });

  it("reports exact offending lines and rejects qualifiers outside models", () => {
    expect(() => parseThreadNamerRules("ok=✅\nmissing", "agent")).toThrow("Line 2");
    expect(() => parseThreadNamerRules("=✅", "role")).toThrow("Line 1: match");
    expect(() => parseThreadNamerRules("qa=", "role")).toThrow("Line 1: replacement");
    expect(() => parseThreadNamerRules("qa=🧪 @copilot", "role")).toThrow("Line 1: @agent");
  });
});

describe("ThreadNamer lifecycle", () => {
  function harness(records: SessionRecord[], values: Record<string, Parameters<typeof description>[1]>, names: Record<string, string>) {
    const renames: Array<[string, string]> = [];
    const warnings: Array<{ obj: unknown; msg?: string }> = [];
    const namer = new ThreadNamer({
      getConfig: () => config,
      describeConfig: (rec) => description(rec, values[rec.channelRef]),
      listSessionsByParent: () => records,
      getThreadName: async (id) => names[id] ?? null,
      renameThread: async (id, name) => { renames.push([id, name]); names[id] = name; },
      setNamePrefix: (id, prefix) => {
        const rec = records.find((candidate) => candidate.id === id);
        if (rec) rec.namePrefix = prefix;
      },
      logger: { warn: (obj, msg) => warnings.push({ obj, ...(msg ? { msg } : {}) }) },
    });
    return { namer, renames, warnings };
  }

  it("manages fresh create, preserves stable gaps, and recomputes exact prefixes", async () => {
    const first = record("one"); first.namePrefix = "🤖🌞🛠️1️⃣";
    const third = record("three"); third.namePrefix = "🤖🌞🛠️3️⃣";
    const fresh = record("fresh");
    const records = [first, third, fresh];
    const names = { one: "🤖🌞🛠️1️⃣ one", three: "🤖🌞🛠️3️⃣ three", fresh: "fresh" };
    const values: Record<string, Parameters<typeof description>[1]> = {
      one: { role: "worker" }, three: { role: "worker" }, fresh: { role: "worker" },
    };
    const { namer, renames } = harness(records, values, names);
    await namer.applyThreadName(fresh, { fresh: true });
    expect(renames).toEqual([["fresh", "🤖🌞🛠️2️⃣ fresh"]]);
    values.fresh!.agent = "claude";
    await namer.applyThreadName(fresh);
    expect(renames.at(-1)).toEqual(["fresh", "👾🌞🛠️2️⃣ fresh"]);
  });

  it("leaves legacy and mismatched managed names untouched on normal passes", async () => {
    const legacy = record("legacy");
    const edited = record("edited"); edited.namePrefix = "🤖🌞";
    const records = [legacy, edited];
    const { namer, renames } = harness(records, {}, { legacy: "legacy", edited: "hand edit" });
    expect((await namer.applyThreadName(legacy)).status).toBe("unmanaged");
    expect((await namer.applyThreadName(edited)).status).toBe("unmanaged");
    expect(renames).toEqual([]);
  });

  it("migrates legacy only explicitly and short-circuits either opt-out", async () => {
    const legacy = record("legacy");
    const opted = record("opted");
    const records = [legacy, opted];
    const { namer, renames } = harness(
      records,
      { legacy: { agent: "claude", model: "sonnet", role: "qa" }, opted: { disabled: true, role: "worker" } },
      { legacy: "🤖🪢🛠️4️⃣ base", opted: "leave me" }
    );
    await namer.applyThreadName(legacy, { migrateLegacy: true });
    expect(renames[0]).toEqual(["legacy", "👾📜🧪1️⃣ base"]);
    expect((await namer.applyThreadName(opted, { fresh: true })).status).toBe("opted_out");
    expect(renames).toHaveLength(1);
  });

  it("recompacts each role group independently by creation order", async () => {
    const newer = record("newer", "2026-01-02T00:00:00.000Z"); newer.namePrefix = "🤖🌞🛠️8️⃣";
    const oldest = record("oldest", "2026-01-01T00:00:00.000Z"); oldest.namePrefix = "🤖🌞🛠️4️⃣";
    const qa = record("qa", "2026-01-03T00:00:00.000Z"); qa.namePrefix = "🤖🌞🧪7️⃣";
    const records = [newer, oldest, qa];
    const { namer } = harness(
      records,
      { newer: { role: "worker" }, oldest: { role: "worker" }, qa: { role: "qa" } },
      { newer: "🤖🌞🛠️8️⃣ newer", oldest: "🤖🌞🛠️4️⃣ oldest", qa: "🤖🌞🧪7️⃣ qa" }
    );
    const result = await namer.recompactChannel("discord", "parent");
    expect(result.map((item) => item.name)).toEqual([
      "🤖🌞🛠️1️⃣ oldest",
      "🤖🌞🛠️2️⃣ newer",
      "🤖🌞🧪1️⃣ qa",
    ]);
  });

  it("does not let opted-out or unmanaged threads consume recompaction ordinals", async () => {
    const opted = record("opted", "2026-01-01T00:00:00.000Z");
    const legacy = record("legacy", "2026-01-02T00:00:00.000Z");
    const managed = record("managed", "2026-01-03T00:00:00.000Z");
    managed.namePrefix = "🤖🌞🛠️7️⃣";
    const records = [managed, legacy, opted];
    const { namer } = harness(
      records,
      {
        opted: { role: "worker", disabled: true },
        legacy: { role: "worker" },
        managed: { role: "worker" },
      },
      {
        opted: "leave opted out",
        legacy: "legacy remains unmanaged",
        managed: "🤖🌞🛠️7️⃣ managed",
      }
    );

    const result = await namer.recompactChannel("discord", "parent");
    expect(result.map((item) => [item.status, item.name])).toEqual([
      ["opted_out", undefined],
      ["unmanaged", undefined],
      ["renamed", "🤖🌞🛠️1️⃣ managed"],
    ]);
  });

  it("continues recompaction after one thread rename fails and reports the error", async () => {
    const failed = record("failed", "2026-01-01T00:00:00.000Z");
    failed.namePrefix = "🤖🌞🛠️7️⃣";
    const next = record("next", "2026-01-02T00:00:00.000Z");
    next.namePrefix = "🤖🌞🛠️8️⃣";
    const records = [failed, next];
    const warnings: Array<{ obj: unknown; msg?: string }> = [];
    const renames: Array<[string, string]> = [];
    const names = {
      failed: "🤖🌞🛠️7️⃣ failed",
      next: "🤖🌞🛠️8️⃣ next",
    };
    const namer = new ThreadNamer({
      getConfig: () => config,
      describeConfig: (rec) => description(rec, { role: "worker" }),
      listSessionsByParent: () => records,
      getThreadName: async (id) => names[id as keyof typeof names] ?? null,
      renameThread: async (id, name) => {
        if (id === "failed") throw new Error("Discord rate limit");
        renames.push([id, name]);
      },
      setNamePrefix: () => {},
      logger: { warn: (obj, msg) => warnings.push({ obj, ...(msg ? { msg } : {}) }) },
    });

    const result = await namer.recompactChannel("discord", "parent");

    expect(result.map((item) => item.status)).toEqual(["failed", "renamed"]);
    expect(renames).toEqual([["next", "🤖🌞🛠️1️⃣ next"]]);
    expect(warnings).toEqual([
      {
        obj: {
          err: expect.any(Error),
          platform: "discord",
          parentRef: "parent",
          threadId: "failed",
        },
        msg: "thread name recompaction failed",
      },
    ]);
  });
});
