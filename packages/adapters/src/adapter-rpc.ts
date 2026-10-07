/**
 * Host-side adapter RPC dispatcher, shared by every bridge.
 * Spawn uses the mux slot path; the remaining adapter verbs use this switch.
 */
import { promises as fsp } from "node:fs";
import { isAdapterRpcMethod } from "./command-bus.js";
import { normalizeCatalogCandidate } from "./catalog-evidence.js";
import { scanWorkspaces } from "./workspace-scan.js";
import { readAttachmentWithinRoot } from "./read-attachment.js";
import type { AgentAdapter } from "./agent-profile.js";
import { SESSION_HISTORY_CHUNK_BYTES, type SessionHistoryChunk } from "./session-manager.js";

export interface AdapterRpcCtx {
  adapter?: AgentAdapter;
  workspaceRoot: string;
  cwd?: string;
}

function asRecord(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export async function invokeAdapterRpc(
  method: string,
  params: unknown,
  ctx: AdapterRpcCtx
): Promise<unknown> {
  if (!isAdapterRpcMethod(method) || method === "spawn") {
    throw new Error(`unknown rpc method: ${method}`);
  }
  const p = asRecord(params);
  const cwd = str(p.cwd) ?? ctx.cwd ?? ctx.workspaceRoot;
  const adapter = ctx.adapter;

  switch (method) {
    case "listWorkspaces":
      // D11: host enumerates under its single workspace root. Adapter
      // stubs stay empty; every bridge uses this host-side scan.
      return scanWorkspaces(ctx.workspaceRoot);
    case "describe":
      if (!adapter) throw new Error("no adapter for describe");
      return adapter.describe();
    case "prepare":
      if (!adapter) throw new Error("no adapter for prepare");
      return adapter.prepare();
    case "describeModelCatalog":
      if (!adapter) throw new Error("no adapter for describeModelCatalog");
      return adapter.catalog.scope();
    case "fetchModelCatalog":
      if (!adapter) throw new Error("no adapter for fetchModelCatalog");
      {
        const candidate = await adapter.catalog.fetch();
        // #236: the portable generic screen runs BEFORE the candidate crosses
        // the bridge, not only when core persists it. A remote host is not a
        // trust boundary we can defer past — unbounded or secret-bearing
        // evidence must never be transported in the first place. Core applies
        // the same validator again on receipt.
        adapter.catalog.validate?.(candidate);
        // Normalize AND validate before transport: what crosses the bridge is
        // the sanitized, canonically ordered candidate, never the raw one.
        return normalizeCatalogCandidate(candidate);
      }
    case "install": {
      if (!adapter) throw new Error("no adapter for install");
      return adapter.install();
    }
    case "listSessions":
      if (!adapter) throw new Error("no adapter for listSessions");
      return adapter.listSessions(cwd);
    case "getHistory": {
      if (!adapter) throw new Error("no adapter for getHistory");
      if (!adapter.sessionManager?.getHistoryPath) throw new Error("no session manager for getHistory");
      const sessionId = str(p.sessionId);
      if (!sessionId) throw new Error("sessionId required");
      const history = await adapter.sessionManager.getHistoryPath(cwd, sessionId);
      if (!history) return null;
      const offset = typeof p.offset === "number" ? p.offset : 0;
      const length = Math.min(typeof p.length === "number" ? p.length : SESSION_HISTORY_CHUNK_BYTES, SESSION_HISTORY_CHUNK_BYTES);
      const file = await fsp.open(history, "r");
      try {
        const bytes = Buffer.alloc(length);
        const { bytesRead } = await file.read(bytes, 0, length, offset);
        return {
          bytesBase64: bytes.subarray(0, bytesRead).toString("base64"),
          nextOffset: offset + bytesRead, eof: bytesRead < length,
        } satisfies SessionHistoryChunk;
      } finally {
        await file.close();
      }
    }
    case "repairSession": {
      if (!adapter) throw new Error("no adapter for repairSession");
      if (!adapter.sessionManager?.repairSession) throw new Error("no session manager for repairSession");
      const sessionId = str(p.sessionId);
      if (!sessionId) throw new Error("sessionId required");
      await adapter.sessionManager.repairSession(cwd, sessionId);
      return null;
    }
    case "getTranscript": {
      if (!adapter) throw new Error("no adapter for getTranscript");
      const sessionId = str(p.sessionId);
      if (!sessionId) throw new Error("sessionId required");
      return adapter.getTranscript(cwd, sessionId);
    }
    case "getUsage":
    case "usage":
      if (!adapter) throw new Error("no adapter for usage");
      return adapter.usage(
        cwd,
        str(p.sessionId),
        typeof p.newerThanMs === "number" ? p.newerThanMs : undefined
      );
    case "cloneSession": {
      if (!adapter) throw new Error("no adapter for cloneSession");
      const oldSessionId = str(p.oldSessionId);
      const newSessionId = str(p.newSessionId);
      if (!oldSessionId || !newSessionId) {
        throw new Error("oldSessionId and newSessionId required");
      }
      await adapter.cloneSession(cwd, oldSessionId, newSessionId);
      return null;
    }
    case "deleteSession": {
      if (!adapter) throw new Error("no adapter for deleteSession");
      const sessionId = str(p.sessionId);
      if (!sessionId) throw new Error("sessionId required");
      await adapter.deleteSession(cwd, sessionId);
      return null;
    }
    case "whoami":
      if (!adapter) throw new Error("no adapter for whoami");
      if (!adapter.whoami) throw new Error(`Agent \`${adapter.id}\` (${adapter.displayName}) does not expose account info.`);
      return adapter.whoami();
    case "writeAttachment": {
      if (!adapter) throw new Error("no adapter for writeAttachment");
      const filename = str(p.filename);
      const bytes = p.bytes ?? p.base64;
      if (!filename || bytes == null) throw new Error("filename and bytes/base64 required");
      const payload =
        typeof bytes === "string"
          ? bytes
          : Buffer.from(bytes as Uint8Array).toString("base64");
      return adapter.writeAttachment(cwd, filename, payload);
    }
    case "readAttachment": {
      const requested = str(p.path) ?? str(p.filename);
      if (!requested) throw new Error("path required");
      const att = await readAttachmentWithinRoot(cwd, requested, ctx.workspaceRoot);
      return {
        bytesBase64: Buffer.from(att.bytes).toString("base64"),
        filename: att.filename,
        size: att.size,
      };
    }
    default:
      throw new Error(`unknown rpc method: ${method}`);
  }
}
