import { SESSION_HISTORY_CHUNK_BYTES, type SessionHistoryChunk, type ISessionManager, type SessionSummary } from "@seam/adapters";
import type { BridgeHub } from "./bridge-hub.js";

type SessionRpc = Pick<BridgeHub, "rpc">;

/** Session files belong to the execution host, so remote reads and writes use its bridge. */
export function remoteSessionManager(
  hub: SessionRpc | undefined,
  location: string,
  agentId: string,
  capabilities?: { history: boolean; repair: boolean },
): ISessionManager {
  const call = async <T>(method: string, params: unknown): Promise<T> => {
    try {
      if (!hub) throw new Error(`bridge "${location}" is not connected`);
      return await hub.rpc(location, method, params, agentId) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Session host "${location}" could not answer ${method}: ${message}`, {
        cause: err,
      });
    }
  };

  return {
    ...(capabilities?.history ? {
      getHistory: async (cwd: string, sessionId: string) => {
        const chunks: Buffer[] = [];
        let offset = 0;
        for (;;) {
          const chunk = await call<SessionHistoryChunk | null>("getHistory", { cwd, sessionId, offset, length: SESSION_HISTORY_CHUNK_BYTES });
          if (!chunk) return undefined;
          chunks.push(Buffer.from(chunk.bytesBase64, "base64"));
          if (chunk.eof) return Buffer.concat(chunks).toString("utf8");
          offset = chunk.nextOffset;
        }
      },
    } : {}),
    ...(capabilities?.repair ? { repairSession: async (cwd: string, sessionId: string) => { await call("repairSession", { cwd, sessionId }); } } : {}),
    getUsage: (cwd, sessionId, newerThanMs) => call("getUsage", { cwd, sessionId, newerThanMs }),
    listSessions: (cwd) => call<SessionSummary[]>("listSessions", { cwd }),
    getTranscript: (cwd, sessionId) =>
      call<string>("getTranscript", { cwd, sessionId }),
    cloneSession: async (cwd, oldSessionId, newSessionId) => {
      await call("cloneSession", { cwd, oldSessionId, newSessionId });
    },
    deleteSession: async (cwd, sessionId) => {
      await call("deleteSession", { cwd, sessionId });
    },
  };
}
