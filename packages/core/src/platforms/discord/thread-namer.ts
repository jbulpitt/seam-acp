import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ConfigDescription } from "../../core/session-router.js";
import type { SessionRecord } from "../../core/types.js";

export const THREAD_NAME_MAX = 100;
export const KEYCAP_VS = "\uFE0F";
export const KEYCAP_ENCLOSING = "\u20E3";

export interface ThreadNameMatchRule {
  match: string;
  replacement: string;
}

export interface ThreadNameModelMatchRule extends ThreadNameMatchRule {
  /** Optional agent-slug substring qualifier. */
  agent?: string;
}

export interface ThreadNamerConfig {
  agents: ThreadNameMatchRule[];
  models: ThreadNameModelMatchRule[];
  roles: ThreadNameMatchRule[];
}

export type ThreadNamerRuleKind = "agent" | "model" | "role";

export class ThreadNamerRuleParseError extends Error {
  constructor(readonly line: number, message: string) {
    super(`Line ${line}: ${message}`);
    this.name = "ThreadNamerRuleParseError";
  }
}

export const DEFAULT_THREAD_NAMER_CONFIG: ThreadNamerConfig = {
  agents: [
    { match: "copilot", replacement: "🤖" },
    { match: "ollama", replacement: "🦙" },
    { match: "vertex", replacement: "💠" },
    { match: "claude", replacement: "👾" },
    { match: "grok", replacement: "🪐" },
    { match: "agy", replacement: "🌌" },
    { match: "codex", replacement: "🧬" },
  ],
  models: [
    { match: "sonnet", replacement: "📜" },
    { match: "haiku", replacement: "✒️" },
    { match: "opus", replacement: "🎼" },
    { match: "-sol", replacement: "🌞" },
    { match: "-terra", replacement: "🌎" },
    { match: "-luna", replacement: "🌑" },
    { match: "grok", replacement: "🌀" },
    { match: "glm", replacement: "🧊" },
    { match: "kimi", replacement: "⚗️" },
    { match: "gemini", replacement: "♊" },
    { match: "gpt", replacement: "🪢" },
    { match: "auto", replacement: "💫" },
  ],
  roles: [
    { match: "orch", replacement: "🪄" },
    { match: "worker", replacement: "🛠️" },
    { match: "qa", replacement: "🧪" },
    { match: "test", replacement: "🧪" },
    { match: "analyst", replacement: "🔬" },
    { match: "inv", replacement: "🔬" },
    { match: "plan", replacement: "🔰" },
  ],
};

const MatchRuleSchema = z.object({
  match: z.string().trim().min(1).max(128),
  replacement: z.string().trim().min(1).max(32),
});

const ModelMatchRuleSchema = MatchRuleSchema.extend({
  agent: z.string().trim().min(1).max(128).optional(),
});

export const ThreadNamerConfigSchema = z.object({
  agents: z.array(MatchRuleSchema).max(100),
  models: z.array(ModelMatchRuleSchema).max(100),
  roles: z.array(MatchRuleSchema).max(100),
});

export interface ThreadNamerConfigLogger {
  warn(obj: unknown, msg?: string): void;
}

/** Parse the namer card's exact `match=replacement @agent` line grammar. */
export function parseThreadNamerRules(
  text: string,
  kind: ThreadNamerRuleKind
): ThreadNameMatchRule[] | ThreadNameModelMatchRule[] {
  const rules: ThreadNameModelMatchRule[] = [];
  for (const [index, original] of text.split(/\r?\n/).entries()) {
    let line = original.trim();
    if (!line || line.startsWith("#")) continue;
    let agent: string | undefined;
    const qualifier = line.match(/\s+@(\S+)\s*$/);
    if (qualifier?.[1]) {
      agent = qualifier[1];
      line = line.slice(0, qualifier.index).trim();
      if (kind !== "model") {
        throw new ThreadNamerRuleParseError(index + 1, "@agent qualifiers are valid only for model rules");
      }
    }
    const equals = line.indexOf("=");
    if (equals < 0) {
      throw new ThreadNamerRuleParseError(index + 1, "expected match=replacement");
    }
    const match = line.slice(0, equals).trim();
    const replacement = line.slice(equals + 1).trim();
    if (!match) throw new ThreadNamerRuleParseError(index + 1, "match cannot be empty");
    if (!replacement) {
      throw new ThreadNamerRuleParseError(index + 1, "replacement cannot be empty");
    }
    rules.push({ match, replacement, ...(agent ? { agent } : {}) });
  }
  return kind === "model" ? rules : rules.map(({ match, replacement }) => ({ match, replacement }));
}

export function formatThreadNamerRules(
  rules: ReadonlyArray<ThreadNameModelMatchRule>,
  kind: ThreadNamerRuleKind
): string {
  return rules
    .map((rule) =>
      `${rule.match}=${rule.replacement}${kind === "model" && rule.agent ? ` @${rule.agent}` : ""}`
    )
    .join("\n");
}

function cloneConfig(config: ThreadNamerConfig): ThreadNamerConfig {
  return {
    agents: config.agents.map((rule) => ({ ...rule })),
    models: config.models.map((rule) => ({ ...rule })),
    roles: config.roles.map((rule) => ({ ...rule })),
  };
}

/** Small global JSON store. Invalid edits never replace the last valid config. */
export class ThreadNamerConfigStore {
  private config: ThreadNamerConfig;

  constructor(
    readonly file: string,
    private readonly logger?: ThreadNamerConfigLogger
  ) {
    this.config = cloneConfig(DEFAULT_THREAD_NAMER_CONFIG);
    if (fs.existsSync(file)) {
      try {
        this.reload();
      } catch (err) {
        this.logger?.warn(
          { err, file },
          "thread namer config load failed; using defaults"
        );
      }
    }
  }

  get(): ThreadNamerConfig {
    return cloneConfig(this.config);
  }

  reload(): ThreadNamerConfig {
    const parsed = ThreadNamerConfigSchema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
    this.config = cloneConfig(parsed);
    return this.get();
  }

  save(next: ThreadNamerConfig): ThreadNamerConfig {
    const parsed = ThreadNamerConfigSchema.parse(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, this.file);
    this.config = cloneConfig(parsed);
    return this.get();
  }
}

export interface ThreadPrefixSlots {
  agent: string;
  model: string;
  role: string;
  enumeration: string;
}

export interface ComputeThreadPrefixInput {
  agentSlug?: string | null;
  modelSlug?: string | null;
  role?: string | null;
  enumNumber?: number | null;
  config: ThreadNamerConfig;
}

function firstMatch(
  value: string | null | undefined,
  rules: ThreadNameMatchRule[]
): string {
  const haystack = value?.toLowerCase() ?? "";
  if (!haystack) return "";
  return rules.find((rule) => haystack.includes(rule.match.toLowerCase()))?.replacement ?? "";
}

function firstModelMatch(
  model: string | null | undefined,
  agent: string | null | undefined,
  rules: ThreadNameModelMatchRule[]
): string {
  const modelSlug = model?.toLowerCase() ?? "";
  const agentSlug = agent?.toLowerCase() ?? "";
  if (!modelSlug) return "";
  return rules.find((rule) =>
    modelSlug.includes(rule.match.toLowerCase()) &&
    (!rule.agent || agentSlug.includes(rule.agent.toLowerCase()))
  )?.replacement ?? "";
}

/** `1️⃣`…`9️⃣`, `🔟`, then concatenated digit keycaps with no upper cap. */
export function formatThreadOrdinal(n: number): string {
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new RangeError("thread ordinal must be a positive safe integer");
  }
  if (n === 10) return "🔟";
  return String(n)
    .split("")
    .map((digit) => `${digit}${KEYCAP_VS}${KEYCAP_ENCLOSING}`)
    .join("");
}

const DIGIT_KEYCAP = /([0-9])\uFE0F\u20E3/g;

/** Parse only a complete valid enumerator string. */
export function parseThreadOrdinal(value: string): number | null {
  if (value === "🔟") return 10;
  const matches = [...value.matchAll(DIGIT_KEYCAP)];
  if (matches.length === 0 || matches.map((match) => match[0]).join("") !== value) return null;
  const digits = matches.map((match) => match[1]).join("");
  if (!digits || digits.startsWith("0")) return null;
  const parsed = Number(digits);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed !== 10 ? parsed : null;
}

/** Parse an enumerator only when it occupies the end of a stored prefix. */
export function parseThreadOrdinalSuffix(prefix: string): number | null {
  if (prefix.endsWith("🔟")) return 10;
  const match = prefix.match(/((?:[0-9]\uFE0F\u20E3)+)$/u);
  return match?.[1] ? parseThreadOrdinal(match[1]) : null;
}

export function lowestUnusedThreadOrdinal(used: Iterable<number>): number {
  const set = new Set(used);
  for (let value = 1; ; value += 1) {
    if (!set.has(value)) return value;
  }
}

export function computeThreadPrefix(input: ComputeThreadPrefixInput): {
  prefix: string;
  slots: ThreadPrefixSlots;
} {
  const agent = firstMatch(input.agentSlug, input.config.agents);
  const model = firstModelMatch(input.modelSlug, input.agentSlug, input.config.models);
  const role = firstMatch(input.role, input.config.roles);
  const enumeration = role && input.enumNumber ? formatThreadOrdinal(input.enumNumber) : "";
  const slots = { agent, model, role, enumeration };
  return { prefix: `${agent}${model}${role}${enumeration}`, slots };
}

/** Exact stored-prefix boundary. Empty string is a managed all-empty prefix. */
export function stripStoredThreadPrefix(name: string, prefix: string): string | null {
  if (prefix === "") return name;
  if (name === prefix) return "";
  if (!name.startsWith(`${prefix} `)) return null;
  return name.slice(prefix.length + 1);
}

function configuredTokens(config: ThreadNamerConfig): string[] {
  return [...config.agents, ...config.models, ...config.roles]
    .map((rule) => rule.replacement)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

const LEGACY_EMOJI_CLUSTER = /^(?:[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}|\p{Regional_Indicator})[\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]*(?:\u200D(?:[0-9#*]\uFE0F?\u20E3|\p{Extended_Pictographic}|\p{Regional_Indicator})[\uFE0E\uFE0F\u{1F3FB}-\u{1F3FF}]*)*/u;

/** Explicit legacy migration only: strip a leading run of configured tokens or emoji. */
export function stripLegacyThreadPrefix(name: string, config: ThreadNamerConfig): string {
  const tokens = configuredTokens(config);
  let offset = 0;
  let consumedPrefix = false;
  while (offset < name.length) {
    const rest = name.slice(offset);
    const replacement = tokens.find((token) => rest.startsWith(token));
    if (replacement) {
      offset += replacement.length;
      consumedPrefix = true;
      continue;
    }
    const emoji = rest.match(LEGACY_EMOJI_CLUSTER)?.[0];
    if (emoji) {
      offset += emoji.length;
      consumedPrefix = true;
      continue;
    }
    const whitespace = rest.match(/^\s+/u)?.[0];
    if (whitespace) {
      offset += whitespace.length;
      continue;
    }
    break;
  }
  return consumedPrefix ? name.slice(offset).trimStart() : name;
}

export function joinThreadName(prefix: string, base: string): string {
  if (!prefix) return base.slice(0, THREAD_NAME_MAX);
  const room = Math.max(0, THREAD_NAME_MAX - prefix.length - 1);
  return `${prefix} ${base.slice(0, room)}`.trimEnd();
}

export interface ThreadNamerDeps {
  getConfig: () => ThreadNamerConfig;
  describeConfig: (record: SessionRecord) => ConfigDescription;
  listSessionsByParent: (platform: string, parentRef: string) => SessionRecord[];
  getThreadName: (threadId: string) => Promise<string | null>;
  /** Resolves undefined only when the platform confirms the thread is gone. */
  getThreadLiveState: (
    threadId: string
  ) => Promise<{ locked: boolean; archived: boolean } | undefined>;
  renameThread: (threadId: string, name: string) => Promise<void>;
  setNamePrefix: (sessionId: string, prefix: string | null) => void;
  logger: { warn(obj: unknown, msg?: string): void };
}

export interface ApplyThreadNameOptions {
  /** Newly-created thread whose current title is known to be an unprefixed base. */
  fresh?: boolean;
  /** Explicit legacy migration; the only path allowed to use heuristic stripping. */
  migrateLegacy?: boolean;
  /** Used by channel recompaction to force the creation-order ordinal. */
  ordinal?: number;
  /** Explicitly discard the old base and rebuild it from the resolved role. */
  roleName?: boolean;
}

export interface ApplyThreadNameResult {
  status:
    | "renamed"
    | "rebuilt"
    | "unchanged"
    | "unmanaged"
    | "roleless"
    | "opted_out"
    | "gone";
  name?: string;
  prefix?: string;
}

export type RecompactThreadNameResult =
  | ApplyThreadNameResult
  | { status: "failed" };

export class ThreadNamer {
  constructor(private readonly deps: ThreadNamerDeps) {}

  async applyThreadName(
    record: SessionRecord,
    options: ApplyThreadNameOptions = {}
  ): Promise<ApplyThreadNameResult> {
    const description = this.deps.describeConfig(record);
    if (description.disableThreadPrefix.value) return { status: "opted_out" };
    const current = await this.deps.getThreadName(record.channelRef);
    if (current === null) {
      try {
        const live = await this.deps.getThreadLiveState(record.channelRef);
        if (live === undefined) {
          this.deps.setNamePrefix(record.id, null);
          record.namePrefix = null;
          return { status: "gone" };
        }
      } catch {
        // A failed liveness check cannot prove deletion. Keep the ordinal reserved.
      }
      return { status: "unchanged" };
    }

    const resolvedRole = description.role.value?.trim() || null;
    let base: string;
    if (options.roleName) {
      if (!resolvedRole) return { status: "roleless" };
      base = resolvedRole;
    } else if (options.fresh) {
      base = current;
    } else if (options.migrateLegacy) {
      base = stripLegacyThreadPrefix(current, this.deps.getConfig());
    } else if (record.namePrefix !== null && record.namePrefix !== undefined) {
      const stripped = stripStoredThreadPrefix(current, record.namePrefix);
      if (stripped === null) return { status: "unmanaged" };
      base = stripped;
    } else {
      return { status: "unmanaged" };
    }

    const config = this.deps.getConfig();
    const roleSlot = firstMatch(description.role.value, config.roles);
    const ordinal = roleSlot
      ? options.ordinal ?? this.allocateOrdinal(record, roleSlot)
      : null;
    const computed = computeThreadPrefix({
      agentSlug: description.agent.value,
      modelSlug: description.model.value,
      role: description.role.value,
      enumNumber: ordinal,
      config,
    });
    const nextName = joinThreadName(computed.prefix, base);
    if (nextName !== current) await this.deps.renameThread(record.channelRef, nextName);
    this.deps.setNamePrefix(record.id, computed.prefix);
    record.namePrefix = computed.prefix;
    return {
      status: nextName === current ? "unchanged" : options.roleName ? "rebuilt" : "renamed",
      name: nextName,
      prefix: computed.prefix,
    };
  }

  /**
   * Explicit user rename. A managed thread keeps its computed prefix around the
   * supplied base. An unmanaged/mismatched thread receives the requested name
   * verbatim and remains unmanaged; this is not an implicit legacy migration.
   */
  async renameBase(record: SessionRecord, base: string): Promise<ApplyThreadNameResult> {
    const requested = base.trim() || "seam";
    const description = this.deps.describeConfig(record);
    const current = await this.deps.getThreadName(record.channelRef);
    if (description.disableThreadPrefix.value) {
      if (current !== requested) await this.deps.renameThread(record.channelRef, requested);
      return { status: current === requested ? "unchanged" : "renamed", name: requested };
    }
    if (
      record.namePrefix === null ||
      record.namePrefix === undefined ||
      current === null ||
      stripStoredThreadPrefix(current, record.namePrefix) === null
    ) {
      if (current !== requested) await this.deps.renameThread(record.channelRef, requested);
      this.deps.setNamePrefix(record.id, null);
      record.namePrefix = null;
      return { status: current === requested ? "unchanged" : "renamed", name: requested };
    }

    const config = this.deps.getConfig();
    const roleSlot = firstMatch(description.role.value, config.roles);
    const computed = computeThreadPrefix({
      agentSlug: description.agent.value,
      modelSlug: description.model.value,
      role: description.role.value,
      enumNumber: roleSlot ? this.allocateOrdinal(record, roleSlot) : null,
      config,
    });
    const nextName = joinThreadName(computed.prefix, requested);
    if (current !== nextName) await this.deps.renameThread(record.channelRef, nextName);
    this.deps.setNamePrefix(record.id, computed.prefix);
    record.namePrefix = computed.prefix;
    return {
      status: current === nextName ? "unchanged" : "renamed",
      name: nextName,
      prefix: computed.prefix,
    };
  }

  /** Recompute a whole channel and compact each role group by creation order. */
  async recompactChannel(
    platform: string,
    parentRef: string,
    options: { migrateLegacy?: boolean; roleName?: boolean } = {}
  ): Promise<RecompactThreadNameResult[]> {
    const records = this.deps
      .listSessionsByParent(platform, parentRef)
      .sort((a, b) => a.createdUtc.localeCompare(b.createdUtc) || a.id.localeCompare(b.id));
    const counters = new Map<string, number>();
    const results: RecompactThreadNameResult[] = [];
    for (const record of records) {
      const description = this.deps.describeConfig(record);
      const roleSlot = firstMatch(description.role.value, this.deps.getConfig().roles);
      const ordinal = roleSlot ? (counters.get(roleSlot) ?? 0) + 1 : undefined;
      try {
        const result = await this.applyThreadName(record, {
          migrateLegacy: options.migrateLegacy,
          roleName: options.roleName,
          ...(ordinal ? { ordinal } : {}),
        });
        if (
          roleSlot &&
          result.status !== "unmanaged" &&
          result.status !== "opted_out" &&
          result.status !== "gone"
        ) {
          counters.set(roleSlot, ordinal!);
        }
        results.push(result);
      } catch (err) {
        this.deps.logger.warn(
          { err, platform, parentRef, threadId: record.channelRef },
          "thread name recompaction failed"
        );
        results.push({ status: "failed" });
      }
    }
    return results;
  }

  private allocateOrdinal(record: SessionRecord, roleSlot: string): number {
    const own = record.namePrefix ? parseThreadOrdinalSuffix(record.namePrefix) : null;
    const peers = this.deps.listSessionsByParent(record.platform, record.parentRef ?? "");
    const used: number[] = [];
    for (const peer of peers) {
      if (peer.id === record.id) continue;
      const peerDescription = this.deps.describeConfig(peer);
      if (peerDescription.disableThreadPrefix.value) continue;
      if (firstMatch(peerDescription.role.value, this.deps.getConfig().roles) !== roleSlot) continue;
      const ordinal = peer.namePrefix ? parseThreadOrdinalSuffix(peer.namePrefix) : null;
      if (ordinal !== null) used.push(ordinal);
    }
    if (own !== null && !used.includes(own)) return own;
    return lowestUnusedThreadOrdinal(used);
  }
}
