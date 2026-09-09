import { spawn } from "node:child_process";
import fs, { promises as fsp } from "node:fs";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import Database from "better-sqlite3";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type McpServer,
  type SessionConfigOption,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOption,
  type SessionConfigSelectOptions,
} from "@agentclientprotocol/sdk";
import { asLocalAdapter, type AgentIdentity, type AgentProfile } from "../agent-profile.js";
import { AGENT_ADAPTER_VERSION } from "../agent-profile.js";
import { manifestCatalogScope, manifestCatalogSource, readCliVersion } from "../model-catalog.js";
import type { SessionSummary, SessionSummaryLine } from "../session-manager.js";

interface SeamAcpSessionIdRow {
  acp_session_id?: string | null;
}

interface CopilotSessionRow {
  id?: string;
  cwd?: string | null;
  created_at?: string;
  updated_at?: string;
  repository?: string | null;
  host_type?: string | null;
  branch?: string | null;
  summary?: string | null;
}

interface CopilotTurnRow {
  turn_index?: number;
  user_message?: string | null;
  assistant_response?: string | null;
  timestamp?: string | number | null;
}

export interface CopilotCatalogProbeModel {
  modelId: string;
  displayName: string;
  effortChoices: string[];
  effortDefault: string;
  priceCategory: string | null;
}

export interface CopilotCatalogProbe {
  defaultModel: string;
  models: CopilotCatalogProbeModel[];
}

export interface CopilotCatalogLaunch {
  cliPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

type CopilotAcpChild = ReturnType<typeof spawn>;
interface CopilotAcpLaunchSpec {
  executable: string;
  args: string[];
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  };
}

type CopilotAcpSpawn = (
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  }
) => CopilotAcpChild;

interface CopilotAcpProbeSession {
  connection: ClientSideConnection;
  sessionId: string;
  configOptions: SessionConfigOption[];
}

const COPILOT_MODEL_PROBE_ATTEMPTS = 3;
const COPILOT_ACP_BASE_ARGS = ["--acp"] as const;

function copilotAcpLaunchSpec(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): CopilotAcpLaunchSpec {
  return {
    executable,
    args: [...args],
    options: { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
  };
}

function flattenSelectOptions(options: SessionConfigSelectOptions): SessionConfigSelectOption[] {
  return (options as Array<SessionConfigSelectOption | SessionConfigSelectGroup>).flatMap((option) =>
    "options" in option ? option.options : [option]
  );
}

function catalogConfigOptions(value: unknown): SessionConfigOption[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is SessionConfigOption =>
        Boolean(entry && typeof entry === "object" && "id" in entry))
    : [];
}

function selectOption(options: SessionConfigOption[], id: string): Extract<SessionConfigOption, { type: "select" }> | undefined {
  const option = options.find((entry) => entry.id === id);
  return option?.type === "select" ? option : undefined;
}

function copilotPriceCategory(option: SessionConfigSelectOption): string | null {
  const meta = (option as SessionConfigSelectOption & { _meta?: Record<string, unknown> })._meta;
  return typeof meta?.copilotPriceCategory === "string" ? meta.copilotPriceCategory : null;
}

function abortReason(signal: AbortSignal, fallback: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(fallback);
}

function boundedProbe<T>(
  work: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
  signal: AbortSignal
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal, timeoutMessage));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const succeed = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => fail(abortReason(signal, timeoutMessage));
    timer = setTimeout(() => fail(new Error(timeoutMessage)), Math.max(1, timeoutMs));
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(succeed, fail);
  });
}

async function settleWithin(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  await Promise.race([
    work.then(
      () => { settled = true; },
      () => { settled = true; }
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(1, timeoutMs));
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return settled;
}

async function waitForProbeRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal, "copilot ACP catalog probe aborted");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(abortReason(signal, "copilot ACP catalog probe aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runCopilotAcpProbeSession<T>(opts: {
  cliPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  cleanupTimeoutMs: number;
  signal: AbortSignal;
  spawnProcess: CopilotAcpSpawn;
  inspect: (
    session: CopilotAcpProbeSession,
    run: <R>(work: Promise<R>, message: string) => Promise<R>
  ) => Promise<T>;
}): Promise<T> {
  const launch = copilotAcpLaunchSpec(opts.cliPath, opts.args, opts.cwd, opts.env);
  const child = opts.spawnProcess(launch.executable, launch.args, launch.options);
  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderrStream = child.stderr;
  if (!stdin || !stdout || !stderrStream) {
    child.kill("SIGKILL");
    throw new Error("copilot ACP probe did not expose stdio pipes");
  }
  let stderr = "";
  stderrStream.setEncoding("utf8");
  const onStderrData = (chunk: string) => { stderr = (stderr + chunk).slice(-4000); };
  stderrStream.on("data", onStderrData);
  let exited = false;
  let intentionalStop = false;
  let resolveExit!: () => void;
  let rejectDied!: (error: Error) => void;
  const exitedPromise = new Promise<void>((resolve) => { resolveExit = resolve; });
  const died = new Promise<never>((_resolve, reject) => { rejectDied = reject; });
  const onChildError = (error: Error) => {
    exited = true;
    resolveExit();
    rejectDied(error);
  };
  const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exited = true;
    resolveExit();
    if (!intentionalStop) {
      rejectDied(new Error(
        `copilot ACP exited early (code=${code}, signal=${signal}): ${stderr.trim()}`
      ));
    }
  };
  child.once("error", onChildError);
  child.once("exit", onChildExit);
  const connection = new ClientSideConnection(
    () => ({
      async requestPermission(request) {
        const option = request.options.find((entry) => entry.kind?.startsWith("allow_"));
        return option
          ? { outcome: { outcome: "selected" as const, optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" as const } };
      },
      async sessionUpdate() {},
    } satisfies Client),
    ndJsonStream(
      Writable.toWeb(stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(stdout) as unknown as ReadableStream<Uint8Array>
    )
  );
  const deadline = Date.now() + opts.timeoutMs;
  const run = <R>(work: Promise<R>, message: string): Promise<R> => boundedProbe(
    Promise.race([work, died]),
    deadline - Date.now(),
    message,
    opts.signal
  );
  let sessionId: string | undefined;
  try {
    await run(
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      }),
      "copilot ACP initialize timed out"
    );
    const session = await run(
      connection.newSession({ cwd: opts.cwd, mcpServers: [] }),
      "copilot ACP session/new timed out"
    );
    sessionId = session.sessionId;
    return await opts.inspect({
      connection,
      sessionId,
      configOptions: catalogConfigOptions(session.configOptions),
    }, run);
  } finally {
    intentionalStop = true;
    if (sessionId && !exited) {
      await settleWithin(connection.closeSession({ sessionId }), opts.cleanupTimeoutMs);
    }
    if (!exited) {
      child.kill("SIGTERM");
      await settleWithin(exitedPromise, opts.cleanupTimeoutMs);
    }
    if (!exited) {
      child.kill("SIGKILL");
      await settleWithin(exitedPromise, opts.cleanupTimeoutMs);
    }
    if (!exited) throw new Error("copilot ACP probe process did not exit after SIGKILL");
    stdin.destroy();
    stdout.destroy();
    stderrStream.destroy();
    const connectionClosed = await settleWithin(connection.closed, opts.cleanupTimeoutMs);
    stderrStream.removeListener("data", onStderrData);
    child.removeListener("error", onChildError);
    child.removeListener("exit", onChildExit);
    if (!connectionClosed || !connection.signal.aborted) {
      throw new Error("copilot ACP probe connection did not close");
    }
  }
}

/** Adapter-owned ACP collector with one fresh process/session per model. */
export async function probeCopilotCatalog(options: {
  cliPath?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  overallTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  /** Test seam proving probe scheduling order cannot affect normalized output. */
  probeOrder?: "forward" | "reverse";
  /** Test seam; production always uses node:child_process spawn. */
  spawnProcess?: CopilotAcpSpawn;
} = {}): Promise<CopilotCatalogProbe> {
  const cliPath = options.cliPath ?? "copilot";
  const args = options.args ? [...options.args] : [...COPILOT_ACP_BASE_ARGS];
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 1_000;
  const controller = new AbortController();
  const overallTimeoutMs = options.overallTimeoutMs ?? 180_000;
  const overallTimer = setTimeout(() => {
    controller.abort(new Error(`copilot ACP catalog probe timed out after ${overallTimeoutMs}ms`));
  }, Math.max(1, overallTimeoutMs));
  overallTimer.unref?.();
  const spawnProcess: CopilotAcpSpawn = options.spawnProcess ?? ((executable, args, spawnOpts) =>
    spawn(executable, args, spawnOpts));
  try {
    const discovery = await runCopilotAcpProbeSession({
      cliPath, args, cwd, env, timeoutMs, cleanupTimeoutMs,
      signal: controller.signal,
      spawnProcess,
      inspect: async (session) => {
        const modelSelect = selectOption(session.configOptions, "model");
        const models = modelSelect ? flattenSelectOptions(modelSelect.options) : [];
        return { defaultModel: modelSelect?.currentValue ?? "", models };
      },
    });
    const models = discovery.models;
    if (!models.length) throw new Error("copilot ACP advertised no model config options");
    if (new Set(models.map((model) => model.value)).size !== models.length) {
      throw new Error("copilot ACP advertised duplicate model config options");
    }
    if (!models.some((model) => model.value === discovery.defaultModel)) {
      throw new Error(
        `copilot ACP default model ${JSON.stringify(discovery.defaultModel)} is not in its model list`
      );
    }
    const indices = models.map((_model, index) => index);
    if (options.probeOrder === "reverse") indices.reverse();
    const rows: Array<CopilotCatalogProbeModel | undefined> = new Array(models.length);
    // Copilot's configured credential scope contains mutable selection state
    // shared even by separate CLI processes. Keep exactly one model probe in
    // flight while giving every attempt its own fresh process and ACP session.
    // Two bounded fresh retries cover the CLI's occasional failure to
    // acknowledge an advertised model immediately after session creation.
    for (const index of indices) {
      const model = models[index]!;
      let lastError: unknown;
      for (let attempt = 1; attempt <= COPILOT_MODEL_PROBE_ATTEMPTS; attempt += 1) {
        try {
          rows[index] = await runCopilotAcpProbeSession({
            cliPath, args, cwd, env, timeoutMs, cleanupTimeoutMs,
            signal: controller.signal,
            spawnProcess,
            inspect: async (session, run) => {
              let responseOptions = session.configOptions;
              const initialModel = selectOption(responseOptions, "model");
              if (initialModel?.currentValue !== model.value) {
                const response = await run(
                  session.connection.setSessionConfigOption({
                    sessionId: session.sessionId,
                    configId: "model",
                    value: model.value,
                  }),
                  `copilot ACP model probe timed out for ${model.value}`
                );
                responseOptions = catalogConfigOptions(response.configOptions);
              }
              const selectedModel = selectOption(responseOptions, "model");
              if (selectedModel?.currentValue !== model.value) {
                throw new Error(
                  `copilot ACP model probe did not select ${JSON.stringify(model.value)} ` +
                  `(returned ${JSON.stringify(selectedModel?.currentValue ?? null)})`
                );
              }
              const effort = selectOption(responseOptions, "reasoning_effort");
              const effortChoices = effort
                ? flattenSelectOptions(effort.options).map((entry) => entry.value)
                : [];
              if (effort && !effortChoices.length) {
                throw new Error(`copilot ACP advertised an empty effort list for ${model.value}`);
              }
              return {
                modelId: model.value,
                displayName: model.name,
                effortChoices,
                effortDefault: effort?.currentValue && effortChoices.includes(effort.currentValue)
                  ? effort.currentValue
                  : "default",
                priceCategory: copilotPriceCategory(model),
              };
            },
          });
          break;
        } catch (error) {
          lastError = error;
          if (controller.signal.aborted) break;
          if (attempt < COPILOT_MODEL_PROBE_ATTEMPTS) {
            await waitForProbeRetry(attempt * 1_000, controller.signal);
          }
        }
      }
      if (!rows[index]) {
        const detail = lastError instanceof Error ? lastError.message : String(lastError);
        throw new Error(`copilot ACP model probe failed for ${model.value}: ${detail}`, {
          cause: lastError,
        });
      }
    }
    if (controller.signal.aborted) {
      throw abortReason(controller.signal, "copilot ACP catalog probe aborted");
    }
    if (rows.some((row) => !row)) {
      throw new Error("copilot ACP catalog probe ended with partial model results");
    }
    return {
      defaultModel: discovery.defaultModel,
      models: rows as CopilotCatalogProbeModel[],
    };
  } finally {
    clearTimeout(overallTimer);
  }
}

/**
 * GitHub Copilot CLI as an ACP server (`copilot --acp`).
 *
 * Start the ACP server with `--allow-all` so the bot can run end-to-end
 * without needing a permission UI. (The agent will still call
 * `session/request_permission`; we auto-approve those — see AgentRuntime.)
 *
 * Copilot ignores the `mcpServers` field on ACP `session/new` and only
 * loads MCP servers from `~/.copilot/mcp-config.json` plus anything
 * passed via `--additional-mcp-config`. So we translate our global
 * McpServer[] into Copilot's expected JSON shape and inject it at spawn.
 *
 * Multi-account: pass a custom `configDir` (and a unique `id` /
 * `displayName`) to register a second Copilot profile pointed at a
 * different `--config-dir`. Each config dir holds its own auth state,
 * MCP config, and session history, so the two profiles act as fully
 * isolated CLIs sharing one binary.
 */
export function makeCopilotProfile(opts: {
  /** Profile id. Defaults to "copilot". Must be unique across registered profiles. */
  id?: string;
  /** Display name shown in pickers / status. Defaults to "GitHub Copilot". */
  displayName?: string;
  cliPath?: string;
  /** Exact ACP argv prefix used by this configured Copilot runtime. */
  acpArgs?: string[];
  /** Spawn cwd shared by runtime sessions and catalog probes. */
  cwd?: string;
  /** Base environment shared by runtime sessions and catalog probes. */
  environment?: NodeJS.ProcessEnv;
  defaultModel: string;
  mcpServers?: McpServer[];
  /**
   * Override Copilot's config directory (auth, MCP config, session state).
   * When set, spawn args include `--config-dir <dir>` and `whoami()` reads
   * `<dir>/config.json`. When omitted, the CLI uses its default (~/.copilot).
   */
  configDir?: string;
  staticModels?: ReadonlyArray<{ modelId: string; name: string }>;
  /** Test/embedding seam; production probes the profile's ACP process. */
  catalogProbe?: (launch: CopilotCatalogLaunch) => Promise<CopilotCatalogProbe>;
}): AgentProfile {
  const cli = opts.cliPath?.trim() || "copilot";
  const acpArgs = opts.acpArgs ? [...opts.acpArgs] : [...COPILOT_ACP_BASE_ARGS];
  const globalMcpServers = opts.mcpServers ?? [];
  const configDir = opts.configDir?.trim() || undefined;
  const runtimeCwd = opts.cwd ?? process.cwd();

  let identityCache: AgentIdentity | null | undefined;

  const probeEnvironment = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...(opts.environment ?? process.env) };
    if (configDir) {
      const token = readCopilotTokenSync(configDir);
      if (token) env.COPILOT_GITHUB_TOKEN = token;
    }
    return env;
  };

  return asLocalAdapter({
    id: opts.id ?? "copilot",
    displayName: opts.displayName ?? "GitHub Copilot",
    defaultModel: opts.defaultModel,
    catalog: {
      scope: () => manifestCatalogScope({
        provider: "github-copilot",
        credentialProfile: configDir ?? "default",
      }),
      async fetch() {
        const catalogLaunch: CopilotCatalogLaunch = {
          cliPath: cli,
          args: [...acpArgs],
          cwd: runtimeCwd,
          env: probeEnvironment(),
        };
        const probe = opts.catalogProbe
          ? await opts.catalogProbe(catalogLaunch)
          : await probeCopilotCatalog(catalogLaunch);
        const candidate = await manifestCatalogSource({
          provider: "github-copilot",
          credentialProfile: configDir ?? "default",
          defaultModel: probe.defaultModel || opts.defaultModel,
          models: () => probe.models.map((model) => ({
            modelId: model.modelId,
            name: model.displayName,
            pricingCategory: model.priceCategory,
            effort: {
              mechanism: model.effortChoices.length ? "configOption" : "none",
              ...(model.effortChoices.length ? { configId: "reasoning_effort" } : {}),
              choices: model.effortChoices.length ? model.effortChoices : ["default"],
              selectionDefault: model.effortDefault,
            },
          })),
          adapterVersion: AGENT_ADAPTER_VERSION,
          applicationMode: "live",
          source: "copilot-acp-config-options",
        }).fetch();
        candidate.cliVersion = await readCliVersion(cli);
        candidate.sourceVersion = `acp/${PROTOCOL_VERSION}`;
        return candidate;
      },
    },
    configDir,
    mcpServersAtSpawn: true,
    // Copilot exposes reasoning effort as an ACP config option (verified via
    // `copilot --acp` v1.0.80: configOptions[id=reasoning_effort],
    // low|medium|high|xhigh|max, default medium).
    // Applied post-session-create via setSessionConfigOption (AgentRuntime).
    effort: {
      mechanism: "configOption",
      configId: "reasoning_effort",
      levels: ["low", "medium", "high", "xhigh", "max"],
    },
    spawn(_modelOverride?: string, _effortOverride?: string, sessionMcpServers?: McpServer[]) {
      const launch = copilotAcpLaunchSpec(cli, acpArgs, runtimeCwd, probeEnvironment());
      const args = launch.args;
      // Copilot ignores ACP session/new + session/load `mcpServers`. Supply the
      // runtime-specific seam-MCP URL/token when the ACP *process* starts so a
      // resumed session after redeploy retains its coordination tools.
      const additionalMcpJson = buildCopilotMcpConfigJson(
        mergeCopilotMcpServers(globalMcpServers, sessionMcpServers ?? [])
      );
      if (additionalMcpJson) {
        args.push("--additional-mcp-config", additionalMcpJson);
      }
      // --config-dir is not a supported CLI flag. The same credential-scoped
      // environment is used by runtime spawn and catalog collection.
      return spawn(launch.executable, args, {
        ...launch.options,
        detached: true,
      });
    },
    async whoami() {
      if (identityCache !== undefined) return identityCache;
      identityCache = await readCopilotIdentity(configDir);
      return identityCache;
    },
    sessionManager: {
      async listSessions(cwd: string): Promise<SessionSummary[]> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".copilot");
        const dbPath = path.join(dir, "session-store.db");
        try {
          await fsp.access(dbPath);
          const db = new Database(dbPath);
          try {
            // Query seam.db as a source of truth for session IDs associated with this repo path.
            const seamDbSessions = new Set<string>();
            try {
              const dataDir = process.env.DATA_DIR ?? "./data";
              const seamDbPath = path.resolve(dataDir, "seam.db");
              const seamDb = new Database(seamDbPath);
              try {
                // Find all sessions in seam.db that have this repo path
                const rows = seamDb.prepare("SELECT acp_session_id FROM sessions WHERE repo_path = ?").all(cwd) as SeamAcpSessionIdRow[];
                for (const row of rows) {
                  if (row.acp_session_id) {
                    seamDbSessions.add(row.acp_session_id);
                  }
                }
              } finally {
                seamDb.close();
              }
            } catch (err) {
              // ignore seamDb query failures
            }

            // Fetch all sessions from the copilot DB.
            const allSessions = db.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all() as CopilotSessionRow[];
            const sessions: CopilotSessionRow[] = [];
            for (const s of allSessions) {
              const matchesCwd = s.cwd === cwd;
              const matchesSeamDb = s.id && seamDbSessions.has(s.id);

              if (matchesCwd || (matchesSeamDb && !s.cwd)) {
                sessions.push(s);
              }
            }

            const summaries: SessionSummary[] = [];

            for (const sess of sessions) {
              const sessionId = sess.id;
              if (!sessionId) continue;
              const createdAt = sess.created_at ? Date.parse(sess.created_at) : Date.now();
              const lastActivityAt = sess.updated_at ? Date.parse(sess.updated_at) : Date.now();

              const turns = db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index ASC").all(sessionId) as CopilotTurnRow[];
              
              const allMessages: Array<{ sender: "human" | "agent"; text: string }> = [];
              for (const turn of turns) {
                if (turn.user_message) {
                  allMessages.push({ sender: "human", text: turn.user_message });
                }
                if (turn.assistant_response) {
                  allMessages.push({ sender: "agent", text: turn.assistant_response });
                }
              }

              const transcriptLines: string[] = [];
              for (const turn of turns) {
                if (turn.user_message?.trim()) {
                  transcriptLines.push(`### User\n${turn.user_message.trim()}`);
                }
                if (turn.assistant_response?.trim()) {
                  transcriptLines.push(`### Assistant\n${turn.assistant_response.trim()}`);
                }
              }
              const estimatedTokens = Math.ceil(transcriptLines.join("\n\n").length / 4);

              let previewLines: SessionSummaryLine[] = [];
              if (allMessages.length <= 16) {
                previewLines = allMessages;
              } else {
                const firstSix = allMessages.slice(0, 6);
                const lastTen = allMessages.slice(-10);
                previewLines = [...firstSix, ...lastTen];
              }

              summaries.push({
                sessionId,
                createdAt,
                lastActivityAt,
                previewLines,
                estimatedTokens,
              });
            }
            return summaries;
          } finally {
            db.close();
          }
        } catch {
          return [];
        }
      },

      async cloneSession(cwd: string, oldSessionId: string, newSessionId: string): Promise<void> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".copilot");
        const dbPath = path.join(dir, "session-store.db");
        const sessionStateDir = path.join(dir, "session-state");

        const db = new Database(dbPath);
        try {
          const sessionRow = db.prepare("SELECT * FROM sessions WHERE id = ?").get(oldSessionId) as CopilotSessionRow | undefined;
          if (sessionRow) {
            const nowIso = new Date().toISOString();
            db.prepare(`
              INSERT INTO sessions (id, cwd, repository, host_type, branch, summary, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              newSessionId,
              cwd,
              sessionRow.repository,
              sessionRow.host_type,
              sessionRow.branch,
              sessionRow.summary,
              nowIso,
              nowIso
            );
          }

          const turns = db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index ASC").all(oldSessionId) as CopilotTurnRow[];
          const insertTurn = db.prepare(`
            INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
            VALUES (?, ?, ?, ?, ?)
          `);
          for (const turn of turns) {
            insertTurn.run(
              newSessionId,
              turn.turn_index,
              turn.user_message,
              turn.assistant_response,
              turn.timestamp
            );
          }

          const oldSubDir = path.join(sessionStateDir, oldSessionId);
          const newSubDir = path.join(sessionStateDir, newSessionId);
          try {
            const stat = await fsp.stat(oldSubDir);
            if (stat.isDirectory()) {
              await fsp.mkdir(newSubDir, { recursive: true });
              await fsp.cp(oldSubDir, newSubDir, { recursive: true });
            }
          } catch {
            // ignore
          }
        } finally {
          db.close();
        }
      },

      async deleteSession(cwd: string, sessionId: string): Promise<void> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".copilot");
        const dbPath = path.join(dir, "session-store.db");
        const sessionStateDir = path.join(dir, "session-state");

        const db = new Database(dbPath);
        try {
          db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
          db.prepare("DELETE FROM turns WHERE session_id = ?").run(sessionId);
          try {
            db.prepare("DELETE FROM search_index_content WHERE c1 = ?").run(sessionId);
          } catch {
            // ignore
          }
        } finally {
          db.close();
        }

        const subDir = path.join(sessionStateDir, sessionId);
        try {
          await fsp.rm(subDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      },

      async getTranscript(cwd: string, sessionId: string): Promise<string> {
        const dir = configDir ?? path.join(process.env.HOME ?? "", ".copilot");
        const dbPath = path.join(dir, "session-store.db");
        const db = new Database(dbPath);
        try {
          const turns = db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY turn_index ASC").all(sessionId) as CopilotTurnRow[];
          const transcriptLines: string[] = [];
          for (const turn of turns) {
            if (turn.user_message?.trim()) {
              transcriptLines.push(`### User\n${turn.user_message.trim()}`);
            }
            if (turn.assistant_response?.trim()) {
              transcriptLines.push(`### Assistant\n${turn.assistant_response.trim()}`);
            }
          }
          return transcriptLines.join("\n\n");
        } finally {
          db.close();
        }
      }
    },
  });
}

/**
 * Synchronously read the OAuth token for the last logged-in user from a
 * Copilot config.json. Used at spawn time to inject COPILOT_GITHUB_TOKEN.
 * Returns undefined on any failure.
 */
function readCopilotTokenSync(configDir: string): string | undefined {
  const file = path.join(configDir, "config.json");
  try {
    // Strip JS-style comments before parsing (Copilot uses JSONC)
    const raw = fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "");
    const parsed = JSON.parse(raw) as {
      lastLoggedInUser?: { host?: string; login?: string };
      copilotTokens?: Record<string, string>;
    };
    const u = parsed.lastLoggedInUser;
    if (!u?.host || !u?.login) return undefined;
    const key = `${u.host}:${u.login}`;
    return parsed.copilotTokens?.[key];
  } catch {
    return undefined;
  }
}

/**
 * Read GitHub login from Copilot's `config.json`. Returns null on any
 * failure (file missing, malformed JSON, no logged-in user).
 */
async function readCopilotIdentity(
  configDir: string | undefined
): Promise<AgentIdentity | null> {
  const dir = configDir ?? path.join(process.env.HOME ?? "", ".copilot");
  const file = path.join(dir, "config.json");
  try {
    const raw = await fsp.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as {
      lastLoggedInUser?: { login?: string; host?: string };
      loggedInUsers?: Array<{ login?: string; host?: string }>;
    };
    const u =
      parsed.lastLoggedInUser ??
      (parsed.loggedInUsers && parsed.loggedInUsers[0]) ??
      undefined;
    if (!u || !u.login) return null;
    return u.host ? { login: u.login, host: u.host } : { login: u.login };
  } catch {
    return null;
  }
}

export interface CopilotQuotaSnapshot {
  unlimited: boolean;
  entitlement: number;
  remaining: number;
  percentRemaining: number;
  overagePermitted: boolean;
  overageCount: number;
}

export interface CopilotUsageData {
  login: string | null;
  plan: string | null;
  org: string | null;
  quotaResetAt: string | null;
  chat: CopilotQuotaSnapshot | null;
  completions: CopilotQuotaSnapshot | null;
  premiumInteractions: CopilotQuotaSnapshot | null;
}

/**
 * Fetches Copilot plan and quota data from GitHub's internal user endpoint.
 * Uses the OAuth token stored in config.json. Returns what it can on failure.
 */
export async function fetchCopilotUsage(
  configDir?: string
): Promise<CopilotUsageData> {
  const dir = configDir?.trim() || path.join(process.env.HOME ?? "", ".copilot");
  const result: CopilotUsageData = {
    login: null,
    plan: null,
    org: null,
    quotaResetAt: null,
    chat: null,
    completions: null,
    premiumInteractions: null,
  };
  const identity = await readCopilotIdentity(configDir);
  if (identity?.login) result.login = identity.login;
  const token = readCopilotTokenSync(dir);
  if (!token) return result;
  try {
    const res = await fetch("https://api.github.com/copilot_internal/user", {
      headers: { Authorization: `token ${token}`, Accept: "application/json" },
    });
    if (res.ok) {
      const body = (await res.json()) as Record<string, unknown>;
      result.login = (body.login as string | undefined) ?? result.login;
      result.plan = (body.copilot_plan as string | undefined) ?? null;
      result.quotaResetAt = (body.quota_reset_date_utc as string | undefined) ?? null;
      const orgs = body.organization_list as Array<{ name?: string; login?: string }> | undefined;
      if (orgs && orgs.length > 0) result.org = orgs[0]?.name ?? orgs[0]?.login ?? null;
      const snaps = body.quota_snapshots as Record<string, unknown> | undefined;
      if (snaps) {
        result.chat = parseQuota(snaps.chat);
        result.completions = parseQuota(snaps.completions);
        result.premiumInteractions = parseQuota(snaps.premium_interactions);
      }
    }
  } catch {
    /* return what we have */
  }
  return result;
}

function parseQuota(raw: unknown): CopilotQuotaSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    unlimited: r.unlimited === true,
    entitlement: typeof r.entitlement === "number" ? r.entitlement : 0,
    remaining: typeof r.remaining === "number" ? r.remaining : 0,
    percentRemaining: typeof r.percent_remaining === "number" ? r.percent_remaining : 0,
    overagePermitted: r.overage_permitted === true,
    overageCount: typeof r.overage_count === "number" ? r.overage_count : 0,
  };
}

/**
 * Translate our generic ACP McpServer[] into Copilot's expected
 * `{mcpServers: {name: {...}}}` JSON. Returns undefined when the list
 * is empty so we don't pass an empty `--additional-mcp-config` flag.
 */
export function mergeCopilotMcpServers(
  globalServers: readonly McpServer[],
  sessionServers: readonly McpServer[]
): McpServer[] {
  const byName = new Map<string, McpServer>();
  for (const server of globalServers) byName.set(server.name, server);
  for (const server of sessionServers) byName.set(server.name, server);
  return [...byName.values()];
}

export function buildCopilotMcpConfigJson(servers: McpServer[]): string | undefined {
  if (servers.length === 0) return undefined;

  const map: Record<string, unknown> = {};
  for (const s of servers) {
    // The ACP McpServer union is discriminated by `type` (http/sse) or
    // is the bare stdio variant (no type). We pass through the same
    // shape Copilot's mcp-config.json uses.
    if ("type" in s && (s.type === "http" || s.type === "sse")) {
      const remote = s as McpServer & {
        name: string;
        headers?: Array<{ name: string; value: string }>;
      };
      const { name, headers, ...rest } = remote;
      const headerMap: Record<string, string> = {};
      for (const header of headers ?? []) headerMap[header.name] = header.value;
      map[name] = {
        ...rest,
        // Copilot CLI 1.0.80/1.0.81 can drop the namespace when replaying a
        // deferred MCP function_call, permanently wedging the resumed session
        // with a 400. Keep Seam's coordination tools eager; other MCP servers
        // retain Copilot's normal tool-search behavior.
        ...(name === "seam-mcp" ? { deferTools: "never" } : {}),
        ...(Object.keys(headerMap).length > 0 ? { headers: headerMap } : {}),
      };
    } else {
      // Stdio
      const stdio = s as McpServer & {
        name: string;
        command: string;
        args: string[];
        env?: Array<{ name: string; value: string }>;
      };
      const env: Record<string, string> = {};
      for (const v of stdio.env ?? []) env[v.name] = v.value;
      map[stdio.name] = {
        type: "stdio",
        command: stdio.command,
        args: stdio.args,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    }
  }
  return JSON.stringify({ mcpServers: map });
}
