/**
 * Resume records for turns interrupted by a host restart (#631).
 *
 * While a delegated turn is in flight, the adapter child keeps a private
 * record of how to relaunch itself and continue that turn. sessiond deletes
 * it when it sees the slot exit or kills the slot on purpose, and the child
 * deletes it when the turn finishes. So a record outlives its process only
 * when the host (or sessiond and the child together) went down mid-turn.
 * After boot, sessiond relaunches each record it finds; it does not read it.
 *
 * The record holds the child's launch and bootstrap, which can include
 * credentials. It is written 0600 inside sessiond's private resume directory.
 */
import fs from "node:fs";
import path from "node:path";
import { adapterChildLine, ADAPTER_CHILD_PROTOCOL_VERSION, type AdapterChildBootstrap, type AdapterChildResume } from "./adapter-child-protocol.js";

export const RESUME_RECORD_VERSION = 1;

export interface ResumeRecord {
  version: typeof RESUME_RECORD_VERSION;
  slot: number;
  launch: { executable: string; args: string[]; cwd: string; env: Record<string, string> };
  initialStdinBase64: string;
}

export function createResumeRecorder(file: string | undefined, bootstrap: AdapterChildBootstrap) {
  let initialize: unknown = bootstrap.resume?.initialize;
  let session: { cwd?: unknown; mcpServers?: unknown } | undefined = bootstrap.resume
    ? { cwd: bootstrap.resume.load.cwd, mcpServers: bootstrap.resume.load.mcpServers }
    : undefined;
  let recorded: string | undefined;
  let modeId = bootstrap.resume?.modeId;
  const modeRequests = new Map<unknown, string | undefined>();

  return {
    /** Remember how the controller set the session up, from its own requests. */
    observeInput(line: string): void {
      if (!file || (!line.includes("\"initialize\"") && !line.includes("\"session/"))) return;
      try {
        const message = JSON.parse(line) as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
        if (message.method === "initialize") initialize = message.params;
        else if (message.method === "session/new" || message.method === "session/load") {
          session = { cwd: message.params?.cwd, mcpServers: message.params?.mcpServers };
          if (bootstrap.config.agentId === "codex") modeRequests.set(message.id, undefined);
        } else if (bootstrap.config.agentId === "codex") {
          const selected = message.method === "session/set_mode" ? message.params?.modeId
            : message.method === "session/set_config_option" && message.params?.configId === "mode" ? message.params.value : undefined;
          if (typeof selected === "string") modeRequests.set(message.id, selected);
        }
      } catch {
        // Not JSON-RPC; nothing to remember.
      }
    },

    /** Persist mode changes only after the agent accepts them. */
    observeOutput(line: string): void {
      if (!file || !modeRequests.size) return;
      try {
        const message = JSON.parse(line) as { id?: unknown; error?: unknown; result?: { modes?: { currentModeId?: string } } };
        if (!modeRequests.has(message.id)) return;
        const selected = modeRequests.get(message.id);
        modeRequests.delete(message.id);
        if (message.error) return;
        const applied = selected ?? message.result?.modes?.currentModeId;
        if (modeId !== applied) { modeId = applied; recorded = undefined; }
      } catch { /* Not an ACP response. */ }
    },

    /** Write the record for an in-flight turn, once per submission. */
    record(recovery: AdapterChildResume["recovery"] | undefined): void {
      if (!file || !recovery || recorded === recovery.submissionId || initialize === undefined || !session) return;
      const resume: AdapterChildResume = {
        initialize,
        load: { sessionId: recovery.acpSessionId, cwd: session.cwd, mcpServers: session.mcpServers ?? [] },
        ...(modeId ? { modeId } : {}),
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
