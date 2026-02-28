/**
 * REST API request handlers.
 * Each handler maps to a specific API endpoint.
 */

import type { Orchestrator } from "../orchestrator.js";
import type { Logger } from "../logging/logger.js";
import type { HandlerMap, RouteResult } from "./router.js";
import type { HookHandler } from "../hooks/handler.js";
import type { HookPayload } from "../hooks/types.js";
import { pathToEvent } from "../hooks/config.js";
import { generateId } from "../utils/id.js";

/** Compute session status counts from a list of sessions. */
function getSessionCounts(sessions: Array<{ status: string }>) {
  let completed = 0;
  let failed = 0;
  let running = 0;
  for (const s of sessions) {
    if (s.status === "completed") completed++;
    else if (s.status === "failed") failed++;
    else if (s.status === "running") running++;
  }
  return { completed, failed, running };
}

export function buildHandlers(orchestrator: Orchestrator, logger: Logger): HandlerMap {
  return {
    // ── Health ──────────────────────────────────────────────
    "GET /api/health": () => {
      const health = orchestrator.getProviderHealth();
      const providers: Record<string, unknown> = {};
      for (const [key, h] of health) {
        providers[key] = {
          healthy: h.healthy,
          latencyMs: h.latencyMs,
          lastChecked: h.lastChecked,
        };
      }

      return {
        status: 200,
        body: {
          status: "ok",
          uptime: process.uptime(),
          providers,
          activeSessions: orchestrator.getSessions().filter((s) => s.status === "running").length,
          totalSessions: orchestrator.getSessions().length,
        },
      };
    },

    // ── Sessions ────────────────────────────────────────────
    "GET /api/sessions": ({ query }) => {
      let sessions = orchestrator.getSessions();

      // Filter by status
      if (query.status) {
        sessions = sessions.filter((s) => s.status === query.status);
      }

      // Limit
      const limit = query.limit ? parseInt(query.limit) : 50;
      const offset = query.offset ? parseInt(query.offset) : 0;
      const total = sessions.length;
      sessions = sessions.slice(offset, offset + limit);

      return {
        status: 200,
        body: {
          sessions: sessions.map(summarizeSession),
          total,
          limit,
          offset,
        },
      };
    },

    "GET /api/sessions/:id": ({ params }) => {
      const session = orchestrator.getSessions().find((s) => s.id === params.id);
      if (!session) {
        return { status: 404, body: { error: "Session not found", id: params.id } };
      }

      return {
        status: 200,
        body: {
          ...session,
          // Include full messages for detail view
          messageCount: session.messages.length,
        },
      };
    },

    // ── Tasks ───────────────────────────────────────────────
    "POST /api/tasks": ({ body }) => {
      const data = body as Record<string, unknown> | undefined;
      if (!data?.title) {
        return { status: 400, body: { error: "Missing required field: title" } };
      }

      const task = {
        id: generateId("api"),
        title: String(data.title),
        description: String(data.description ?? data.title),
        repository: data.repository ? String(data.repository) : undefined,
        branch: data.branch ? String(data.branch) : undefined,
        labels: Array.isArray(data.labels) ? data.labels.map(String) : undefined,
        assignedModel: data.model ? String(data.model) : undefined,
      };

      orchestrator.enqueueTask(task, "api");
      logger.info(`Task enqueued via API: ${task.title}`, { id: task.id });

      return {
        status: 201,
        body: { id: task.id, title: task.title, status: "queued" },
      };
    },

    // ── Events ──────────────────────────────────────────────
    "GET /api/events": ({ query }) => {
      let events = orchestrator.getEvents();

      // Filter by type prefix
      if (query.type) {
        events = events.filter((e) => e.type.startsWith(query.type));
      }

      const limit = query.limit ? parseInt(query.limit) : 100;
      const total = events.length;
      events = events.slice(-limit);

      return {
        status: 200,
        body: { events, total, limit },
      };
    },

    // ── Providers ───────────────────────────────────────────
    "GET /api/providers": () => {
      const health = orchestrator.getProviderHealth();
      const config = orchestrator.getConfig();
      const providers: Record<string, unknown> = {};

      for (const [key, model] of Object.entries(config.models)) {
        const h = health.get(key);
        providers[key] = {
          provider: model.provider,
          model: model.model,
          role: model.role,
          healthy: h?.healthy ?? false,
          latencyMs: h?.latencyMs ?? null,
        };
      }

      return { status: 200, body: { providers } };
    },

    // ── Metrics ─────────────────────────────────────────────
    "GET /api/metrics": () => {
      const stats = orchestrator.getPerformanceStats();
      const sessions = orchestrator.getSessions();

      const totalTokens = sessions.reduce(
        (sum, s) => sum + s.tokenUsage.inputTokens + s.tokenUsage.outputTokens,
        0
      );

      const counts = getSessionCounts(sessions);

      return {
        status: 200,
        body: {
          sessions: { total: sessions.length, ...counts },
          tokens: { total: totalTokens },
          models: stats,
          uptime: process.uptime(),
        },
      };
    },

    // ── Prometheus-compatible metrics ───────────────────────
    "GET /api/metrics/prometheus": () => {
      const sessions = orchestrator.getSessions();
      const totalTokens = sessions.reduce(
        (sum, s) => sum + s.tokenUsage.inputTokens + s.tokenUsage.outputTokens,
        0
      );

      const { completed, failed, running } = getSessionCounts(sessions);

      const lines = [
        "# HELP foreman_sessions_total Total number of agent sessions",
        "# TYPE foreman_sessions_total counter",
        `foreman_sessions_total ${sessions.length}`,
        "# HELP foreman_sessions_completed_total Completed sessions",
        "# TYPE foreman_sessions_completed_total counter",
        `foreman_sessions_completed_total ${completed}`,
        "# HELP foreman_sessions_failed_total Failed sessions",
        "# TYPE foreman_sessions_failed_total counter",
        `foreman_sessions_failed_total ${failed}`,
        "# HELP foreman_sessions_active Currently running sessions",
        "# TYPE foreman_sessions_active gauge",
        `foreman_sessions_active ${running}`,
        "# HELP foreman_tokens_total Total tokens consumed",
        "# TYPE foreman_tokens_total counter",
        `foreman_tokens_total ${totalTokens}`,
        "# HELP foreman_uptime_seconds Process uptime",
        "# TYPE foreman_uptime_seconds gauge",
        `foreman_uptime_seconds ${Math.floor(process.uptime())}`,
      ];

      return {
        status: 200,
        body: lines.join("\n") + "\n",
      };
    },

    // ── Knowledge ───────────────────────────────────────────
    "GET /api/knowledge": () => {
      const kb = orchestrator.getKnowledgeStore().getKnowledgeBase();
      return {
        status: 200,
        body: {
          version: kb.version,
          lessonsCount: kb.lessons.length,
          failurePatternsCount: kb.failurePatterns.length,
          seenFindingsCount: kb.seenFindings.length,
          modelPreferences: kb.modelPreferences,
          updatedAt: kb.updatedAt,
        },
      };
    },

    "GET /api/knowledge/lessons": ({ query }) => {
      const kb = orchestrator.getKnowledgeStore().getKnowledgeBase();
      let lessons = kb.lessons;

      if (query.type) {
        lessons = lessons.filter((l) => l.type === query.type);
      }

      const limit = query.limit ? parseInt(query.limit) : 50;
      return {
        status: 200,
        body: { lessons: lessons.slice(0, limit), total: lessons.length },
      };
    },

    "POST /api/knowledge/learn": ({ body }) => {
      const data = body as Record<string, unknown> | undefined;
      if (!data?.summary) {
        return { status: 400, body: { error: "Missing required field: summary" } };
      }

      orchestrator.getKnowledgeStore().learnFromUser(
        String(data.summary),
        String(data.detail ?? ""),
        Array.isArray(data.tags) ? data.tags.map(String) : []
      );

      return {
        status: 201,
        body: { message: "Lesson recorded" },
      };
    },

    // ── Skills ──────────────────────────────────────────────
    "GET /api/skills": () => {
      const skills = orchestrator.getSkillsRegistry().getAll();
      return {
        status: 200,
        body: {
          skills: skills.map((s) => ({
            name: s.name,
            description: s.description,
            triggers: s.triggers,
            tags: s.tags,
            source: s.source,
          })),
        },
      };
    },

    // ── Autopilot ───────────────────────────────────────────
    "GET /api/autopilot/runs": () => {
      const engine = orchestrator.getAutopilotEngine();
      if (!engine) {
        return { status: 200, body: { runs: [], message: "Autopilot not configured" } };
      }

      return {
        status: 200,
        body: { runs: engine.getRuns(), activeRun: engine.getActiveRun() },
      };
    },

    "POST /api/autopilot/trigger": async () => {
      const engine = orchestrator.getAutopilotEngine();
      if (!engine) {
        return { status: 400, body: { error: "Autopilot not configured" } };
      }

      logger.info("Autopilot run triggered via API");
      const run = await engine.triggerRun();

      return {
        status: 200,
        body: {
          run: {
            id: run.id,
            status: run.status,
            findings: run.findings.length,
            ticketsCreated: run.ticketsCreated.length,
          },
        },
      };
    },

    // ── Config (read-only) ──────────────────────────────────
    "GET /api/config": () => {
      const config = orchestrator.getConfig();
      // Redact sensitive values
      const safeConfig = {
        foreman: config.foreman,
        models: Object.fromEntries(
          Object.entries(config.models).map(([k, v]) => [
            k,
            { ...v, apiKey: v.apiKey ? "***" : undefined },
          ])
        ),
        routing: config.routing,
        sandbox: { type: config.sandbox.type, warmPool: config.sandbox.warmPool },
        policy: config.policy,
        autopilot: config.autopilot
          ? {
              enabled: config.autopilot.enabled,
              schedule: config.autopilot.schedule,
              scanners: config.autopilot.scanners,
              autoResolve: config.autopilot.autoResolve,
            }
          : null,
      };

      return { status: 200, body: safeConfig };
    },
  };
}

/**
 * Build hook-specific API routes.
 * These handle Claude Code's HTTP hook protocol.
 */
export function buildHookHandlers(hookHandler: HookHandler, logger: Logger): HandlerMap {
  return {
    // ── Generic hook endpoint ────────────────────────────────
    "POST /api/hooks/:event": async ({ params, body }) => {
      const eventName = pathToEvent(params.event);
      if (!eventName) {
        return {
          status: 400,
          body: { error: `Unknown hook event: ${params.event}` },
        };
      }

      const data = body as Record<string, unknown> | undefined;
      if (!data) {
        return {
          status: 400,
          body: { error: "Missing request body" },
        };
      }

      // Ensure the type field matches the path
      const payload: HookPayload = {
        ...data,
        type: eventName,
        session_id: String(data.session_id ?? `anon_${Date.now()}`),
      } as HookPayload;

      const response = await hookHandler.handle(payload);

      return {
        status: 200,
        body: response,
      };
    },

    // ── Hook sessions ────────────────────────────────────────
    "GET /api/hooks/sessions": () => {
      const sessions = hookHandler.getSessions();
      return {
        status: 200,
        body: {
          sessions: sessions.map((s) => ({
            sessionId: s.sessionId,
            model: s.model,
            cwd: s.cwd,
            toolCalls: s.toolCalls,
            deniedCalls: s.deniedCalls,
            startedAt: s.startedAt,
            tokens: s.usage.inputTokens + s.usage.outputTokens,
          })),
          count: sessions.length,
        },
      };
    },

    // ── Hook session detail ──────────────────────────────────
    "GET /api/hooks/sessions/:id": ({ params }) => {
      const session = hookHandler.getSession(params.id);
      if (!session) {
        return { status: 404, body: { error: "Hook session not found", id: params.id } };
      }

      return {
        status: 200,
        body: {
          ...session,
          recentTools: session.toolHistory.slice(-20).map((t) => ({
            tool: t.tool,
            error: t.error,
            durationMs: t.durationMs,
            denied: t.denied,
            timestamp: t.timestamp,
          })),
        },
      };
    },
  };
}

/** Summarize a session for list views (omit full messages). */
function summarizeSession(session: {
  id: string;
  task: { id: string; title: string; labels?: string[] };
  status: string;
  modelName: string;
  iterations: number;
  tokenUsage: { inputTokens: number; outputTokens: number };
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}) {
  return {
    id: session.id,
    taskId: session.task.id,
    taskTitle: session.task.title,
    labels: session.task.labels,
    status: session.status,
    model: session.modelName,
    iterations: session.iterations,
    tokens: session.tokenUsage.inputTokens + session.tokenUsage.outputTokens,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    error: session.error,
  };
}
