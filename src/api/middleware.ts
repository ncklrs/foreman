/**
 * API middleware — authentication, CORS, and rate limiting.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface ApiConfig {
  /** Port to listen on. Default: 4820. */
  port?: number;
  /** Host to bind to. Default: "127.0.0.1" (localhost only). */
  host?: string;
  /** API key for authentication. If not set, auth is disabled. */
  apiKey?: string;
  /** Allowed CORS origins. Default: ["*"]. */
  corsOrigins?: string[];
  /** Enable rate limiting. Default: true. */
  rateLimit?: boolean;
  /** Requests per minute per IP. Default: 120. */
  rateLimitRpm?: number;
}

/** Validate API key from Authorization header or query param. */
export function authMiddleware(req: IncomingMessage, config: ApiConfig): boolean {
  // No API key configured — allow all
  if (!config.apiKey) return true;

  // Check Authorization header
  const authHeader = req.headers["authorization"];
  if (authHeader) {
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (token === config.apiKey) return true;
  }

  // Check query param
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const keyParam = url.searchParams.get("key");
  if (keyParam === config.apiKey) return true;

  return false;
}

/** Set CORS headers. */
export function corsMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  config: ApiConfig
): void {
  const allowedOrigins = config.corsOrigins ?? ["*"];
  const requestOrigin = req.headers["origin"];

  if (allowedOrigins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    res.setHeader("Access-Control-Allow-Origin", requestOrigin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

/**
 * In-memory rate limiter.
 * Tracks request counts per IP with sliding window.
 */
export class RateLimiter {
  private windows: Map<string, { count: number; resetAt: number }> = new Map();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequestsPerMinute = 120) {
    this.maxRequests = maxRequestsPerMinute;
    this.windowMs = 60_000;
  }

  /** Check if request is allowed. Returns true if allowed. */
  check(ip: string): boolean {
    const now = Date.now();
    const entry = this.windows.get(ip);

    if (!entry || now > entry.resetAt) {
      this.windows.set(ip, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    if (entry.count >= this.maxRequests) {
      return false;
    }

    entry.count++;
    return true;
  }

  /** Get remaining requests for an IP. */
  remaining(ip: string): number {
    const entry = this.windows.get(ip);
    if (!entry || Date.now() > entry.resetAt) return this.maxRequests;
    return Math.max(0, this.maxRequests - entry.count);
  }

  /** Clean up expired entries. */
  cleanup(): void {
    const now = Date.now();
    for (const [ip, entry] of this.windows) {
      if (now > entry.resetAt) {
        this.windows.delete(ip);
      }
    }
  }
}
