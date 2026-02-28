import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRouter, type HandlerMap } from "../src/api/router.js";
import { authMiddleware, corsMiddleware, RateLimiter, type ApiConfig } from "../src/api/middleware.js";
import { buildHandlers } from "../src/api/handlers.js";
import { ApiServer } from "../src/api/server.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";

// ── Router Tests ─────────────────────────────────────────────────

describe("createRouter", () => {
  it("should match exact paths", () => {
    const handlers: HandlerMap = {
      "GET /api/health": () => ({ status: 200, body: { ok: true } }),
    };
    const routes = createRouter(handlers);
    expect(routes.length).toBe(1);
    expect(routes[0].match("GET", "/api/health")).toEqual({});
    expect(routes[0].match("POST", "/api/health")).toBeNull();
    expect(routes[0].match("GET", "/api/other")).toBeNull();
  });

  it("should match parameterized paths", () => {
    const handlers: HandlerMap = {
      "GET /api/sessions/:id": () => ({ status: 200, body: {} }),
    };
    const routes = createRouter(handlers);
    expect(routes[0].match("GET", "/api/sessions/abc123")).toEqual({ id: "abc123" });
    expect(routes[0].match("GET", "/api/sessions")).toBeNull();
    expect(routes[0].match("GET", "/api/sessions/abc/extra")).toBeNull();
  });

  it("should decode URI components in params", () => {
    const handlers: HandlerMap = {
      "GET /api/items/:name": () => ({ status: 200, body: {} }),
    };
    const routes = createRouter(handlers);
    expect(routes[0].match("GET", "/api/items/hello%20world")).toEqual({ name: "hello world" });
  });

  it("should handle multiple routes", () => {
    const handlers: HandlerMap = {
      "GET /api/a": () => ({ status: 200, body: "a" }),
      "POST /api/b": () => ({ status: 200, body: "b" }),
      "GET /api/c/:id": () => ({ status: 200, body: "c" }),
    };
    const routes = createRouter(handlers);
    expect(routes.length).toBe(3);
    expect(routes[0].match("GET", "/api/a")).toEqual({});
    expect(routes[1].match("POST", "/api/b")).toEqual({});
    expect(routes[2].match("GET", "/api/c/42")).toEqual({ id: "42" });
  });

  it("should return null for non-matching method", () => {
    const handlers: HandlerMap = {
      "POST /api/tasks": () => ({ status: 201, body: {} }),
    };
    const routes = createRouter(handlers);
    expect(routes[0].match("GET", "/api/tasks")).toBeNull();
  });
});

// ── Auth Middleware Tests ─────────────────────────────────────────

describe("authMiddleware", () => {
  function makeReq(headers: Record<string, string> = {}, url = "/"): IncomingMessage {
    return {
      headers,
      url,
    } as unknown as IncomingMessage;
  }

  it("should allow all when no API key configured", () => {
    const config: ApiConfig = {};
    expect(authMiddleware(makeReq(), config)).toBe(true);
  });

  it("should accept valid Bearer token", () => {
    const config: ApiConfig = { apiKey: "test-key-123" };
    const req = makeReq({ authorization: "Bearer test-key-123", host: "localhost" });
    expect(authMiddleware(req, config)).toBe(true);
  });

  it("should reject invalid Bearer token", () => {
    const config: ApiConfig = { apiKey: "test-key-123" };
    const req = makeReq({ authorization: "Bearer wrong-key", host: "localhost" });
    expect(authMiddleware(req, config)).toBe(false);
  });

  it("should accept valid query param key", () => {
    const config: ApiConfig = { apiKey: "test-key-123" };
    const req = makeReq({ host: "localhost" }, "/api/health?key=test-key-123");
    expect(authMiddleware(req, config)).toBe(true);
  });

  it("should reject missing auth when API key is required", () => {
    const config: ApiConfig = { apiKey: "test-key-123" };
    const req = makeReq({ host: "localhost" });
    expect(authMiddleware(req, config)).toBe(false);
  });
});

// ── CORS Middleware Tests ─────────────────────────────────────────

describe("corsMiddleware", () => {
  function makeRes(): ServerResponse {
    const headers: Record<string, string> = {};
    return {
      setHeader: (name: string, value: string) => { headers[name] = value; },
      getHeader: (name: string) => headers[name],
      _headers: headers,
    } as unknown as ServerResponse;
  }

  it("should set wildcard CORS by default", () => {
    const req = { headers: {} } as IncomingMessage;
    const res = makeRes();
    corsMiddleware(req, res, {});
    expect((res as unknown as { _headers: Record<string, string> })._headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("should set specific origin when matched", () => {
    const req = { headers: { origin: "https://dashboard.example.com" } } as unknown as IncomingMessage;
    const res = makeRes();
    corsMiddleware(req, res, { corsOrigins: ["https://dashboard.example.com"] });
    expect((res as unknown as { _headers: Record<string, string> })._headers["Access-Control-Allow-Origin"])
      .toBe("https://dashboard.example.com");
  });

  it("should not set origin when not in allowed list", () => {
    const req = { headers: { origin: "https://evil.com" } } as unknown as IncomingMessage;
    const res = makeRes();
    corsMiddleware(req, res, { corsOrigins: ["https://dashboard.example.com"] });
    expect((res as unknown as { _headers: Record<string, string> })._headers["Access-Control-Allow-Origin"])
      .toBeUndefined();
  });
});

// ── Rate Limiter Tests ───────────────────────────────────────────

describe("RateLimiter", () => {
  it("should allow requests under limit", () => {
    const limiter = new RateLimiter(10);
    for (let i = 0; i < 10; i++) {
      expect(limiter.check("127.0.0.1")).toBe(true);
    }
  });

  it("should block requests over limit", () => {
    const limiter = new RateLimiter(3);
    expect(limiter.check("127.0.0.1")).toBe(true);
    expect(limiter.check("127.0.0.1")).toBe(true);
    expect(limiter.check("127.0.0.1")).toBe(true);
    expect(limiter.check("127.0.0.1")).toBe(false);
  });

  it("should track IPs independently", () => {
    const limiter = new RateLimiter(1);
    expect(limiter.check("1.1.1.1")).toBe(true);
    expect(limiter.check("1.1.1.1")).toBe(false);
    expect(limiter.check("2.2.2.2")).toBe(true);
  });

  it("should report remaining requests", () => {
    const limiter = new RateLimiter(5);
    expect(limiter.remaining("127.0.0.1")).toBe(5);
    limiter.check("127.0.0.1");
    limiter.check("127.0.0.1");
    expect(limiter.remaining("127.0.0.1")).toBe(3);
  });

  it("should clean up expired entries", () => {
    const limiter = new RateLimiter(1);
    limiter.check("127.0.0.1");
    // Manually expire by manipulating the internal state
    limiter.cleanup();
    // Entry is still valid (not expired), so cleanup doesn't remove it
    expect(limiter.remaining("127.0.0.1")).toBe(0);
  });
});

// ── Handlers Tests (mock orchestrator) ───────────────────────────

function createMockOrchestrator() {
  const sessions = [
    {
      id: "sess_1",
      task: { id: "task_1", title: "Fix bug", labels: ["bug"] },
      status: "completed",
      modelName: "claude-sonnet",
      messages: [{ role: "user", content: "fix it" }],
      iterations: 5,
      maxIterations: 50,
      tokenUsage: { inputTokens: 1000, outputTokens: 500 },
      startedAt: new Date("2025-01-01"),
      completedAt: new Date("2025-01-01"),
      artifacts: [],
    },
    {
      id: "sess_2",
      task: { id: "task_2", title: "Add feature", labels: ["feature"] },
      status: "running",
      modelName: "claude-opus",
      messages: [],
      iterations: 2,
      maxIterations: 50,
      tokenUsage: { inputTokens: 500, outputTokens: 200 },
      startedAt: new Date("2025-01-02"),
      artifacts: [],
    },
  ];

  const events = [
    { type: "agent:started", session: sessions[0] },
    { type: "agent:completed", session: sessions[0] },
    { type: "task:queued", task: sessions[1].task },
  ];

  const providerHealth = new Map([
    ["coder", { healthy: true, latencyMs: 120, lastChecked: new Date() }],
    ["fast", { healthy: false, latencyMs: null, lastChecked: new Date(), error: "timeout" }],
  ]);

  const knowledgeStore = {
    getKnowledgeBase: () => ({
      version: 1,
      lessons: [{ id: "l1", type: "pattern", summary: "test lesson" }],
      failurePatterns: [],
      seenFindings: ["fp1", "fp2"],
      modelPreferences: { bug: "claude-sonnet" },
      updatedAt: "2025-01-01",
    }),
    learnFromUser: vi.fn(),
  };

  const skillsRegistry = {
    getAll: () => [
      { name: "code-review", description: "Review code", triggers: ["review"], tags: ["quality"], source: "builtin" },
      { name: "bug-fix", description: "Fix bugs", triggers: ["bug", "fix"], tags: ["debug"], source: "builtin" },
    ],
  };

  const autopilotEngine = {
    getRuns: () => [{ id: "ap_1", status: "completed", findings: [], ticketsCreated: [] }],
    getActiveRun: () => null,
    triggerRun: vi.fn().mockResolvedValue({
      id: "ap_2",
      status: "completed",
      findings: [{ id: "f1" }],
      ticketsCreated: ["T-1"],
    }),
  };

  const enqueuedTasks: unknown[] = [];

  return {
    getSessions: () => sessions,
    getEvents: () => events,
    getProviderHealth: () => providerHealth,
    getConfig: () => ({
      foreman: { name: "test", logLevel: "info", maxConcurrentAgents: 4 },
      models: {
        coder: { provider: "anthropic", model: "claude-sonnet", role: "coder", maxTokens: 4096 },
        fast: { provider: "anthropic", model: "claude-haiku", role: "fast", maxTokens: 2048, apiKey: "sk-secret" },
      },
      routing: { strategy: "capability_match", fallbackChain: ["coder"] },
      sandbox: { type: "local", warmPool: 1, timeoutMinutes: 30, cleanup: "on_success" },
      policy: { protectedPaths: ["package.json"], blockedCommands: ["rm -rf /"], maxDiffLines: 500, requireApprovalAbove: 200 },
      autopilot: { enabled: true, schedule: "0 9 * * 1-5", scanners: ["security"], autoResolve: false },
    }),
    getPerformanceStats: () => ({ coder: { totalTasks: 10, successRate: 0.9 } }),
    getKnowledgeStore: () => knowledgeStore,
    getSkillsRegistry: () => skillsRegistry,
    getAutopilotEngine: () => autopilotEngine,
    enqueueTask: vi.fn((task: unknown) => enqueuedTasks.push(task)),
    getLogger: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: () => ({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
      }),
    }),
    _enqueuedTasks: enqueuedTasks,
  };
}

describe("API handlers", () => {
  let handlers: HandlerMap;
  let mockOrch: ReturnType<typeof createMockOrchestrator>;

  beforeEach(() => {
    mockOrch = createMockOrchestrator();
    handlers = buildHandlers(mockOrch as any, mockOrch.getLogger() as any);
  });

  it("GET /api/health should return system health", async () => {
    const result = await handlers["GET /api/health"]({ params: {}, query: {} });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.activeSessions).toBe(1); // 1 running
    expect(body.totalSessions).toBe(2);
    expect((body.providers as Record<string, unknown>)["coder"]).toBeDefined();
  });

  it("GET /api/sessions should return session list", async () => {
    const result = await handlers["GET /api/sessions"]({ params: {}, query: {} });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect((body.sessions as unknown[]).length).toBe(2);
    expect(body.total).toBe(2);
  });

  it("GET /api/sessions should filter by status", async () => {
    const result = await handlers["GET /api/sessions"]({ params: {}, query: { status: "completed" } });
    const body = result.body as Record<string, unknown>;
    expect((body.sessions as unknown[]).length).toBe(1);
  });

  it("GET /api/sessions should support pagination", async () => {
    const result = await handlers["GET /api/sessions"]({ params: {}, query: { limit: "1", offset: "1" } });
    const body = result.body as Record<string, unknown>;
    expect((body.sessions as unknown[]).length).toBe(1);
    expect(body.offset).toBe(1);
  });

  it("GET /api/sessions/:id should return session detail", async () => {
    const result = await handlers["GET /api/sessions/:id"]({ params: { id: "sess_1" }, query: {} });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.id).toBe("sess_1");
  });

  it("GET /api/sessions/:id should 404 for unknown session", async () => {
    const result = await handlers["GET /api/sessions/:id"]({ params: { id: "unknown" }, query: {} });
    expect(result.status).toBe(404);
  });

  it("POST /api/tasks should enqueue a task", async () => {
    const result = await handlers["POST /api/tasks"]({
      params: {},
      query: {},
      body: { title: "Test task", description: "Do the thing", labels: ["test"] },
    });
    expect(result.status).toBe(201);
    const body = result.body as Record<string, unknown>;
    expect(body.title).toBe("Test task");
    expect(body.status).toBe("queued");
    expect(mockOrch.enqueueTask).toHaveBeenCalledTimes(1);
  });

  it("POST /api/tasks should reject missing title", async () => {
    const result = await handlers["POST /api/tasks"]({
      params: {},
      query: {},
      body: { description: "no title" },
    });
    expect(result.status).toBe(400);
  });

  it("GET /api/events should return event history", async () => {
    const result = await handlers["GET /api/events"]({ params: {}, query: {} });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect((body.events as unknown[]).length).toBe(3);
  });

  it("GET /api/events should filter by type prefix", async () => {
    const result = await handlers["GET /api/events"]({ params: {}, query: { type: "agent" } });
    const body = result.body as Record<string, unknown>;
    expect((body.events as unknown[]).length).toBe(2);
  });

  it("GET /api/providers should return provider info", async () => {
    const result = await handlers["GET /api/providers"]({ params: {}, query: {} });
    expect(result.status).toBe(200);
    const body = result.body as { providers: Record<string, Record<string, unknown>> };
    expect(body.providers["coder"].healthy).toBe(true);
    expect(body.providers["fast"].healthy).toBe(false);
  });

  it("GET /api/metrics should return aggregate metrics", async () => {
    const result = await handlers["GET /api/metrics"]({ params: {}, query: {} });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, Record<string, unknown>>;
    expect(body.sessions.total).toBe(2);
    expect(body.sessions.completed).toBe(1);
    expect(body.sessions.running).toBe(1);
    expect(body.tokens.total).toBe(2200); // 1500 + 700
  });

  it("GET /api/metrics/prometheus should return prometheus format", async () => {
    const result = await handlers["GET /api/metrics/prometheus"]({ params: {}, query: {} });
    expect(result.status).toBe(200);
    const body = result.body as string;
    expect(body).toContain("foreman_sessions_total 2");
    expect(body).toContain("foreman_tokens_total 2200");
    expect(body).toContain("foreman_sessions_active 1");
  });

  it("GET /api/knowledge should return KB summary", async () => {
    const result = await handlers["GET /api/knowledge"]({ params: {}, query: {} });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect(body.lessonsCount).toBe(1);
    expect(body.seenFindingsCount).toBe(2);
  });

  it("POST /api/knowledge/learn should record user lesson", async () => {
    const result = await handlers["POST /api/knowledge/learn"]({
      params: {},
      query: {},
      body: { summary: "Use vitest", detail: "Not jest", tags: ["testing"] },
    });
    expect(result.status).toBe(201);
    expect(mockOrch.getKnowledgeStore().learnFromUser).toHaveBeenCalledWith(
      "Use vitest",
      "Not jest",
      ["testing"]
    );
  });

  it("POST /api/knowledge/learn should reject missing summary", async () => {
    const result = await handlers["POST /api/knowledge/learn"]({
      params: {},
      query: {},
      body: { detail: "no summary" },
    });
    expect(result.status).toBe(400);
  });

  it("GET /api/skills should return skills list", async () => {
    const result = await handlers["GET /api/skills"]({ params: {}, query: {} });
    expect(result.status).toBe(200);
    const body = result.body as { skills: unknown[] };
    expect(body.skills.length).toBe(2);
  });

  it("GET /api/autopilot/runs should return run history", async () => {
    const result = await handlers["GET /api/autopilot/runs"]({ params: {}, query: {} });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    expect((body.runs as unknown[]).length).toBe(1);
    expect(body.activeRun).toBeNull();
  });

  it("POST /api/autopilot/trigger should trigger a run", async () => {
    const result = await handlers["POST /api/autopilot/trigger"]({ params: {}, query: {} });
    expect(result.status).toBe(200);
    const body = result.body as { run: Record<string, unknown> };
    expect(body.run.status).toBe("completed");
    expect(body.run.findings).toBe(1);
  });

  it("GET /api/config should return redacted config", async () => {
    const result = await handlers["GET /api/config"]({ params: {}, query: {} });
    expect(result.status).toBe(200);
    const body = result.body as Record<string, unknown>;
    const models = body.models as Record<string, Record<string, unknown>>;
    // API key should be redacted
    expect(models.fast.apiKey).toBe("***");
    expect(models.coder.apiKey).toBeUndefined();
  });
});

// ── Integration: full API server ─────────────────────────────────

describe("ApiServer integration", () => {
  let server: ApiServer;
  let port: number;
  let mockOrch: ReturnType<typeof createMockOrchestrator>;

  beforeEach(async () => {
    mockOrch = createMockOrchestrator();

    // Add getEventBus mock
    const listeners: Array<(event: unknown) => void> = [];
    (mockOrch as any).getEventBus = () => ({
      onAny: (fn: (event: unknown) => void) => listeners.push(fn),
    });

    server = new ApiServer({
      orchestrator: mockOrch as any,
      config: { port: 0, host: "127.0.0.1" }, // port 0 = random free port
      logger: mockOrch.getLogger() as any,
    });

    await server.start();
    port = server.getPort();
  });

  afterEach(async () => {
    await server.stop();
  });

  async function fetch(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const data = options.body ? JSON.stringify(options.body) : undefined;
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method: options.method ?? "GET",
          headers: {
            "Content-Type": "application/json",
            ...options.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            let body: unknown;
            try {
              body = JSON.parse(raw);
            } catch {
              body = raw;
            }
            resolve({ status: res.statusCode ?? 0, body });
          });
        }
      );

      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  it("should respond to GET /api/health", async () => {
    const { status, body } = await fetch("/api/health");
    expect(status).toBe(200);
    expect((body as Record<string, unknown>).status).toBe("ok");
  });

  it("should respond to GET /api/sessions", async () => {
    const { status, body } = await fetch("/api/sessions");
    expect(status).toBe(200);
    expect((body as Record<string, unknown>).total).toBe(2);
  });

  it("should respond to POST /api/tasks", async () => {
    const { status, body } = await fetch("/api/tasks", {
      method: "POST",
      body: { title: "API test task", description: "test" },
    });
    expect(status).toBe(201);
    expect((body as Record<string, unknown>).status).toBe("queued");
  });

  it("should return 404 for unknown routes", async () => {
    const { status } = await fetch("/api/nonexistent");
    expect(status).toBe(404);
  });

  it("should handle CORS preflight", async () => {
    const { status } = await fetch("/api/health", { method: "OPTIONS" });
    expect(status).toBe(204);
  });

  it("should respond to GET /api/metrics", async () => {
    const { status, body } = await fetch("/api/metrics");
    expect(status).toBe(200);
    const b = body as Record<string, Record<string, unknown>>;
    expect(b.sessions.total).toBe(2);
  });

  it("should respond to GET /api/providers", async () => {
    const { status, body } = await fetch("/api/providers");
    expect(status).toBe(200);
    const b = body as { providers: Record<string, unknown> };
    expect(b.providers["coder"]).toBeDefined();
  });
});

// ── API Server with auth ─────────────────────────────────────────

describe("ApiServer with auth", () => {
  let server: ApiServer;
  let port: number;
  let mockOrch: ReturnType<typeof createMockOrchestrator>;

  beforeEach(async () => {
    mockOrch = createMockOrchestrator();
    const listeners: Array<(event: unknown) => void> = [];
    (mockOrch as any).getEventBus = () => ({
      onAny: (fn: (event: unknown) => void) => listeners.push(fn),
    });

    server = new ApiServer({
      orchestrator: mockOrch as any,
      config: { port: 0, host: "127.0.0.1", apiKey: "secret-key-42" },
      logger: mockOrch.getLogger() as any,
    });

    await server.start();
    port = server.getPort();
  });

  afterEach(async () => {
    await server.stop();
  });

  async function fetch(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port, path, method: "GET", headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
            });
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("should reject requests without auth", async () => {
    const { status, body } = await fetch("/api/health");
    expect(status).toBe(401);
    expect((body as Record<string, unknown>).error).toBe("Unauthorized");
  });

  it("should accept requests with valid Bearer token", async () => {
    const { status } = await fetch("/api/health", { Authorization: "Bearer secret-key-42" });
    expect(status).toBe(200);
  });

  it("should accept requests with valid query param key", async () => {
    const { status } = await fetch("/api/health?key=secret-key-42");
    expect(status).toBe(200);
  });

  it("should reject requests with wrong key", async () => {
    const { status } = await fetch("/api/health", { Authorization: "Bearer wrong-key" });
    expect(status).toBe(401);
  });
});
