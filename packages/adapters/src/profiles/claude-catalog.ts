/**
 * Live-first direct-Anthropic Claude catalog (#232).
 *
 * All Claude-specific discovery, aliasing, merging, and verification metadata
 * lives here so core stays free of provider naming conventions.
 *
 * ## Why this is not just "read the advertised list"
 *
 * `claude-agent-acp` advertises a short, account-shaped model list. Measured on
 * this subscription (2026-09-08, wrapper 0.73.0) it is exactly:
 *
 *   default, opus[1m], claude-fable-5-1[1m], sonnet, haiku
 *
 * Five canonical models that ARE reachable and JSONL-verified — `claude-opus-5`,
 * `claude-opus-4-8`, `claude-opus-4-7`, `claude-fable-5`, `claude-sonnet-5` —
 * are ABSENT from it. The Seam Claude profile reaches them by forwarding the
 * canonical id through `ANTHROPIC_MODEL`, which both registers and selects it.
 * A live-only catalog would therefore silently delete five working models; a
 * static-only catalog (the pre-#232 behavior) misses live capability changes and
 * publishes per-model effort it never measured.
 *
 * So: the live ACP list is the operational base, and {@link CLAUDE_VERIFIED_OVERLAY}
 * re-adds verified canonical models **only when absent from ACP**, carrying the
 * evidence that justifies each one.
 *
 * ## Evidence rules (docs/model-management-runbook.md)
 *
 * - Identity, context window, and effort application are NEVER inferred from a
 *   label, a display name, an id substring, or a model's self-report. Windows
 *   come from the JSONL-verified table only; an unverified live model publishes
 *   a null window rather than a guess.
 * - Per-model options are probed in ISOLATED FRESH SESSIONS. Switching models
 *   inside one session lets the previous model's state decide the next model's
 *   advertised defaults.
 * - Discovery spends ZERO model tokens: it never calls `session/prompt`.
 *   Token-spending JSONL verification is a controlled maintenance operation that
 *   updates the overlay (runbook §4), never part of a refresh.
 */
import { spawn } from "node:child_process";
import os from "node:os";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type SessionConfigOption,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOption,
  type SessionConfigSelectOptions,
} from "@agentclientprotocol/sdk";
import type { CatalogEffortMechanism, ManifestCatalogModel } from "../model-catalog.js";

/** One advertised model as observed in its own fresh ACP session. */
export interface ClaudeProbedModel {
  /** Exactly what ACP advertised, e.g. `claude-fable-5-1[1m]` or `sonnet`. */
  advertisedId: string;
  /** ACP's display name. Cosmetic only — never used to decide identity. */
  advertisedName: string;
  /**
   * The `model` config option's `currentValue` in that model's own fresh
   * session. For an alias the wrapper may echo the alias back unresolved
   * (measured: `default` → `default`), which is NOT a resolution.
   */
  resolvedValue: string | null;
  /** Effort values that model's own session advertised; empty when it offers none. */
  effortChoices: string[];
  /** That session's advertised effort `currentValue`, if any. */
  effortCurrent: string | null;
  /** Every config option id the fresh session advertised (diagnostics). */
  configIds: string[];
}

export interface ClaudeCatalogProbe {
  models: ClaudeProbedModel[];
  /** `model` `currentValue` of a bare session — recorded, never used as a default. */
  wrapperCurrentValue: string | null;
}

/** A JSONL-verified model kept available when the wrapper stops advertising it. */
export interface ClaudeVerifiedOverlayEntry {
  modelId: string;
  displayName: string;
  /** UTC date the evidence below was captured (runbook §4). */
  verifiedOn: string;
  /** Wrapper the evidence was captured against. */
  wrapperVersion: string;
  /** Claude Code CLI the evidence was captured against. */
  claudeCodeVersion: string;
  /** Credential scope the evidence was captured on (`default` = `~/.claude`). */
  credentialScope: string;
  /** GROUND TRUTH: `entry.message.model` from the assistant JSONL entry. */
  resolvedModel: string;
  /** Native window proven by the runbook §4/§4a cross-check. */
  contextWindow: number;
  /** Effort values proven applied via the JSONL top-level `effort` field. */
  effortChoices: string[];
  /** How the evidence was obtained, for an auditor re-running it. */
  evidence: string;
}

/**
 * Versioned. Bump when entries change so an auditor can tell which generation
 * of evidence a published snapshot carries.
 */
export const CLAUDE_VERIFIED_OVERLAY_VERSION = 1;

/**
 * Verified 2026-09-02 (docs/model-management-runbook.md, "Current verified
 * picture"): every row proven through the actual Seam mechanism — canonical id
 * forwarded via `ANTHROPIC_MODEL`, `set_config_option` accepted, resolved model
 * read from assistant JSONL, window cross-checked against the raw CLI
 * `/context` denominator.
 *
 * This is DATA, not a fallback list: an entry is published only when the live
 * ACP list does not already cover that canonical model.
 *
 * Re-verify with runbook §4 + §4a and update `verifiedOn` — never edit a row to
 * match a hope.
 */
export const CLAUDE_VERIFIED_OVERLAY: ReadonlyArray<ClaudeVerifiedOverlayEntry> = [
  {
    modelId: "default",
    displayName: "Opus latest",
    verifiedOn: "2026-09-02",
    wrapperVersion: "claude-agent-acp 0.73.0",
    claudeCodeVersion: "@anthropic-ai/claude-code (ACP SDK 1.4.0)",
    credentialScope: "default",
    resolvedModel: "claude-opus-5",
    contextWindow: 1_000_000,
    effortChoices: ["default", "low", "medium", "high", "xhigh", "max"],
    evidence: "runbook §4 JSONL entry.message.model + §4a raw-CLI /context; §11 JSONL effort",
  },
  {
    modelId: "claude-fable-5-1",
    displayName: "Fable 5.1",
    verifiedOn: "2026-09-02",
    wrapperVersion: "claude-agent-acp 0.73.0",
    claudeCodeVersion: "@anthropic-ai/claude-code (ACP SDK 1.4.0)",
    credentialScope: "default",
    resolvedModel: "claude-fable-5-1",
    contextWindow: 1_000_000,
    effortChoices: ["default", "low", "medium", "high", "xhigh", "max"],
    evidence: "runbook §4 JSONL entry.message.model + §4a raw-CLI /context; §11 JSONL effort",
  },
  {
    modelId: "claude-opus-5",
    displayName: "Opus 5",
    verifiedOn: "2026-09-02",
    wrapperVersion: "claude-agent-acp 0.73.0",
    claudeCodeVersion: "@anthropic-ai/claude-code (ACP SDK 1.4.0)",
    credentialScope: "default",
    resolvedModel: "claude-opus-5",
    contextWindow: 1_000_000,
    effortChoices: ["default", "low", "medium", "high", "xhigh", "max"],
    evidence: "runbook §4 JSONL entry.message.model + §4a raw-CLI /context; §11 JSONL effort",
  },
  {
    modelId: "claude-opus-4-8",
    displayName: "Opus 4.8",
    verifiedOn: "2026-09-02",
    wrapperVersion: "claude-agent-acp 0.73.0",
    claudeCodeVersion: "@anthropic-ai/claude-code (ACP SDK 1.4.0)",
    credentialScope: "default",
    resolvedModel: "claude-opus-4-8",
    contextWindow: 1_000_000,
    effortChoices: ["default", "low", "medium", "high", "xhigh", "max"],
    evidence: "runbook §4 JSONL entry.message.model + §4a raw-CLI /context; §11 JSONL effort",
  },
  {
    modelId: "claude-opus-4-7",
    displayName: "Opus 4.7",
    verifiedOn: "2026-09-02",
    wrapperVersion: "claude-agent-acp 0.73.0",
    claudeCodeVersion: "@anthropic-ai/claude-code (ACP SDK 1.4.0)",
    credentialScope: "default",
    resolvedModel: "claude-opus-4-7",
    contextWindow: 1_000_000,
    effortChoices: ["default", "low", "medium", "high", "xhigh", "max"],
    evidence: "runbook §4 JSONL entry.message.model + §4a raw-CLI /context; §11 JSONL effort",
  },
  {
    modelId: "claude-fable-5",
    displayName: "Fable 5",
    verifiedOn: "2026-09-02",
    wrapperVersion: "claude-agent-acp 0.73.0",
    claudeCodeVersion: "@anthropic-ai/claude-code (ACP SDK 1.4.0)",
    credentialScope: "default",
    resolvedModel: "claude-fable-5",
    contextWindow: 1_000_000,
    effortChoices: ["default", "low", "medium", "high", "xhigh", "max"],
    evidence: "runbook §4 JSONL entry.message.model + §4a raw-CLI /context; §11 JSONL effort",
  },
  {
    modelId: "claude-sonnet-5",
    displayName: "Sonnet 5",
    verifiedOn: "2026-09-02",
    wrapperVersion: "claude-agent-acp 0.73.0",
    claudeCodeVersion: "@anthropic-ai/claude-code (ACP SDK 1.4.0)",
    credentialScope: "default",
    resolvedModel: "claude-sonnet-5",
    contextWindow: 1_000_000,
    effortChoices: ["default", "low", "medium", "high", "xhigh", "max"],
    evidence: "runbook §4 JSONL entry.message.model + §4a raw-CLI /context; §11 JSONL effort",
  },
];

/** Full canonical Claude id, e.g. `claude-opus-5`. Mirrors the spawn-time
 *  `ANTHROPIC_MODEL` forwarding rule so discovery and runtime agree. */
function isCanonicalClaudeId(value: string): boolean {
  return /^claude-[a-z]+-\d/.test(value.trim().toLowerCase());
}

/**
 * Canonical identity for merging. The wrapper advertises window variants of
 * canonical ids with a `[1m]` suffix (`claude-fable-5-1[1m]`); that is the same
 * model as `claude-fable-5-1` and must not publish twice.
 *
 * The suffix is stripped ONLY for full canonical ids. Stripping it from a bare
 * alias would manufacture `opus` out of `opus[1m]`, and the runbook records
 * `opus` as fuzzy-resolving to a different family — an id we must never mint.
 * The suffix is also NOT read as a context-window claim; windows come from the
 * verified table alone.
 */
export function canonicalClaudeModelId(advertisedId: string): string {
  const trimmed = advertisedId.trim();
  const stripped = trimmed.replace(/\[1m\]$/i, "");
  return stripped !== trimmed && isCanonicalClaudeId(stripped) ? stripped : trimmed;
}

function flattenSelectOptions(options: SessionConfigSelectOptions): SessionConfigSelectOption[] {
  return (options as Array<SessionConfigSelectOption | SessionConfigSelectGroup>).flatMap((option) =>
    "options" in option ? option.options : [option]
  );
}

function configOptions(value: unknown): SessionConfigOption[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is SessionConfigOption =>
        Boolean(entry && typeof entry === "object" && "id" in entry))
    : [];
}

function selectOption(
  options: SessionConfigOption[],
  id: string
): Extract<SessionConfigOption, { type: "select" }> | undefined {
  const option = options.find((entry) => entry.id === id);
  return option?.type === "select" ? option : undefined;
}

function probeTimeout<T>(ms: number, message: string): Promise<T> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
}

interface ClaudeProbeSession {
  options: SessionConfigOption[];
  /** Select a model IN THIS FRESH SESSION and return what it then advertises. */
  select: (value: string) => Promise<SessionConfigOption[]>;
  close: () => Promise<void>;
}

/**
 * One fresh `claude-agent-acp` session, opened only far enough to read what it
 * advertises. Never prompts, so it costs nothing. Always tears the child down.
 */
async function openProbeSession(opts: {
  cli: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
}): Promise<ClaudeProbeSession> {
  const child = spawn(opts.cli, [], { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  const died = new Promise<never>((_resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      reject(new Error(`claude-agent-acp exited early (code=${code}, signal=${signal}): ${stderr.trim()}`))
    );
  });
  const connection = new ClientSideConnection(
    () => ({
      async requestPermission() { return { outcome: { outcome: "cancelled" as const } }; },
      async sessionUpdate() {},
    } satisfies Client),
    ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    )
  );
  let sessionId: string | undefined;
  try {
    await Promise.race([
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }),
      died,
      probeTimeout<void>(opts.timeoutMs, "claude-agent-acp initialize timed out"),
    ]);
    const session = await Promise.race([
      connection.newSession({ cwd: opts.cwd, mcpServers: [] }),
      died,
      probeTimeout<never>(opts.timeoutMs, "claude-agent-acp session/new timed out"),
    ]);
    sessionId = session.sessionId;
    const activeSessionId = session.sessionId;
    return {
      options: configOptions(session.configOptions),
      select: async (value: string) => {
        const response = await Promise.race([
          connection.setSessionConfigOption({ sessionId: activeSessionId, configId: "model", value }),
          died,
          probeTimeout<never>(opts.timeoutMs, `claude-agent-acp model select timed out for ${value}`),
        ]);
        return configOptions(response.configOptions);
      },
      // Cleanup WAITS for the child to actually exit. A refresh opens one
      // process per advertised model; returning while they are still dying
      // would let a scheduled refresh pile wrappers up on the host.
      close: async () => {
        if (sessionId) await connection.closeSession({ sessionId }).catch(() => undefined);
        await reap(child);
      },
    };
  } catch (err) {
    await reap(child);
    // The SDK surfaces a dead wrapper as a bare "ACP connection closed", which
    // tells an operator nothing. Carry the wrapper's own stderr into the error
    // so a failed refresh is diagnosable from the log line alone.
    const detail = stderr.trim();
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(detail && !message.includes(detail) ? `${message}: ${detail}` : message);
  }
}

/** SIGKILL and wait for the process to be reaped, bounded so a wedged child
 *  cannot hang a refresh. */
function reap(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, 2_000);
    timer.unref?.();
    child.once("exit", done);
    child.once("error", done);
    child.kill("SIGKILL");
  });
}

function readProbedModel(
  advertised: SessionConfigSelectOption,
  options: SessionConfigOption[]
): ClaudeProbedModel {
  const modelOption = selectOption(options, "model");
  const effortOption = selectOption(options, "effort");
  const effortChoices = effortOption ? flattenSelectOptions(effortOption.options).map((entry) => entry.value) : [];
  return {
    advertisedId: advertised.value,
    advertisedName: advertised.name,
    resolvedValue: typeof modelOption?.currentValue === "string" ? modelOption.currentValue : null,
    effortChoices,
    effortCurrent: typeof effortOption?.currentValue === "string" ? effortOption.currentValue : null,
    configIds: options.map((entry) => entry.id),
  };
}

/**
 * Adapter-owned zero-token ACP discovery for direct-Anthropic Claude.
 *
 * One bare session yields the advertised list. Each advertised model is then
 * observed in its OWN fresh session, spawned with the same environment runtime
 * spawn would use for that model (including `ANTHROPIC_MODEL` forwarding for
 * canonical ids), so what we publish is what a real turn would get. The bare
 * session is reused for whichever model it already came up on — that is still
 * that model's own uncontaminated fresh session, and it saves a spawn.
 */
export async function probeClaudeCatalog(options: {
  cliPath?: string;
  cwd?: string;
  /** Base environment; the credential-scoped env runtime spawn would use. */
  env?: NodeJS.ProcessEnv;
  /** Per-model `ANTHROPIC_MODEL` forwarding, mirroring the profile's spawn(). */
  modelEnv?: (modelId: string) => NodeJS.ProcessEnv;
  timeoutMs?: number;
  concurrency?: number;
}): Promise<ClaudeCatalogProbe> {
  const cli = options.cliPath?.trim() || "claude-agent-acp";
  const cwd = options.cwd ?? os.tmpdir();
  const baseEnv = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 45_000;

  const base = await openProbeSession({ cli, env: baseEnv, cwd, timeoutMs });
  let advertised: SessionConfigSelectOption[];
  let wrapperCurrentValue: string | null;
  let reusable: ClaudeProbedModel | null = null;
  try {
    const modelOption = selectOption(base.options, "model");
    if (!modelOption) throw new Error("claude-agent-acp advertised no model config option");
    advertised = flattenSelectOptions(modelOption.options);
    if (!advertised.length) throw new Error("claude-agent-acp advertised an empty model list");
    wrapperCurrentValue = typeof modelOption.currentValue === "string" ? modelOption.currentValue : null;
    const onSelf = advertised.find((entry) => entry.value === wrapperCurrentValue);
    if (onSelf) reusable = readProbedModel(onSelf, base.options);
  } finally {
    await base.close();
  }

  const results = new Map<string, ClaudeProbedModel>();
  if (reusable) results.set(reusable.advertisedId, reusable);
  const pending = advertised.filter((entry) => !results.has(entry.value));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, pending.length || 1));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const entry = pending[cursor++]!;
      const env = options.modelEnv ? options.modelEnv(entry.value) : baseEnv;
      const session = await openProbeSession({ cli, env, cwd, timeoutMs });
      try {
        // `ANTHROPIC_MODEL` forwarding only covers canonical ids. An ALIAS
        // (`default`, `opus[1m]`, `haiku`) is not selected by the environment,
        // so a fresh session comes up on whatever the wrapper prefers —
        // measured: `sonnet`. Reading that session as if it were the alias
        // publishes one model's capabilities under another model's name.
        // Select it explicitly, ONCE, in this session that has selected nothing
        // else; that is what keeps the observation isolated.
        const current = selectOption(session.options, "model")?.currentValue;
        const observed = current === entry.value ? session.options : await session.select(entry.value);
        results.set(entry.value, readProbedModel(entry, observed));
      } finally {
        await session.close();
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  // Advertised order is the wrapper's own preference order; keep it stable so a
  // refresh that changes nothing produces an identical checksum.
  return {
    models: advertised.map((entry) => results.get(entry.value)!).filter(Boolean),
    wrapperCurrentValue,
  };
}

const EFFORT_DEFAULT = "default";

function normalizeEffortChoices(choices: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const choice of choices) {
    const value = choice.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  if (!out.includes(EFFORT_DEFAULT)) out.unshift(EFFORT_DEFAULT);
  return out;
}

export interface ClaudeCatalogMergeInput {
  probe: ClaudeCatalogProbe;
  overlay: ReadonlyArray<ClaudeVerifiedOverlayEntry>;
  /** Verified native window for a canonical id, or undefined when unproven. */
  nativeContextWindow: (modelId: string) => number | undefined;
  /** Operator-configured labels, keyed by model id. Display text only. */
  displayNames?: ReadonlyMap<string, string>;
  /**
   * Effort mechanism Seam actually applies for this profile. Claude applies
   * effort through `_meta.claudeCode.options.effort` ("meta"), so the live
   * `effort` config option is read as CAPABILITY, not as the application path.
   */
  effortMechanism: CatalogEffortMechanism;
  effortConfigId?: string;
}

/**
 * Merge the live base with the verified overlay, deterministically, by
 * canonical identity. Live wins; an overlay entry is published only when its
 * canonical model is absent from the live list. Ordering is live-advertised
 * order followed by overlay declaration order, so an unchanged wrapper and an
 * unchanged overlay always checksum identically.
 */
export function mergeClaudeCatalogModels(input: ClaudeCatalogMergeInput): ManifestCatalogModel[] {
  const overlayById = new Map(input.overlay.map((entry) => [entry.modelId, entry]));
  const merged: ManifestCatalogModel[] = [];
  const published = new Set<string>();

  for (const probed of input.probe.models) {
    const id = canonicalClaudeModelId(probed.advertisedId);
    if (published.has(id)) continue;
    published.add(id);
    const verified = overlayById.get(id);
    // The wrapper may echo an alias back at us unresolved (`default` → `default`).
    // That is not a resolution, so we never manufacture one: we quote the latest
    // verified resolution with its provenance, or say plainly that it is unknown.
    const selfResolved = Boolean(probed.resolvedValue && probed.resolvedValue !== probed.advertisedId);
    const resolutionNote = selfResolved
      ? `resolved=${probed.resolvedValue}`
      : verified
        ? `resolution unverified live — latest verified ${verified.resolvedModel} (${describeOverlayEvidence(verified)})`
        : "resolution unverified";
    const window = input.nativeContextWindow(id) ?? null;
    const effortChoices = probed.effortChoices.length ? normalizeEffortChoices(probed.effortChoices) : [EFFORT_DEFAULT];
    const selectionDefault =
      probed.effortCurrent && effortChoices.includes(probed.effortCurrent) ? probed.effortCurrent : EFFORT_DEFAULT;
    merged.push({
      modelId: id,
      runtimeId: id,
      name: input.displayNames?.get(id) ?? probed.advertisedName ?? id,
      ...(id === probed.advertisedId ? {} : { aliases: [probed.advertisedId] }),
      context: { native: window, maximum: window, effective: window },
      contextLimit: window ?? undefined,
      provenance: `acp-live; ${resolutionNote}`,
      effort: {
        // Capability comes from the live session; the APPLICATION path is Seam's
        // `_meta` injection either way. A model advertising no effort option gets
        // "none" so the picker cannot offer a level that model will not honor.
        mechanism: probed.effortChoices.length ? input.effortMechanism : "none",
        ...(probed.effortChoices.length && input.effortConfigId ? { configId: input.effortConfigId } : {}),
        choices: effortChoices,
        selectionDefault,
      },
    });
  }

  for (const entry of input.overlay) {
    if (published.has(entry.modelId)) continue;
    published.add(entry.modelId);
    const choices = normalizeEffortChoices(entry.effortChoices);
    merged.push({
      modelId: entry.modelId,
      runtimeId: entry.modelId,
      name: input.displayNames?.get(entry.modelId) ?? entry.displayName,
      context: {
        native: entry.contextWindow,
        maximum: entry.contextWindow,
        effective: entry.contextWindow,
      },
      contextLimit: entry.contextWindow,
      provenance: `verified-overlay; absent from ACP; resolved=${entry.resolvedModel}; ${describeOverlayEvidence(entry)}`,
      effort: {
        mechanism: choices.length > 1 ? input.effortMechanism : "none",
        ...(choices.length > 1 && input.effortConfigId ? { configId: input.effortConfigId } : {}),
        choices,
        selectionDefault: EFFORT_DEFAULT,
      },
    });
  }

  return merged;
}

function describeOverlayEvidence(entry: ClaudeVerifiedOverlayEntry): string {
  return [
    `verified ${entry.verifiedOn}`,
    entry.wrapperVersion,
    entry.claudeCodeVersion,
    `credential scope ${entry.credentialScope}`,
    `context ${entry.contextWindow}`,
    `effort [${entry.effortChoices.join(",")}]`,
    entry.evidence,
  ].join("; ");
}

/**
 * Pick which merged row is the catalog default.
 *
 * Deliberately NOT the probe's `currentValue`: a bare wrapper session comes up
 * on whatever the wrapper feels like (measured: `sonnet`), and adopting that
 * would silently move every new thread off the operator's configured default.
 * The operator's configured id wins; the fallbacks below are ordered and
 * documented so the choice is never a surprise.
 */
export function resolveClaudeDefaultModel(
  models: ReadonlyArray<ManifestCatalogModel>,
  configuredDefault: string
): string {
  const configured = configuredDefault.trim();
  if (models.some((model) => model.modelId === configured)) return configured;
  if (models.some((model) => model.modelId === EFFORT_DEFAULT)) return EFFORT_DEFAULT;
  return models[0]?.modelId ?? configured;
}
