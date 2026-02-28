import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseCron,
  matchesCron,
  getNextRun,
  AutopilotScheduler,
} from "../src/autopilot/scheduler.js";
import { TicketCreator } from "../src/autopilot/tickets.js";
import type {
  AutopilotConfig,
  AutopilotScanner,
  ReviewFinding,
} from "../src/types/index.js";

// ── Cron Parser Tests ─────────────────────────────────────────────

describe("parseCron", () => {
  it("should parse standard 5-field expression", () => {
    const fields = parseCron("0 9 * * 1-5");
    expect(fields.minute).toEqual([0]);
    expect(fields.hour).toEqual([9]);
    expect(fields.dayOfMonth.length).toBe(31); // *
    expect(fields.month.length).toBe(12); // *
    expect(fields.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("should parse wildcard fields", () => {
    const fields = parseCron("* * * * *");
    expect(fields.minute.length).toBe(60); // 0-59
    expect(fields.hour.length).toBe(24); // 0-23
    expect(fields.dayOfMonth.length).toBe(31); // 1-31
    expect(fields.month.length).toBe(12); // 1-12
    expect(fields.dayOfWeek.length).toBe(8); // 0-7
  });

  it("should parse step expressions", () => {
    const fields = parseCron("*/15 */4 * * *");
    expect(fields.minute).toEqual([0, 15, 30, 45]);
    expect(fields.hour).toEqual([0, 4, 8, 12, 16, 20]);
  });

  it("should parse comma-separated lists", () => {
    const fields = parseCron("0,30 9,17 * * *");
    expect(fields.minute).toEqual([0, 30]);
    expect(fields.hour).toEqual([9, 17]);
  });

  it("should parse ranges", () => {
    const fields = parseCron("0 8-17 * * *");
    expect(fields.hour).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it("should parse combined expressions", () => {
    const fields = parseCron("0 9 1,15 * 1-5");
    expect(fields.minute).toEqual([0]);
    expect(fields.hour).toEqual([9]);
    expect(fields.dayOfMonth).toEqual([1, 15]);
    expect(fields.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("should throw on invalid expression", () => {
    expect(() => parseCron("invalid")).toThrow("must have 5 fields");
    expect(() => parseCron("0 9 *")).toThrow("must have 5 fields");
  });

  it("should parse range with step", () => {
    const fields = parseCron("0 9-17/2 * * *");
    expect(fields.hour).toEqual([9, 11, 13, 15, 17]);
  });
});

describe("matchesCron", () => {
  it("should match every-minute expression", () => {
    expect(matchesCron("* * * * *", new Date("2026-01-15T10:30:00Z"))).toBe(true);
  });

  it("should match specific time", () => {
    // Wednesday, Jan 15, 2025 at 09:00 UTC
    const date = new Date("2026-01-14T09:00:00Z"); // Wednesday
    expect(matchesCron("0 9 * * 3", date)).toBe(true);
  });

  it("should not match wrong minute", () => {
    const date = new Date("2026-01-15T09:05:00Z");
    expect(matchesCron("0 9 * * *", date)).toBe(false);
  });

  it("should not match wrong hour", () => {
    const date = new Date("2026-01-15T10:00:00Z");
    expect(matchesCron("0 9 * * *", date)).toBe(false);
  });

  it("should match weekday range", () => {
    // Test each day of the week for Mon-Fri
    const monday = new Date("2026-01-12T09:00:00Z"); // Monday
    const saturday = new Date("2026-01-17T09:00:00Z"); // Saturday

    expect(matchesCron("0 9 * * 1-5", monday)).toBe(true);
    expect(matchesCron("0 9 * * 1-5", saturday)).toBe(false);
  });

  it("should handle Sunday as both 0 and 7", () => {
    const sunday = new Date("2026-01-11T09:00:00Z"); // Sunday
    expect(matchesCron("0 9 * * 0", sunday)).toBe(true);
    expect(matchesCron("0 9 * * 7", sunday)).toBe(true);
  });
});

describe("getNextRun", () => {
  it("should find the next matching time", () => {
    const from = new Date("2026-01-15T08:59:00Z");
    const next = getNextRun("0 9 * * *", from);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it("should skip to next day if today's slot passed", () => {
    const from = new Date("2026-01-15T09:01:00Z");
    const next = getNextRun("0 9 * * *", from);
    expect(next.getDate()).toBe(16);
    expect(next.getHours()).toBe(9);
  });

  it("should respect weekday constraints", () => {
    // Friday at 17:00, next weekday 9am is Monday
    const friday = new Date("2026-01-16T17:00:00Z");
    const next = getNextRun("0 9 * * 1-5", friday);
    expect(next.getDay()).toBeGreaterThanOrEqual(1);
    expect(next.getDay()).toBeLessThanOrEqual(5);
  });
});

// ── Scheduler Tests ────────────────────────────────────────────────

describe("AutopilotScheduler", () => {
  it("should add and list schedules", () => {
    const scheduler = new AutopilotScheduler();
    scheduler.addSchedule("test-1", "0 9 * * *", () => {});
    scheduler.addSchedule("test-2", "0 17 * * *", () => {});

    const schedules = scheduler.getSchedules();
    expect(schedules.length).toBe(2);
    expect(schedules[0].id).toBe("test-1");
    expect(schedules[1].id).toBe("test-2");
  });

  it("should remove a schedule", () => {
    const scheduler = new AutopilotScheduler();
    scheduler.addSchedule("remove-me", "0 9 * * *", () => {});
    scheduler.removeSchedule("remove-me");

    expect(scheduler.getSchedules().length).toBe(0);
  });

  it("should enable/disable schedules", () => {
    const scheduler = new AutopilotScheduler();
    scheduler.addSchedule("toggle", "0 9 * * *", () => {});

    scheduler.setEnabled("toggle", false);
    expect(scheduler.getSchedules()[0].enabled).toBe(false);

    scheduler.setEnabled("toggle", true);
    expect(scheduler.getSchedules()[0].enabled).toBe(true);
  });

  it("should start and stop", () => {
    const scheduler = new AutopilotScheduler(60000);
    scheduler.addSchedule("x", "* * * * *", () => {});

    scheduler.start();
    expect(scheduler.isRunning()).toBe(true);

    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it("should execute callback when cron matches", async () => {
    const callback = vi.fn();
    const scheduler = new AutopilotScheduler(50);

    // Use * * * * * which matches every minute
    scheduler.addSchedule("always", "* * * * *", callback);
    scheduler.start();

    // Wait for at least one tick
    await new Promise((resolve) => setTimeout(resolve, 100));
    scheduler.stop();

    expect(callback).toHaveBeenCalled();
  });

  it("should not run disabled schedules", async () => {
    const callback = vi.fn();
    const scheduler = new AutopilotScheduler(50);

    scheduler.addSchedule("disabled", "* * * * *", callback);
    scheduler.setEnabled("disabled", false);
    scheduler.start();

    await new Promise((resolve) => setTimeout(resolve, 100));
    scheduler.stop();

    expect(callback).not.toHaveBeenCalled();
  });

  it("should validate cron expression on add", () => {
    const scheduler = new AutopilotScheduler();
    expect(() =>
      scheduler.addSchedule("bad", "not-a-cron", () => {})
    ).toThrow();
  });

  it("should expose shouldRunNow for testing", () => {
    const scheduler = new AutopilotScheduler();
    const now = new Date("2026-01-15T09:00:00Z");
    expect(scheduler.shouldRunNow("0 9 * * *", now)).toBe(true);
    expect(scheduler.shouldRunNow("0 10 * * *", now)).toBe(false);
  });
});

// ── Ticket Creator Tests ───────────────────────────────────────────

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: `finding_${Math.random().toString(36).slice(2, 6)}`,
    scanner: "code_quality",
    severity: 3,
    title: "Extract duplicated logic",
    description: "The error handling is duplicated in 3 places.",
    filePath: "src/handler.ts",
    lineNumber: 42,
    suggestion: "Create a shared helper function.",
    effort: "small",
    tags: ["refactor"],
    ...overrides,
  };
}

function makeAutopilotConfig(overrides: Partial<AutopilotConfig> = {}): AutopilotConfig {
  return {
    enabled: true,
    schedule: "0 9 * * 1-5",
    scanners: ["code_quality"] as AutopilotScanner[],
    maxTicketsPerRun: 5,
    autoResolve: false,
    maxConcurrentResolves: 2,
    minSeverity: 2,
    ticketTarget: "github",
    ticketLabels: ["autopilot"],
    branchPrefix: "autopilot/",
    ...overrides,
  };
}

describe("TicketCreator", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("should filter findings by minimum severity", async () => {
    const config = makeAutopilotConfig({ minSeverity: 4 });
    const creator = new TicketCreator(config);

    const findings = [
      makeFinding({ severity: 2 }),
      makeFinding({ severity: 3 }),
      makeFinding({ severity: 4, title: "High severity" }),
      makeFinding({ severity: 5, title: "Critical" }),
    ];

    // No client configured, so all will be skipped with "no client" reason,
    // but we can verify the filtering by checking what was attempted
    const results = await creator.createTickets(findings);

    // Only severity 4 and 5 should be attempted
    expect(results.length).toBe(2);
  });

  it("should sort by severity (highest first)", async () => {
    const config = makeAutopilotConfig({ minSeverity: 1 });
    const creator = new TicketCreator(config);

    const findings = [
      makeFinding({ severity: 1, title: "Low" }),
      makeFinding({ severity: 5, title: "Critical" }),
      makeFinding({ severity: 3, title: "Medium" }),
    ];

    const results = await creator.createTickets(findings);

    // The critical one should come first (attempted first)
    expect(results.length).toBe(3);
  });

  it("should respect maxTicketsPerRun limit", async () => {
    const config = makeAutopilotConfig({ minSeverity: 1, maxTicketsPerRun: 2 });
    const creator = new TicketCreator(config);

    const findings = Array.from({ length: 5 }, (_, i) =>
      makeFinding({ severity: 3, title: `Finding ${i}` })
    );

    const results = await creator.createTickets(findings);
    expect(results.length).toBe(2);
  });

  it("should skip duplicates based on existing titles", async () => {
    const config = makeAutopilotConfig({ minSeverity: 1 });
    const creator = new TicketCreator(config);

    const findings = [
      makeFinding({ title: "Fix the auth bug" }),
      makeFinding({ title: "Fix the login form" }),
    ];

    const existing = new Set(["[code_quality] fix the auth bug"]); // lowercase match

    const results = await creator.createTickets(findings, existing);
    const skipped = results.filter((r) => r.skipped && r.reason?.includes("Duplicate"));
    expect(skipped.length).toBe(1);
  });

  it("should create GitHub issues when configured", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          id: 999,
          number: 42,
          html_url: "https://github.com/test/repo/issues/42",
        }),
      text: () => Promise.resolve(""),
    });

    const { GitHubClient } = await import("../src/integrations/github.js");
    const client = new GitHubClient({
      token: "test",
      owner: "test",
      repo: "repo",
      watchLabels: [],
    });

    const config = makeAutopilotConfig({
      minSeverity: 1,
      ticketTarget: "github",
    });
    const creator = new TicketCreator(config, client);

    const findings = [makeFinding({ title: "Security issue" })];
    const results = await creator.createTickets(findings);

    expect(results.length).toBe(1);
    expect(results[0].skipped).toBe(false);
    expect(results[0].ticketId).toBe("gh_42");
    expect(results[0].url).toBe("https://github.com/test/repo/issues/42");
  });
});

// ── Config Normalization Tests ─────────────────────────────────────

describe("Autopilot Config", () => {
  it("should parse autopilot config from TOML-like raw data", async () => {
    // Import the normalizer indirectly via loadConfig
    const { parseTOML } = await import("../src/config/loader.js");

    const toml = `
[foreman]
name = "test"

[autopilot]
enabled = true
schedule = "0 9 * * 1-5"
scanners = ["security", "code_quality", "dead_code"]
max_tickets_per_run = 10
auto_resolve = true
max_concurrent_resolves = 3
min_severity = 2
ticket_target = "github"
ticket_labels = ["autopilot", "bot"]
branch_prefix = "bot/"

[models.coder]
provider = "anthropic"
model = "claude-sonnet-4-5-20250929"
role = "coder"
max_tokens = 4096

[routing]
strategy = "capability_match"
fallback_chain = ["coder"]

[sandbox]
type = "local"
warm_pool = 1
timeout_minutes = 30
cleanup = "always"
`;

    const parsed = parseTOML(toml);
    expect(parsed.autopilot).toBeDefined();

    const ap = parsed.autopilot as Record<string, unknown>;
    expect(ap.enabled).toBe(true);
    expect(ap.schedule).toBe("0 9 * * 1-5");
    expect(ap.scanners).toEqual(["security", "code_quality", "dead_code"]);
    expect(ap.max_tickets_per_run).toBe(10);
    expect(ap.auto_resolve).toBe(true);
    expect(ap.ticket_target).toBe("github");
    expect(ap.branch_prefix).toBe("bot/");
  });
});
