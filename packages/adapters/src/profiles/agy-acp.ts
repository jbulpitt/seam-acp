import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type SessionConfigOption,
  type SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import { AGENT_ADAPTER_VERSION, asLocalAdapter, type AgentProfile } from "../agent-profile.js";
import { agyWait } from "../agy-lifecycle.js";
import { manifestCatalogSource, manifestCatalogScope } from "../model-catalog.js";
import { runBoundedProbe } from "../probe-process.js";

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
  defaultModel: string;
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
        defaultModel: model.currentValue,
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
  return asLocalAdapter({
    id: "agy",
    brand: "antigravity",
    displayName: "Antigravity",
    defaultModel: opts.defaultModel,
    effort: { mechanism: "configOption", configId: "thought_level", levels: [] },
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
}
