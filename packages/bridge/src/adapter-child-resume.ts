/**
 * Resume records survive host restarts; completed or explicitly ended turns remove them.
 * They may contain credentials and use mode 0600 in sessiond's private directory.
 */
import fs from "node:fs";
import path from "node:path";
import type { EffortDescriptor } from "@seam/adapters";
import { adapterChildLine, ADAPTER_CHILD_PROTOCOL_VERSION, type AdapterChildBootstrap, type AdapterChildResume } from "./adapter-child-protocol.js";

export const RESUME_RECORD_VERSION = 1;

export interface ResumeRecord {
  version: typeof RESUME_RECORD_VERSION;
  slot: number;
  launch: { executable: string; args: string[]; cwd: string; env: Record<string, string> };
  initialStdinBase64: string;
}

export function createResumeRecorder(file: string | undefined, bootstrap: AdapterChildBootstrap, effort?: EffortDescriptor) {
  let initialize: unknown = bootstrap.resume?.initialize;
  let session: { cwd?: unknown; mcpServers?: unknown } | undefined = bootstrap.resume
    ? { cwd: bootstrap.resume.load.cwd, mcpServers: bootstrap.resume.load.mcpServers }
    : undefined;
  let recorded: string | undefined;
  let modeId = bootstrap.resume?.modeId;
  const modeRequests = new Map<unknown, string | undefined>();
  const effortConfigId = effort?.mechanism === "configOption" ? effort.configId : undefined;
  const configRequests = new Map<unknown, unknown>();
  let configSessionId = bootstrap.resume?.load.sessionId;
  let configOptions = bootstrap.resume?.configOptions;

  return {
    observeInput(line: string): void {
      if (!file || (!line.includes("\"initialize\"") && !line.includes("\"session/"))) return;
      try {
        const message = JSON.parse(line) as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
        if (message.method === "initialize") initialize = message.params;
        else if (message.method === "session/new" || message.method === "session/load") {
          session = { cwd: message.params?.cwd, mcpServers: message.params?.mcpServers };
          if (bootstrap.config.agentId === "codex") modeRequests.set(message.id, undefined);
          if (effortConfigId) configRequests.set(message.id, message.params?.sessionId);
        } else {
          if (effortConfigId && message.method === "session/set_config_option") {
            configRequests.set(message.id, message.params?.sessionId);
          }
          if (bootstrap.config.agentId !== "codex") return;
          const selected = message.method === "session/set_mode" ? message.params?.modeId
            : message.method === "session/set_config_option" && message.params?.configId === "mode" ? message.params.value : undefined;
          if (typeof selected === "string") modeRequests.set(message.id, selected);
        }
      } catch {
        // Not JSON-RPC; nothing to remember.
      }
    },

    /** Pending/rejected requests cannot replace acknowledged selections. */
    observeOutput(line: string): void {
      if (!file || (!modeRequests.size && !configRequests.size)) return;
      try {
        const message = JSON.parse(line) as { id?: unknown; error?: unknown; result?: {
          sessionId?: string; modes?: { currentModeId?: string };
          configOptions?: Array<{ id: string; category?: string; type: string; currentValue?: string }>;
        } };
        if (modeRequests.has(message.id)) {
          const selected = modeRequests.get(message.id);
          modeRequests.delete(message.id);
          if (!message.error) {
            const applied = selected ?? message.result?.modes?.currentModeId;
            if (modeId !== applied) { modeId = applied; recorded = undefined; }
          }
        }
        if (!configRequests.has(message.id)) return;
        const sessionId = configRequests.get(message.id) ?? message.result?.sessionId;
        configRequests.delete(message.id);
        if (message.error || typeof sessionId !== "string") return;
        const options = message.result?.configOptions;
        if (!options) return;
        const model = options.find(option => option.id === "model" || option.category === "model");
        const thought = options.find(option => option.id === effortConfigId);
        const selection = (option: typeof model) => option?.type === "select" && typeof option.currentValue === "string"
          ? { configId: option.id, value: option.currentValue } : undefined;
        const next = { model: selection(model), effort: selection(thought) };
        if (configSessionId !== sessionId || JSON.stringify(configOptions) !== JSON.stringify(next)) {
          configSessionId = sessionId;
          configOptions = next;
          recorded = undefined;
        }
      } catch { /* Not an ACP response. */ }
    },

    record(recovery: AdapterChildResume["recovery"] | undefined): void {
      if (!file || !recovery || recorded === recovery.submissionId || initialize === undefined || !session) return;
      const resume: AdapterChildResume = {
        initialize,
        load: { sessionId: recovery.acpSessionId, cwd: session.cwd, mcpServers: session.mcpServers ?? [] },
        ...(modeId ? { modeId } : {}),
        ...(configSessionId === recovery.acpSessionId && configOptions ? { configOptions } : {}),
        recovery,
      };
      const line = adapterChildLine({ ...bootstrap, v: ADAPTER_CHILD_PROTOCOL_VERSION, resume });
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") env[key] = value;
      const content: ResumeRecord = {
        version: RESUME_RECORD_VERSION,
        slot: bootstrap.slot,
        launch: { executable: process.execPath, args: process.argv.slice(1), cwd: process.cwd(), env },
        initialStdinBase64: Buffer.from(line).toString("base64"),
      };
      try {
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(content), { mode: 0o600 });
        fs.renameSync(temporary, file);
        recorded = recovery.submissionId;
      } catch (error) {
        process.stderr.write(`[adapter-child] resume record not written (${(error as NodeJS.ErrnoException).code ?? "error"}) in ${path.dirname(file)}\n`);
      }
    },

    clear(): void {
      if (!file) return;
      recorded = undefined;
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    },
  };
}
