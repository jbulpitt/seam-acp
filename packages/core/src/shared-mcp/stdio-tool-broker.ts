import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;
const BACKEND_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

export interface StdioToolBrokerOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  name?: string;
  port: number;
  maxBodyBytes?: number;
  sessionIdleMs?: number;
  logger?: Pick<Console, "error" | "info" | "warn">;
  onBackendClose?: () => void;
}

interface FrontendSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastActivityMs: number;
}

export interface RunningStdioToolBroker {
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly backendPid: number | null;
  close(): Promise<void>;
}

function jsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new Error("MCP request body is too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function inheritedEnvironment(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

export async function startStdioToolBroker(options: StdioToolBrokerOptions): Promise<RunningStdioToolBroker> {
  const logger = options.logger ?? console;
  const name = options.name ?? "shared-stdio-mcp";
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const sessionIdleMs = options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS;
  const sessions = new Map<string, FrontendSession>();
  let closing = false;
  let healthy = true;

  const backendTransport = new StdioClientTransport({
    command: options.command,
    args: options.args ?? [],
    cwd: options.cwd,
    env: inheritedEnvironment(options.env),
    stderr: "pipe",
  });
  const backend = new Client(
    { name: `${name}-broker`, version: "1.0.0" },
    { capabilities: {} },
  );
  backend.onerror = (error) => logger.error(`[${name}] backend MCP error: ${error.message}`);
  backend.onclose = () => {
    healthy = false;
    if (!closing) {
      logger.error(`[${name}] backend MCP process closed`);
      options.onBackendClose?.();
    }
  };
  await backend.connect(backendTransport, { timeout: 30_000 });

  backendTransport.stderr?.on("data", (chunk: Buffer | string) => {
    const line = String(chunk).trimEnd();
    if (line) logger.warn(`[${name}] ${line}`);
  });

  const backendCapabilities = backend.getServerCapabilities();
  if (!backendCapabilities?.tools) {
    await backend.close();
    throw new Error(`${name} backend does not advertise MCP tools`);
  }

  const createFrontend = (): FrontendSession => {
    let entry: FrontendSession;
    const frontend = new Server(
      { name, version: "1.0.0" },
      {
        capabilities: {
          tools: { listChanged: backendCapabilities.tools?.listChanged === true },
        },
        instructions: backend.getInstructions(),
      },
    );
    frontend.setRequestHandler(ListToolsRequestSchema, async (request) =>
      backend.listTools(request.params, { timeout: BACKEND_REQUEST_TIMEOUT_MS }),
    );
    frontend.setRequestHandler(CallToolRequestSchema, async (request) =>
      backend.callTool(request.params, undefined, {
        timeout: BACKEND_REQUEST_TIMEOUT_MS,
        maxTotalTimeout: BACKEND_REQUEST_TIMEOUT_MS,
      }),
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, entry);
      },
    });
    entry = { server: frontend, transport, lastActivityMs: Date.now() };
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) sessions.delete(sessionId);
    };
    return entry;
  };

  backend.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    await Promise.allSettled([...sessions.values()].map(({ server }) => server.sendToolListChanged()));
  });

  const httpServer: HttpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
      if (url.pathname === "/healthz" && req.method === "GET") {
        const status = healthy ? 200 : 503;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: healthy, backendPid: backendTransport.pid ?? null, sessions: sessions.size }));
        return;
      }
      if (url.pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (!healthy) {
        jsonRpcError(res, 503, "Shared MCP backend is unavailable");
        return;
      }

      const header = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(header) ? header[0] : header;
      let entry = sessionId ? sessions.get(sessionId) : undefined;
      let parsedBody: unknown;

      if (req.method === "POST") {
        try {
          parsedBody = await readJsonBody(req, maxBodyBytes);
        } catch (error) {
          jsonRpcError(res, error instanceof SyntaxError ? 400 : 413, "Invalid MCP request body");
          return;
        }
        if (!entry) {
          if (sessionId || !isInitializeRequest(parsedBody)) {
            jsonRpcError(res, sessionId ? 404 : 400, sessionId ? "Unknown MCP session" : "MCP session is not initialized");
            return;
          }
          entry = createFrontend();
          await entry.server.connect(entry.transport);
        }
      } else if (!entry) {
        jsonRpcError(res, sessionId ? 404 : 400, sessionId ? "Unknown MCP session" : "MCP session ID is required");
        return;
      }

      entry.lastActivityMs = Date.now();
      await entry.transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      logger.error(`[${name}] HTTP handler failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) jsonRpcError(res, 500, "Shared MCP request failed");
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, LOOPBACK_HOST, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    await backend.close();
    throw new Error(`${name} failed to bind its loopback listener`);
  }

  const reapTimer = setInterval(() => {
    const cutoff = Date.now() - sessionIdleMs;
    for (const [sessionId, entry] of sessions) {
      if (entry.lastActivityMs < cutoff) {
        sessions.delete(sessionId);
        void entry.server.close().catch((error) =>
          logger.warn(`[${name}] failed to close idle session: ${error instanceof Error ? error.message : String(error)}`),
        );
      }
    }
  }, Math.min(sessionIdleMs, 60_000));
  reapTimer.unref();

  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    clearInterval(reapTimer);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await Promise.allSettled([...sessions.values()].map(({ server }) => server.close()));
    sessions.clear();
    await backend.close();
  };

  logger.info(`[${name}] listening on http://${LOOPBACK_HOST}:${address.port}/mcp (backend pid ${backendTransport.pid ?? "unknown"})`);
  return {
    host: LOOPBACK_HOST,
    port: address.port,
    backendPid: backendTransport.pid ?? null,
    close,
  };
}

function parseArgsJson(value: string | undefined): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("SHARED_MCP_ARGS_JSON must be a JSON array of strings");
  }
  return parsed;
}

export async function runStdioToolBrokerCli(): Promise<void> {
  const command = process.env.SHARED_MCP_COMMAND;
  const port = Number(process.env.SHARED_MCP_PORT);
  if (!command) throw new Error("SHARED_MCP_COMMAND is required");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SHARED_MCP_PORT must be a valid TCP port");
  }
  const broker = await startStdioToolBroker({
    command,
    args: parseArgsJson(process.env.SHARED_MCP_ARGS_JSON),
    cwd: process.env.SHARED_MCP_CWD,
    name: process.env.SHARED_MCP_NAME,
    port,
    onBackendClose: () => {
      process.exitCode = 1;
      setImmediate(() => process.exit(1));
    },
  });
  const shutdown = async (): Promise<void> => {
    await broker.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runStdioToolBrokerCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
