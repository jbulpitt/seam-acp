import { createServer, type Server } from "node:http";
import type { Logger } from "./logger.js";

export function startHealthServer(port: number, logger: Logger): Server {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", utc: new Date().toISOString() }));
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
