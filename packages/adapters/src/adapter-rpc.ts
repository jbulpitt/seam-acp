/**
 * In-process adapter RPC dispatcher (D9).
 *
 * The remote-bridge and the local loopback host share this switch so
 * `listWorkspaces` / `describe` / session verbs / attachment ferry take
 * one code path. `spawn` is intentionally omitted: ACP stdio is the mux
 * slot path (remote: rpc spawn after mux.spawn; local: unbound profile.spawn).
 */
import { isAdapterRpcMethod } from "./command-bus.js";
import { scanWorkspaces } from "./workspace-scan.js";
import { readAttachmentWithinRoot } from "./read-attachment.js";
import type { AgentAdapter } from "./agent-profile.js";

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
      // stubs stay empty; this is the host-side scan both loopback and
      // the remote bridge use.
      return scanWorkspaces(ctx.workspaceRoot);
    case "describe":
      if (!adapter) throw new Error("no adapter for describe");
      return adapter.describe();
    case "prepare":
      if (!adapter) throw new Error("no adapter for prepare");
      return adapter.prepare();
    case "install": {
      if (!adapter) throw new Error("no adapter for install");
      return adapter.install();
    }
    case "listSessions":
      if (!adapter) throw new Error("no adapter for listSessions");
      return adapter.listSessions(cwd);
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
      return adapter?.whoami?.() ?? null;
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
