import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "./logger.js";

/**
 * The health server, plus the two controls shutdown needs (#174).
 *
 * `close()` alone is not enough. It stops new CONNECTIONS, but the `/mcp` and
 * `/ingest` handlers below are invoked fire-and-forget — the server never holds
 * their promises — so a request admitted moments before close can still be
 * reading the store, writing the ledger or enqueuing a dispatch long after
 * `close()` has called back. And the health server deliberately stays up until
 * the very end, so that window is wide.
 */
export interface HealthServer extends Server {
  /**
   * Synchronously stop admitting `/mcp` and `/ingest`. `/health` keeps
   * answering, because monitoring still needs a truthful answer while the
   * process drains.
   */
  closeIngress(): void;
  /** Await requests admitted before `closeIngress()`, bounded. */
  drainIngress(timeoutMs: number): Promise<{ drained: boolean; outstanding: number }>;
}

export function startHealthServer(
  port: number,
  logger: Logger,
  opts?: {
    onMcp?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    onIngest?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }
): HealthServer {
  let ingressOpen = true;
  const inFlight = new Set<Promise<void>>();

  /** Run one ingress handler, tracked so shutdown can wait for it. */
  const track = (
    label: string,
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
    req: IncomingMessage,
    res: ServerResponse
  ): void => {
    // `Promise.resolve(handler(req, res))` would invoke the handler OUTSIDE the
    // promise chain: a SYNCHRONOUS throw escapes `track()` into the
    // `createServer` callback — an uncaught exception that also leaves the
    // request untracked, so the drain cannot see it and the client never gets a
    // response. Calling it inside `.then` puts both cases on the same path.
    const done = Promise.resolve()
      .then(() => handler(req, res))
      .catch((err) => {
        logger.warn({ err }, `health ${label} failed`);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `${label} failed` }));
        }
      })
      .finally(() => {
        inFlight.delete(done);
      });
    inFlight.add(done);
  };

  const refuse = (res: ServerResponse): void => {
    res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "30" });
    res.end(JSON.stringify({ error: "seam-acp is restarting; retry shortly" }));
  };

  const server = createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", utc: new Date().toISOString() }));
      return;
    }
    if ((url === "/mcp" || url === "/mcp/") && opts?.onMcp) {
      if (!ingressOpen) return refuse(res);
      track("/mcp proxy", opts.onMcp, req, res);
      return;
    }
    if (url.startsWith("/ingest") && opts?.onIngest) {
      if (!ingressOpen) return refuse(res);
      track("/ingest", opts.onIngest, req, res);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("seam-acp is running. See /health");
  }) as HealthServer;

  server.closeIngress = () => {
    if (!ingressOpen) return;
    ingressOpen = false;
    logger.info({ outstanding: inFlight.size }, "health ingress closed; /mcp and /ingest refused");
  };

  server.drainIngress = async (timeoutMs: number) => {
    if (inFlight.size === 0) return { drained: true, outstanding: 0 };
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled([...inFlight]), deadline]);
    if (timer) clearTimeout(timer);
    const outstanding = inFlight.size;
    if (outstanding > 0) {
      logger.warn({ outstanding, timeoutMs }, "health ingress drain timed out");
    }
    return { drained: outstanding === 0, outstanding };
  };

  server.listen(port, () => {
    logger.info({ port }, "health server listening");
  });

  return server;
}
