import type { ISessionManager, SessionSummary } from "@seam/adapters";
import type { BridgeHub } from "./bridge-hub.js";

type SessionRpc = Pick<BridgeHub, "rpc">;

/** Session files belong to the execution host, so remote reads and writes use its bridge. */
export function remoteSessionManager(
  hub: SessionRpc | undefined,
  location: string,
  agentId: string
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
