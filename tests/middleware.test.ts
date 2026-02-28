import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  authMiddleware,
  corsMiddleware,
  securityHeaders,
  RateLimiter,
} from "../src/api/middleware.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiConfig } from "../src/api/middleware.js";

/** Create a minimal fake IncomingMessage. */
function fakeReq(options: {
  headers?: Record<string, string | undefined>;
  url?: string;
} = {}): IncomingMessage {
  return {
    headers: options.headers ?? {},
    url: options.url ?? "/",
  } as unknown as IncomingMessage;
}

/** Create a minimal fake ServerResponse that records setHeader calls. */
function fakeRes(): ServerResponse & { _headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    _headers: headers,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  } as unknown as ServerResponse & { _headers: Record<string, string> };
}

// ─── authMiddleware ─────────────────────────────────────────────

describe("authMiddleware", () => {
  it("allows all requests when no apiKey is configured", () => {
    const req = fakeReq();
    const config: ApiConfig = {};
    expect(authMiddleware(req, config)).toBe(true);
  });

  it("accepts a valid Bearer token in the Authorization header", () => {
    const config: ApiConfig = { apiKey: "secret-key-123" };
    const req = fakeReq({
      headers: { authorization: "Bearer secret-key-123" },
    });
    expect(authMiddleware(req, config)).toBe(true);
  });

  it("accepts a valid Bearer token with case-insensitive Bearer prefix", () => {
    const config: ApiConfig = { apiKey: "secret-key-123" };
    const req = fakeReq({
      headers: { authorization: "bearer secret-key-123" },
    });
    expect(authMiddleware(req, config)).toBe(true);
  });

  it("rejects an invalid Bearer token", () => {
    const config: ApiConfig = { apiKey: "secret-key-123" };
    const req = fakeReq({
      headers: { authorization: "Bearer wrong-key" },
    });
    expect(authMiddleware(req, config)).toBe(false);
  });

  it("rejects when the key differs by a single character", () => {
    const config: ApiConfig = { apiKey: "secret-key-123" };
    const req = fakeReq({
      headers: { authorization: "Bearer secret-key-124" },
    });
    expect(authMiddleware(req, config)).toBe(false);
  });

  it("rejects when the token has a different length than the apiKey", () => {
    const config: ApiConfig = { apiKey: "short" };
    const req = fakeReq({
      headers: { authorization: "Bearer much-longer-token" },
    });
    expect(authMiddleware(req, config)).toBe(false);
  });

  it("accepts a valid key in the query param", () => {
    const config: ApiConfig = { apiKey: "my-api-key" };
    const req = fakeReq({
      url: "/status?key=my-api-key",
      headers: { host: "localhost:4820" },
    });
    expect(authMiddleware(req, config)).toBe(true);
  });

  it("rejects an invalid key in the query param", () => {
    const config: ApiConfig = { apiKey: "my-api-key" };
    const req = fakeReq({
      url: "/status?key=bad-key-here",
      headers: { host: "localhost:4820" },
    });
    expect(authMiddleware(req, config)).toBe(false);
  });

  it("rejects when no authorization header or query param is provided", () => {
    const config: ApiConfig = { apiKey: "my-api-key" };
    const req = fakeReq({ url: "/status", headers: { host: "localhost" } });
    expect(authMiddleware(req, config)).toBe(false);
  });

  it("prefers Authorization header over query param (both valid)", () => {
    const config: ApiConfig = { apiKey: "correct-key" };
    const req = fakeReq({
      url: "/status?key=correct-key",
      headers: {
        authorization: "Bearer correct-key",
        host: "localhost",
      },
    });
    expect(authMiddleware(req, config)).toBe(true);
  });

  it("falls through to query param when Authorization header is invalid", () => {
    const config: ApiConfig = { apiKey: "correct-key" };
    const req = fakeReq({
      url: "/status?key=correct-key",
      headers: {
        authorization: "Bearer wrong-key-here",
        host: "localhost",
      },
    });
    // The header check fails (different length / value), but the query param succeeds
    expect(authMiddleware(req, config)).toBe(true);
  });
});

// ─── corsMiddleware ─────────────────────────────────────────────

describe("corsMiddleware", () => {
  it("sets wildcard origin when corsOrigins is not configured", () => {
    const req = fakeReq();
    const res = fakeRes();
    const config: ApiConfig = {};

    corsMiddleware(req, res, config);

    expect(res._headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("sets wildcard origin when corsOrigins includes '*'", () => {
    const req = fakeReq({ headers: { origin: "https://example.com" } });
    const res = fakeRes();
    const config: ApiConfig = { corsOrigins: ["*"] };

    corsMiddleware(req, res, config);

    expect(res._headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("echoes back a matching specific origin", () => {
    const req = fakeReq({ headers: { origin: "https://myapp.com" } });
    const res = fakeRes();
    const config: ApiConfig = { corsOrigins: ["https://myapp.com", "https://other.com"] };

    corsMiddleware(req, res, config);

    expect(res._headers["Access-Control-Allow-Origin"]).toBe("https://myapp.com");
  });

  it("does not set Allow-Origin when origin is not in the allowed list", () => {
    const req = fakeReq({ headers: { origin: "https://evil.com" } });
    const res = fakeRes();
    const config: ApiConfig = { corsOrigins: ["https://myapp.com"] };

    corsMiddleware(req, res, config);

    expect(res._headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("sets Allow-Methods header", () => {
    const req = fakeReq();
    const res = fakeRes();
    corsMiddleware(req, res, {});

    expect(res._headers["Access-Control-Allow-Methods"]).toBe("GET, POST, OPTIONS");
  });

  it("sets Allow-Headers header", () => {
    const req = fakeReq();
    const res = fakeRes();
    corsMiddleware(req, res, {});

    expect(res._headers["Access-Control-Allow-Headers"]).toBe("Content-Type, Authorization");
  });

  it("sets Max-Age header to 86400", () => {
    const req = fakeReq();
    const res = fakeRes();
    corsMiddleware(req, res, {});

    expect(res._headers["Access-Control-Max-Age"]).toBe("86400");
  });
});

// ─── securityHeaders ────────────────────────────────────────────

describe("securityHeaders", () => {
  it("sets X-Content-Type-Options to nosniff", () => {
    const res = fakeRes();
    securityHeaders(res);
    expect(res._headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("sets X-Frame-Options to DENY", () => {
    const res = fakeRes();
    securityHeaders(res);
    expect(res._headers["X-Frame-Options"]).toBe("DENY");
  });

  it("sets X-XSS-Protection to 0", () => {
    const res = fakeRes();
    securityHeaders(res);
    expect(res._headers["X-XSS-Protection"]).toBe("0");
  });

  it("sets Referrer-Policy to strict-origin-when-cross-origin", () => {
    const res = fakeRes();
    securityHeaders(res);
    expect(res._headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("sets Content-Security-Policy", () => {
    const res = fakeRes();
    securityHeaders(res);
    expect(res._headers["Content-Security-Policy"]).toBe(
      "default-src 'none'; frame-ancestors 'none'"
    );
  });

  it("sets all five security headers at once", () => {
    const res = fakeRes();
    securityHeaders(res);

    const expectedHeaders = [
      "X-Content-Type-Options",
      "X-Frame-Options",
      "X-XSS-Protection",
      "Referrer-Policy",
      "Content-Security-Policy",
    ];

    for (const header of expectedHeaders) {
      expect(res._headers[header]).toBeDefined();
    }
  });
});

// ─── RateLimiter ────────────────────────────────────────────────

describe("RateLimiter", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(5);
  });

  afterEach(() => {
    limiter.destroy();
  });

  it("allows requests within the limit", () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("192.168.1.1")).toBe(true);
    }
  });

  it("blocks requests exceeding the limit", () => {
    for (let i = 0; i < 5; i++) {
      limiter.check("192.168.1.1");
    }
    expect(limiter.check("192.168.1.1")).toBe(false);
  });

  it("tracks different IPs independently", () => {
    for (let i = 0; i < 5; i++) {
      limiter.check("10.0.0.1");
    }
    // 10.0.0.1 is exhausted
    expect(limiter.check("10.0.0.1")).toBe(false);
    // 10.0.0.2 still has full quota
    expect(limiter.check("10.0.0.2")).toBe(true);
  });

  it("reports correct remaining count", () => {
    expect(limiter.remaining("10.0.0.1")).toBe(5);

    limiter.check("10.0.0.1");
    limiter.check("10.0.0.1");

    expect(limiter.remaining("10.0.0.1")).toBe(3);
  });

  it("reports full remaining count for an unknown IP", () => {
    expect(limiter.remaining("unknown-ip")).toBe(5);
  });

  it("reports 0 remaining when limit is exhausted", () => {
    for (let i = 0; i < 5; i++) {
      limiter.check("10.0.0.1");
    }
    expect(limiter.remaining("10.0.0.1")).toBe(0);
  });

  it("resets after the window expires", () => {
    // Use fake timers to control Date.now
    vi.useFakeTimers();

    const timedLimiter = new RateLimiter(2);
    try {
      timedLimiter.check("1.2.3.4");
      timedLimiter.check("1.2.3.4");
      expect(timedLimiter.check("1.2.3.4")).toBe(false);

      // Advance past the 60-second window
      vi.advanceTimersByTime(61_000);

      expect(timedLimiter.check("1.2.3.4")).toBe(true);
    } finally {
      timedLimiter.destroy();
      vi.useRealTimers();
    }
  });

  describe("cleanup", () => {
    it("removes expired entries", () => {
      vi.useFakeTimers();

      const cleanLimiter = new RateLimiter(10);
      try {
        cleanLimiter.check("expired-ip");

        // Advance past the window so the entry expires
        vi.advanceTimersByTime(61_000);

        cleanLimiter.cleanup();

        // After cleanup, remaining should be full (entry was removed)
        expect(cleanLimiter.remaining("expired-ip")).toBe(10);
      } finally {
        cleanLimiter.destroy();
        vi.useRealTimers();
      }
    });

    it("keeps non-expired entries", () => {
      vi.useFakeTimers();

      const cleanLimiter = new RateLimiter(10);
      try {
        cleanLimiter.check("active-ip");
        cleanLimiter.check("active-ip");
        cleanLimiter.check("active-ip");

        // Only 30 seconds — still within the window
        vi.advanceTimersByTime(30_000);

        cleanLimiter.cleanup();

        // Entry should still be there; 7 remaining
        expect(cleanLimiter.remaining("active-ip")).toBe(7);
      } finally {
        cleanLimiter.destroy();
        vi.useRealTimers();
      }
    });
  });

  describe("destroy", () => {
    it("stops the cleanup timer", () => {
      vi.useFakeTimers();

      const destroyLimiter = new RateLimiter(10);
      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

      destroyLimiter.destroy();

      expect(clearIntervalSpy).toHaveBeenCalled();

      clearIntervalSpy.mockRestore();
      vi.useRealTimers();
    });

    it("can be called multiple times without error", () => {
      const destroyLimiter = new RateLimiter(10);
      destroyLimiter.destroy();
      destroyLimiter.destroy(); // second call should be harmless
    });
  });
});
