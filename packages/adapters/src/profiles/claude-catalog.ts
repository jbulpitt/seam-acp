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
import type { CatalogEffortMechanism, CatalogModelEvidence, ManifestCatalogModel } from "../model-catalog.js";
import { runBoundedProbe } from "../probe-process.js";

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

interface ClaudeProbeSession {
  options: SessionConfigOption[];
  /** Select a model IN THIS FRESH SESSION and return what it then advertises. */
  select: (value: string) => Promise<SessionConfigOption[]>;
}

/**
 * One fresh `claude-agent-acp` session, opened only far enough to read what it
 * advertises, run inside the SHARED bounded probe lifecycle (#236).
 *
 * The lifecycle — bounded stdout/stderr, phased session-before-connection
 * close with an AbortSignal, sealed registration, SIGTERM→SIGKILL with an
 * awaited exit, redacted structured errors, cancellation — belongs to
 * `runBoundedProbe`. This function contributes only the ACP protocol work, so
 * there is no private timeout/cleanup path here to drift from the shared one.
 */
async function withProbeSession<T>(opts: {
  cli: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
  killGraceMs?: number;
  signal?: AbortSignal;
  read: (session: ClaudeProbeSession) => Promise<T>;
}): Promise<T> {
  return runBoundedProbe<T>({
    executable: opts.cli,
    args: [],
    cwd: opts.cwd,
    env: opts.env,
    timeoutMs: opts.timeoutMs,
    // A catalog probe opens one wrapper per advertised model, so the per-session
    // teardown budget is multiplied by the model count. The wrapper exits
    // promptly on SIGTERM and answers `session/close` quickly when healthy, so
    // a tight window keeps a healthy refresh fast while a wedged one is still
    // bounded — it just reaches SIGKILL sooner.
    killGraceMs: opts.killGraceMs ?? 1_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
    label: "claude-agent-acp catalog probe",
    run: async (handle) => {
      // A dead wrapper surfaces two ways at once: the SDK rejects with a bare
      // "ACP connection closed", and the helper's `exited` rejects with the
      // real cause (exit code plus the redacted stderr tail). The SDK usually
      // wins the race, so remember the exit cause and prefer it — otherwise a
      // wrapper that refused to start is reported as a protocol error.
      let exitCause: unknown;
      handle.exited.catch((err: unknown) => { exitCause = err; });
      const connection = new ClientSideConnection(
        () => ({
          async requestPermission() { return { outcome: { outcome: "cancelled" as const } }; },
          async sessionUpdate() {},
        } satisfies Client),
        ndJsonStream(
          Writable.toWeb(handle.stdin) as unknown as WritableStream<Uint8Array>,
          Readable.toWeb(handle.stdout) as unknown as ReadableStream<Uint8Array>
        )
      );
      // Racing `handle.exited` turns a dead wrapper into a diagnosable error
      // instead of a hang; the helper adds the deadline and the redacted tail.
      let session: Awaited<ReturnType<typeof connection.newSession>>;
      try {
        await Promise.race([
          connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          }),
          handle.exited,
        ]);
        session = await Promise.race([
          connection.newSession({ cwd: opts.cwd, mcpServers: [] }),
          handle.exited,
        ]);
      } catch (err) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw exitCause ?? err;
      }
      const sessionId = session.sessionId;
      // Registered as the SESSION phase so it is closed while its transport is
      // still up, and bounded by the helper's own window: a wrapper that stays
      // alive but never answers `session/close` cannot hang a refresh, because
      // the helper stops awaiting on its signal and proceeds to terminate.
      handle.onClose(async (signal) => {
        await Promise.race([
          connection.closeSession({ sessionId }).catch(() => undefined),
          new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true })
          ),
        ]);
      }, "session");
      // CONNECTION phase. `ClientSideConnection` exposes no close/dispose — an
      // ACP connection IS its stream — so closing the connection means ending
      // the writable side (the normal client disconnect) and awaiting the
      // transport to finish, after the session close has had its turn.
      handle.onClose(async (signal) => {
        await new Promise<void>((resolve) => {
          if (handle.stdin.writableEnded) { resolve(); return; }
          signal.addEventListener("abort", () => resolve(), { once: true });
          handle.stdin.end(() => resolve());
        });
        await new Promise<void>((resolve) => {
          if (!handle.stdout.readable) { resolve(); return; }
          signal.addEventListener("abort", () => resolve(), { once: true });
          handle.stdout.once("end", () => resolve());
          handle.stdout.once("close", () => resolve());
          handle.stdout.resume();
        });
      }, "connection");
      try {
        return await opts.read({
          options: configOptions(session.configOptions),
          select: async (value: string) => {
            const response = await Promise.race([
              connection.setSessionConfigOption({ sessionId, configId: "model", value }),
              handle.exited,
            ]);
            return configOptions(response.configOptions);
          },
        });
      } catch (err) {
        // Give the exit event a bounded moment to land, so the accurate cause
        // wins deterministically rather than by race order.
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw exitCause ?? err;
      }
    },
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
  /**
   * Working directory. Defaults to the SAME cwd runtime spawn uses (the Seam
   * process cwd), so discovery observes what a real turn would rather than a
   * temp directory the wrapper has never seen.
   */
  cwd?: string;
  /** Base environment; the credential-scoped env runtime spawn would use. */
  env?: NodeJS.ProcessEnv;
  /**
   * Per-model environment, keyed by the CANONICAL model id — the value a real
   * catalog selection would spawn with. Probing with the raw advertised id
   * (`claude-fable-5-1[1m]`) while runtime selects the canonical one
   * (`claude-fable-5-1`) means the probe is not observing the runtime path.
   */
  modelEnv?: (canonicalModelId: string) => NodeJS.ProcessEnv;
  timeoutMs?: number;
  concurrency?: number;
  /**
   * ONE deadline for the entire catalog collection, across every model and
   * every concurrency wave. `timeoutMs` bounds a single session; without this
   * a model-count fanout has no overall bound.
   */
  overallTimeoutMs?: number;
  /** Cancels the whole probe, including any in-flight session (#236). */
  signal?: AbortSignal;
}): Promise<ClaudeCatalogProbe> {
  const cli = options.cliPath?.trim() || "claude-agent-acp";
  // Runtime spawn inherits the Seam process cwd; discovery must too.
  const cwd = options.cwd ?? process.cwd();
  const baseEnv = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 45_000;
  // ONE deadline for the whole catalog, not one per process. A per-session
  // timeout that restarts for every model means N models x C waves has no
  // bound at all, so a slow wrapper could stall a refresh indefinitely while
  // each individual session stayed "within budget".
  const deadlineMs = options.overallTimeoutMs ?? Math.max(timeoutMs, timeoutMs * 4);
  const started = Date.now();
  /**
   * Budget for ONE session: the per-session bound, further clamped by whatever
   * remains of the catalog budget. Using the remaining catalog budget alone
   * would silently widen a caller's explicit per-session timeout.
   */
  const sessionBudget = (): number =>
    Math.max(1, Math.min(timeoutMs, deadlineMs - (Date.now() - started)));
  // Shared cancellation: the caller's signal, the catalog deadline, and the
  // first worker failure all abort every sibling session through one channel.
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const deadlineTimer = setTimeout(() => controller.abort(), deadlineMs);
  deadlineTimer.unref?.();

  try {
  const base = await withProbeSession({
    cli, env: baseEnv, cwd, timeoutMs: sessionBudget(),
    signal: controller.signal,
    read: async (session) => {
      const modelOption = selectOption(session.options, "model");
      if (!modelOption) throw new Error("claude-agent-acp advertised no model config option");
      const advertised = flattenSelectOptions(modelOption.options);
      if (!advertised.length) throw new Error("claude-agent-acp advertised an empty model list");
      const wrapperCurrentValue =
        typeof modelOption.currentValue === "string" ? modelOption.currentValue : null;
      const onSelf = advertised.find((entry) => entry.value === wrapperCurrentValue);
      return {
        advertised,
        wrapperCurrentValue,
        reusable: onSelf ? readProbedModel(onSelf, session.options) : null,
      };
    },
  });

  const results = new Map<string, ClaudeProbedModel>();
  if (base.reusable) results.set(base.reusable.advertisedId, base.reusable);
  const pending = base.advertised.filter((entry) => !results.has(entry.value));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, pending.length || 1));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      if (controller.signal.aborted) return;
      const entry = pending[cursor++]!;
      // Canonical identity, because that is what a catalog selection spawns
      // with — the raw advertised value never reaches a real turn.
      const canonical = canonicalClaudeModelId(entry.value);
      const env = options.modelEnv ? options.modelEnv(canonical) : baseEnv;
      const probed = await withProbeSession({
        cli, env, cwd, timeoutMs: sessionBudget(),
        signal: controller.signal,
        read: async (session) => {
          // Select the value the PUBLISHED RUNTIME BINDING uses — the canonical
          // id — not the raw advertisement. `runtimeId`/`rawModel` are
          // canonical, so a catalog-backed turn calls `setModel(canonical)`;
          // measuring effort and defaults after selecting the suffixed
          // advertisement instead would describe a selection runtime never
          // makes. `ANTHROPIC_MODEL` forwarding has already registered the
          // canonical id, so it is selectable here exactly as at runtime.
          //
          // An ALIAS (`default`, `opus[1m]`, `haiku`) canonicalizes to itself
          // and is NOT selected by the environment, so a fresh session comes up
          // on whatever the wrapper prefers — measured: `sonnet`. Reading that
          // session as if it were the alias publishes one model's capabilities
          // under another's name, so it is selected explicitly, ONCE, in a
          // session that has selected nothing else.
          const current = selectOption(session.options, "model")?.currentValue;
          const observed = current === canonical ? session.options : await session.select(canonical);
          return readProbedModel(entry, observed);
        },
      });
      results.set(entry.value, probed);
    }
  };
  // Cancellation and draining are two separate obligations, in this order.
  //
  // 1. The FIRST failure aborts its siblings AT THE MOMENT IT HAPPENS. Raising
  //    the abort after `allSettled` had already returned could not reach a
  //    sibling that was still running: a wrapper that never answers
  //    `initialize` sat for its entire session budget before the catalog gave
  //    up on a collection that was already doomed.
  // 2. Only then is every worker awaited — allSettled, not all — so no session
  //    or child outlives this call, and the first genuine failure (not a
  //    sibling's derived cancellation) is what the caller sees — `failures` is
  //    chronological, so `failures[0]` is the one that raised the abort.
  const failures: unknown[] = [];
  const cancelOnFailure = async (): Promise<void> => {
    try {
      await worker();
    } catch (error) {
      failures.push(error);
      controller.abort();
      throw error;
    }
  };
  await Promise.allSettled(Array.from({ length: concurrency }, cancelOnFailure));
  if (failures.length > 0) throw failures[0];
  if (controller.signal.aborted) {
    throw new Error(`claude-agent-acp catalog probe exceeded its ${deadlineMs}ms catalog deadline`);
  }

  // Advertised order is the wrapper's own preference order; keep it stable so a
  // refresh that changes nothing produces an identical checksum.
  return {
    models: base.advertised.map((entry) => results.get(entry.value)!).filter(Boolean),
    wrapperCurrentValue: base.wrapperCurrentValue,
  };
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", onOuterAbort);
    controller.abort();
  }
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
  /** Operator-configured labels, keyed by model id. Display text only. */
  displayNames?: ReadonlyMap<string, string>;
  /**
   * Effort mechanism Seam actually applies for this profile. Claude applies
   * effort through `_meta.claudeCode.options.effort` ("meta"), so the live
   * `effort` config option is read as CAPABILITY, not as the application path.
   */
  effortMechanism: CatalogEffortMechanism;
  effortConfigId?: string;
  /**
   * The credential scope this refresh is running under. An overlay entry is
   * published ONLY when it was verified on this same scope — see
   * {@link overlayForCredentialScope}.
   */
  credentialScope: string;
  /** Non-secret scope fingerprint recorded on emitted evidence. */
  scopeRef?: string;
}

/**
 * Merge the live base with the verified overlay, deterministically, by
 * canonical identity. Live wins; an overlay entry is published only when its
 * canonical model is absent from the live list. Ordering is live-advertised
 * order followed by overlay declaration order, so an unchanged wrapper and an
 * unchanged overlay always checksum identically.
 */
export function mergeClaudeCatalogModels(input: ClaudeCatalogMergeInput): ManifestCatalogModel[] {
  // FAIL CLOSED on credential scope. Every overlay entry records the scope its
  // evidence was captured on; an entry verified on one credential set says
  // nothing about another, so it is simply not published there. An alternate
  // credential profile therefore publishes only what its OWN live probe
  // advertised — an independently scoped snapshot, not a borrowed one.
  const overlay = overlayForCredentialScope(input.overlay, input.credentialScope);
  const overlayById = new Map(overlay.map((entry) => [entry.modelId, entry]));
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
    // SCOPE-TRUTHFUL context. The window may come ONLY from a verification
    // captured on the ACTIVE credential scope — i.e. from the already
    // scope-filtered overlay. Reading a global table here handed an alternate
    // credential profile the default account's 1M window and then published it
    // inside a `live-observation`, as though ACP had reported it. ACP reports
    // no window at discovery, so absent matching-scope verification this is
    // null and the row is honestly unresolved.
    const window = verified?.contextWindow ?? null;
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
      description: input.displayNames?.get(id) ? undefined : probed.advertisedName,
      // Structured, shared evidence (#236) rather than a private prose string:
      // this is what flows through config inspection, the status card, the
      // audit trail and the metadata join.
      evidence: liveEvidence({
        probed, canonicalId: id, effortChoices, selectionDefault,
        verified, selfResolved, scopeRef: input.scopeRef,
      }),
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

  for (const entry of overlay) {
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
      evidence: [overlayEvidence(entry, input.scopeRef)],
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
  // A DECLARED alias resolves it too, collision-safely — the same rule the
  // shared manifest helper applies.
  const byAlias = models.filter((model) => (model.aliases ?? []).includes(configured));
  if (byAlias.length > 1) {
    throw new Error(
      `configured Claude default ${JSON.stringify(configured)} is ambiguous: declared as an alias by ` +
        `${byAlias.map((model) => model.modelId).join(", ")}`
    );
  }
  if (byAlias.length === 1) return byAlias[0]!.modelId;
  // NO list-order fallback, and no substituting some other alias. Minting a
  // default from position meant a thread would silently start on whichever
  // model the wrapper happened to advertise first. An unresolved configured
  // default fails candidate construction, so the service retains the previous
  // generation instead.
  throw new Error(
    `configured Claude default ${JSON.stringify(configured)} is not published by this catalog ` +
      `(have: ${models.map((model) => model.modelId).join(", ") || "none"})`
  );
}

/**
 * The subset of the verified overlay that is TRUE for a given credential scope.
 *
 * Each entry records the credential scope its JSONL verification was captured
 * on. Publishing an entry outside that scope would assert, about a different
 * credential set, something nobody measured there — the previous behavior,
 * where every direct profile merged the same globally-scoped overlay and the
 * mismatch survived only as prose in the provenance string.
 *
 * There is deliberately no "close enough" rule: an entry either matches the
 * active scope or it is absent, and an absent model is simply not selectable.
 * Re-verifying on another credential set is the documented maintenance
 * operation (model-management runbook §13.4), not something a refresh can infer.
 */
export function overlayForCredentialScope(
  overlay: ReadonlyArray<ClaudeVerifiedOverlayEntry>,
  credentialScope: string
): ClaudeVerifiedOverlayEntry[] {
  return overlay.filter((entry) => entry.credentialScope === credentialScope);
}

/**
 * The credential-scope identity a profile probes under.
 *
 * `default` is the ambient `~/.claude` credential set. Any explicit config
 * directory is a DIFFERENT credential set; it deliberately gets an opaque,
 * non-path label so a scope identity never carries a filesystem path into
 * evidence, and so no configured directory can accidentally collide with the
 * `default` scope the overlay was verified on.
 */
export function claudeCredentialScope(configDir?: string): string {
  return configDir?.trim() ? "configured" : "default";
}


/** Records for a row the wrapper advertised in this refresh. */
function liveEvidence(input: {
  probed: ClaudeProbedModel;
  canonicalId: string;
  effortChoices: string[];
  selectionDefault: string;
  verified: ClaudeVerifiedOverlayEntry | undefined;
  selfResolved: boolean;
  scopeRef?: string;
}): CatalogModelEvidence[] {
  // Deliberately NO per-record `observedAt`. A wall-clock stamp would differ on
  // every refresh, so an otherwise identical catalog would change its content
  // checksum and publish a new generation each time. The candidate-level
  // `fetchedAt` already records when this observation was taken.
  const live: CatalogModelEvidence = {
    kind: "live-observation",
    source: "claude-agent-acp session config",
    // No `context` here, ever. A live ACP session does not report a context
    // window at discovery, so attaching one would attribute a verified-record
    // fact to a live observation. The window travels on the verified record
    // that actually established it.
    ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
    // Only a GENUINE resolution is recorded. The wrapper echoing an alias back
    // at us (`default` -> `default`) is not one, so nothing is manufactured.
    ...(input.selfResolved && input.probed.resolvedValue
      ? { resolvedModel: input.probed.resolvedValue }
      : {}),
    effort: {
      choices: input.effortChoices,
      selectionDefault: input.selectionDefault,
      method: "provider-advertised",
    },
  };
  // The verified record travels with EVERY row the overlay contributed to,
  // including one whose identity the wrapper resolved for itself. The merged
  // row's window comes only from that verification — ACP reports no window at
  // discovery — so dropping the record on self-resolution left a 1M context
  // standing on a live-observation that never established it. Self-resolution
  // decides only what the LIVE record may claim (`resolvedModel` above), never
  // whether the verification that supplied the window stays visible.
  return input.verified ? [live, overlayEvidence(input.verified, input.scopeRef)] : [live];
}

/** The record carried forward from an out-of-band JSONL verification. */
function overlayEvidence(
  entry: ClaudeVerifiedOverlayEntry,
  scopeRef?: string
): CatalogModelEvidence {
  return {
    kind: "verified-record",
    source: "operator JSONL verification",
    observedAt: `${entry.verifiedOn}T00:00:00.000Z`,
    runtimeVersion: entry.wrapperVersion,
    ...(scopeRef ? { scopeRef } : {}),
    resolvedModel: entry.resolvedModel,
    context: { native: entry.contextWindow, method: "runbook-verified" },
    effort: {
      choices: [...entry.effortChoices],
      selectionDefault: entry.effortChoices[0] ?? "default",
      method: "runbook-verified",
    },
    note: `verified on credential scope ${entry.credentialScope}`,
  };
}
