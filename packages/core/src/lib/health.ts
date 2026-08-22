import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Logger } from "./logger.js";

export function startHealthServer(
  port: number,
  logger: Logger,
  opts?: {
    onMcp?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    onIngest?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }
): Server {
  const server = createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    if (url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", utc: new Date().toISOString() }));
      return;
    }
    if ((url === "/mcp" || url === "/mcp/") && opts?.onMcp) {
      void Promise.resolve(opts.onMcp(req, res)).catch((err) => {
        logger.warn({ err }, "health /mcp proxy failed");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "mcp proxy failed" }));
        }
      });
      return;
    }
    if (url.startsWith("/ingest") && opts?.onIngest) {
      void Promise.resolve(opts.onIngest(req, res)).catch((err) => {
        logger.warn({ err }, "health /ingest failed");
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "ingest failed" }));
        }
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("seam-acp is running. See /health");
  });

  server.listen(port, () => {
    logger.info({ port }, "health server listening");
  });

  return server;
}
