import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type Client,
  type SessionConfigOption,
  type SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import { AGENT_ADAPTER_VERSION, asLocalAdapter, type AgentProfile } from "../agent-profile.js";
import { agyWait } from "../agy-lifecycle.js";
import { classifyAndAttach } from "../error-classification.js";
import { manifestCatalogSource, manifestCatalogScope } from "../model-catalog.js";
import { runBoundedProbe } from "../probe-process.js";
import { renderTranscriptMessages, type TranscriptMessage } from "../session-manager.js";
import { classifyAgyError } from "./agy.js";

export const AGY_ACP_ARGS = ["acp", "--process-per-session"] as const;
export const AGY_ACP_BACKEND = "agy-acp-stdio-v1";

interface AgyAcpLaunch {
  cliPath: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface AgyAcpCatalogModel {
  modelId: string;
  name: string;
  effortChoices: string[];
  effortDefault: string;
}

export interface AgyAcpCatalog {
  models: AgyAcpCatalogModel[];
  cliVersion?: string;
  image: boolean;
}

function select(options: SessionConfigOption[], id: string) {
  const option = options.find((entry) => entry.id === id);
  return option?.type === "select" ? option : undefined;
}

function choices(option: ReturnType<typeof select>): SessionConfigSelectOption[] {
  return option?.options.flatMap((entry) => "options" in entry ? entry.options : [entry]) ?? [];
}

/** Read text replay without exposing it as a live turn or a full session manager. */
export async function readAgyAcpTranscriptMessages(opts: AgyAcpLaunch & {
  sessionId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<readonly TranscriptMessage[]> {
  const turns: TranscriptMessage[] = [];
  let operationError: { error: unknown } | undefined;
  const cleanupErrors: unknown[] = [];
  try {
    await runBoundedProbe({
      executable: opts.cliPath, args: opts.args, cwd: opts.cwd, env: opts.env,
      signal: opts.signal, timeoutMs: opts.timeoutMs, processGroup: true,
      spawnOverride: () => spawn(opts.cliPath, [...opts.args], {
        cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true,
      }),
      label: "Antigravity native ACP transcript",
      run: async (handle) => {
        let replaying = false, loadAttempted = false, canClose = false;
        const connection = new ClientSideConnection(() => ({
          async sessionUpdate({ sessionId, update }) {
            if (!replaying || sessionId !== opts.sessionId ||
              (update.sessionUpdate !== "user_message_chunk" && update.sessionUpdate !== "agent_message_chunk") ||
              update.content.type !== "text") return;
            const role = update.sessionUpdate === "user_message_chunk" ? "User" : "Assistant";
            const previous = turns.at(-1);
            if (!previous || previous.role !== role || (update.messageId != null && previous.messageId !== update.messageId)) {
              turns.push({ role, messageId: update.messageId, text: update.content.text });
            } else previous.text += update.content.text;
          },
          async requestPermission() { return { outcome: { outcome: "cancelled" as const } }; },
        } satisfies Client), ndJsonStream(
          Writable.toWeb(handle.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(handle.stdout) as ReadableStream<Uint8Array>,
        ));
        // The shared collector drains close steps but does not report their errors.
        handle.onClose(async (signal) => {
          if (!loadAttempted || !canClose) return;
          try { await agyWait(connection.closeSession({ sessionId: opts.sessionId }), signal); }
          catch (error) { cleanupErrors.push(error); }
        }, "session");
        handle.onClose(async (signal) => {
          try { handle.stdin.end(); await agyWait(connection.closed, signal); }
          catch (error) { cleanupErrors.push(error); }
        }, "connection");
        try {
          const init = await agyWait(connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: "seam-acp", version: "0.1.0" }, clientCapabilities: {},
          }), handle.signal);
          canClose = init.agentCapabilities?.sessionCapabilities?.close != null;
          if (!init.agentCapabilities?.loadSession) throw RequestError.methodNotFound("session/load");
          replaying = true;
          loadAttempted = true;
          await agyWait(connection.loadSession({ sessionId: opts.sessionId, cwd: opts.cwd, mcpServers: [] }), handle.signal);
        } catch (error) {
          // Preserve the RPC error until after the collector has reaped its child.
          operationError = { error };
        } finally { replaying = false; }
      },
    });
  } catch (error) {
    // Lifecycle failures, including not_reaped, must not become a successful read.
    if (error instanceof Error && (operationError || cleanupErrors.length)) {
      error.cause = new AggregateError([
        ...(operationError ? [operationError.error] : []), ...cleanupErrors,
      ], "Transcript operation and cleanup outcomes");
    }
    classifyAndAttach(error, classifyAgyError(error, "agy-acp"));
    throw error;
  }
  if (operationError || cleanupErrors.length) {
    const original = operationError ? operationError.error : cleanupErrors[0];
    let error = original;
    if (operationError && cleanupErrors.length) {
      error = Object.assign(new AggregateError([original, ...cleanupErrors],
        original instanceof Error ? original.message : String(original), { cause: original }), {
        code: (original as { code?: unknown })?.code,
        data: (original as { data?: unknown })?.data,
      });
    }
    classifyAndAttach(error, classifyAgyError(error, "agy-acp"));
    throw error;
  }
  return turns;
}

/** Existing readable view of the same successful, fully closed replay. */
export async function readAgyAcpTranscript(opts: AgyAcpLaunch & {
  sessionId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  return renderTranscriptMessages(await readAgyAcpTranscriptMessages(opts));
}

/** Metadata only: inspect each model's own selector; never send a prompt. */
export async function probeAgyAcpCatalog(opts: AgyAcpLaunch & {
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<AgyAcpCatalog> {
  return runBoundedProbe({
    executable: opts.cliPath,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    processGroup: true,
    spawnOverride: () => spawn(opts.cliPath, [...opts.args], {
      cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], detached: true,
    }),
    label: "Antigravity native ACP catalog",
    run: async (handle) => {
      const connection = new ClientSideConnection(() => ({
        async sessionUpdate() {},
        async requestPermission() { return { outcome: { outcome: "cancelled" as const } }; },
      } satisfies Client), ndJsonStream(
        Writable.toWeb(handle.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(handle.stdout) as ReadableStream<Uint8Array>,
      ));
      let sessionId: string | undefined;
      handle.onClose(async (signal) => {
        if (sessionId) await agyWait(connection.closeSession({ sessionId }), signal);
      }, "session");
      handle.onClose(async (signal) => {
        handle.stdin.end();
        await agyWait(connection.closed, signal);
      }, "connection");
      const request = <T>(work: Promise<T>) => agyWait(work, handle.signal);
      const init = await request(connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "seam-acp", version: "0.1.0" },
        clientCapabilities: {},
      }));
      let session = await request(connection.newSession({ cwd: opts.cwd, mcpServers: [] }));
      sessionId = session.sessionId;
      const initial = session.configOptions ?? [];
      const model = select(initial, "model");
      if (!model) throw new Error("Antigravity ACP did not advertise a model selector");
      const models: AgyAcpCatalogModel[] = [];
      for (const choice of choices(model)) {
        if (!sessionId) {
          session = await request(connection.newSession({ cwd: opts.cwd, mcpServers: [] }));
          sessionId = session.sessionId;
        }
        const result = await request(connection.setSessionConfigOption({
          sessionId, configId: model.id, value: choice.value,
        }));
        const options = result.configOptions;
        if (select(options, "model")?.currentValue !== choice.value) {
          throw new Error(`Antigravity ACP did not confirm catalog selection ${choice.value}`);
        }
        const effort = select(options, "thought_level");
        models.push({
          modelId: choice.value,
          name: choice.name,
          effortChoices: choices(effort).map((entry) => entry.value),
          effortDefault: effort?.currentValue ?? "default",
        });
        // A fresh session prevents the previous model's effort from becoming a default.
        await request(connection.closeSession({ sessionId }));
        sessionId = undefined;
      }
      return {
        models,
        cliVersion: init.agentInfo?.version,
        image: init.agentCapabilities?.promptCapabilities?.image === true,
      };
    },
  });
}

/** Direct native ACP factory. Registration/switchover is a separate change. */
export function makeAgyAcpProfile(opts: {
  defaultModel: string;
  cliPath?: string;
  acpArgs?: readonly string[];
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  credentialProfile?: string;
}): AgentProfile {
  const cliPath = opts.cliPath ?? "agy";
  const args = [...(opts.acpArgs ?? AGY_ACP_ARGS)];
  const cwd = opts.cwd ?? process.cwd();
  const environment = () => ({ ...(opts.environment ?? process.env) });
  const credentialProfile = opts.credentialProfile ?? "antigravity-oauth:default";
  const scope = { provider: "google-antigravity", backend: AGY_ACP_BACKEND, credentialProfile };
  const profile = asLocalAdapter({
    id: "agy-acp",
    brand: "antigravity",
    displayName: "Antigravity",
    defaultModel: opts.defaultModel,
    effort: { mechanism: "configOption", configId: "thought_level", levels: [] },
    classifyError(error: unknown) {
      return classifyAndAttach(error, classifyAgyError(error, "agy-acp"));
    },
    catalog: {
      scope: () => manifestCatalogScope(scope),
      async fetch() {
        const probe = await probeAgyAcpCatalog({ cliPath, args, cwd, env: environment() });
        const candidate = await manifestCatalogSource({
          ...scope,
          defaultModel: opts.defaultModel,
          models: () => probe.models.map((model) => ({
            modelId: model.modelId,
            name: model.name,
            visionMode: probe.image ? "native" : "none",
            effort: model.effortChoices.length ? {
              mechanism: "configOption",
              configId: "thought_level",
              choices: model.effortChoices,
              selectionDefault: model.effortDefault,
            } : { mechanism: "none", choices: ["default"], selectionDefault: "default" },
          })),
          applicationMode: "live",
          adapterVersion: AGENT_ADAPTER_VERSION,
          source: "agy-acp-config-options",
        }).fetch();
        candidate.cliVersion = probe.cliVersion;
        candidate.sourceVersion = `acp/${PROTOCOL_VERSION}`;
        return candidate;
      },
    },
    spawn(_model, _effort, _mcpServers, slot) {
      return spawn(cliPath, [...args], {
        cwd: slot?.cwd ?? cwd,
        env: { ...environment(), ...slot?.env },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    },
  });
  profile.getTranscript = (sessionCwd, sessionId) => readAgyAcpTranscript({
    cliPath, args, cwd: sessionCwd, env: environment(), sessionId,
  });
  profile.getCompactionTranscript = (sessionCwd, sessionId) => readAgyAcpTranscriptMessages({
    cliPath, args, cwd: sessionCwd, env: environment(), sessionId,
  });
  return profile;
}
