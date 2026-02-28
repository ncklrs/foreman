/**
 * HTTP API Server.
 * Zero-dependency HTTP + WebSocket server built on Node's built-in modules.
 * Provides REST endpoints for programmatic access to Foreman and
 * WebSocket for real-time event streaming.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Orchestrator } from "../orchestrator.js";
import type { ForemanEvent } from "../types/index.js";
import { Logger } from "../logging/logger.js";
import { createRouter, type Route } from "./router.js";
import { buildHandlers, buildHookHandlers } from "./handlers.js";
import { WebSocketServer } from "./websocket.js";
import { authMiddleware, corsMiddleware, type ApiConfig } from "./middleware.js";
import type { HookHandler } from "../hooks/handler.js";

export interface ApiServerOptions {
  orchestrator: Orchestrator;
  config: ApiConfig;
  logger: Logger;
  /** Optional hook handler for Claude Code hooks integration. */
  hookHandler?: HookHandler;
}

export class ApiServer {
  private server: ReturnType<typeof createServer> | null = null;
  private wsServer: WebSocketServer;
  private orchestrator: Orchestrator;
  private config: ApiConfig;
  private logger: Logger;
  private routes: Route[];

  constructor(options: ApiServerOptions) {
    this.orchestrator = options.orchestrator;
    this.config = options.config;
    this.logger = options.logger.child("api");
    this.wsServer = new WebSocketServer(this.logger);

    // Build route table from handlers
    const handlers = buildHandlers(this.orchestrator, this.logger);

    // Add hook handlers if configured
    if (options.hookHandler) {
      const hookHandlers = buildHookHandlers(options.hookHandler, this.logger);
      Object.assign(handlers, hookHandlers);
    }

    this.routes = createRouter(handlers);
  }

  /** Start the HTTP server. */
  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handleRequest(req, res));

      // Upgrade for WebSocket connections
      this.server.on("upgrade", (req, socket, head) => {
        if (req.url === "/api/ws" || req.url === "/api/events/stream") {
          // Validate auth on WebSocket upgrade
          if (this.config.apiKey) {
            const authHeader = req.headers["authorization"];
            const urlKey = new URL(req.url, `http://${req.headers.host}`).searchParams.get("key");
            const token = authHeader?.replace("Bearer ", "") ?? urlKey;
            if (token !== this.config.apiKey) {
              socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
              socket.destroy();
              return;
            }
          }
          this.wsServer.handleUpgrade(req, socket, head);
        } else {
          socket.destroy();
        }
      });

      const port = this.config.port ?? 4820;
      const host = this.config.host ?? "127.0.0.1";

      this.server.listen(port, host, () => {
        this.logger.info(`API server listening on ${host}:${port}`);
        resolve();
      });

      // Subscribe to orchestrator events and broadcast to WebSocket clients
      this.orchestrator.getEventBus().onAny((event) => {
        this.wsServer.broadcast(event);
      });
    });
  }

  /** Stop the HTTP server. */
  async stop(): Promise<void> {
    this.wsServer.closeAll();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.logger.info("API server stopped");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /** Get the listening port. */
  getPort(): number {
    const addr = this.server?.address();
    if (addr && typeof addr === "object") return addr.port;
    return this.config.port ?? 4820;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();

    // CORS
    corsMiddleware(req, res, this.config);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth
    if (!authMiddleware(req, this.config)) {
      this.sendJson(res, 401, { error: "Unauthorized", message: "Invalid or missing API key" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method ?? "GET";
    const path = url.pathname;

    // Find matching route
    for (const route of this.routes) {
      const params = route.match(method, path);
      if (params !== null) {
        try {
          const body = method === "POST" || method === "PUT" || method === "PATCH"
            ? await readBody(req)
            : undefined;

          const result = await route.handler({
            params,
            query: Object.fromEntries(url.searchParams),
            body,
          });

          this.sendJson(res, result.status, result.body);
        } catch (error) {
          this.logger.error("API handler error", {
            method,
            path,
            error: error instanceof Error ? error.message : error,
          });
          this.sendJson(res, 500, {
            error: "Internal Server Error",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }

        this.logger.debug("API request", {
          method,
          path,
          status: res.statusCode,
          durationMs: Date.now() - startTime,
        });
        return;
      }
    }

    // No route matched
    this.sendJson(res, 404, { error: "Not Found", path });
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
    });
    res.end(json);
  }
}

/** Read request body as parsed JSON. */
function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const maxSize = 1024 * 1024; // 1MB

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}
