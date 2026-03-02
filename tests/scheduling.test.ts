import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AutopilotScheduler } from "../src/autopilot/scheduler.js";
import { EventBus } from "../src/events/bus.js";
import { Logger } from "../src/logging/logger.js";
import { CronScheduleManager } from "../src/scheduling/manager.js";
import { parseTOML } from "../src/config/loader.js";
import type { ScheduledTaskConfig, AgentTask, ForemanEvent } from "../src/types/index.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeScheduleConfig(overrides: Partial<ScheduledTaskConfig> = {}): ScheduledTaskConfig {
  return {
    id: "daily-review",
    description: "Run daily code review",
    schedule: "0 9 * * 1-5",
    timezone: "UTC",
    enabled: true,
    prompt: "Review the codebase for issues",
    model: "claude-sonnet-4-5-20250929",
    branch: "main",
    labels: ["review", "automated"],
    ...overrides,
  };
}

function createMocks() {
  const scheduler = new AutopilotScheduler();
  const eventBus = new EventBus();
  const logger = new Logger("debug", "test");
  const onEnqueueTask = vi.fn<(task: AgentTask) => void>();

  const manager = new CronScheduleManager({
    scheduler,
    eventBus,
    logger,
    onEnqueueTask,
  });

  return { scheduler, eventBus, logger, onEnqueueTask, manager };
}

// ── CronScheduleManager ─────────────────────────────────────────

describe("CronScheduleManager", () => {
  let scheduler: AutopilotScheduler;
  let eventBus: EventBus;
  let logger: Logger;
  let onEnqueueTask: ReturnType<typeof vi.fn>;
  let manager: CronScheduleManager;

  beforeEach(() => {
    const mocks = createMocks();
    scheduler = mocks.scheduler;
    eventBus = mocks.eventBus;
    logger = mocks.logger;
    onEnqueueTask = mocks.onEnqueueTask;
    manager = mocks.manager;
  });

  afterEach(() => {
    manager.stop();
  });

  it("loads schedules from config array", () => {
    const configs = [
      makeScheduleConfig({ id: "sched-1", schedule: "0 9 * * *" }),
      makeScheduleConfig({ id: "sched-2", schedule: "0 17 * * *" }),
      makeScheduleConfig({ id: "sched-3", schedule: "30 12 * * 1-5" }),
    ];

    manager.loadFromConfig(configs);

    const schedules = manager.getSchedules();
    expect(schedules.length).toBe(3);
    expect(schedules.map((s) => s.id)).toEqual(["sched-1", "sched-2", "sched-3"]);

    // Also verify they were registered in the underlying scheduler
    const underlying = scheduler.getSchedules();
    expect(underlying.length).toBe(3);
  });

  it("fires schedule and enqueues task with correct fields", async () => {
    const config = makeScheduleConfig({
      id: "fire-test",
      description: "Fire test task",
      prompt: "Do something",
      branch: "feature/test",
      labels: ["ci"],
      model: "claude-sonnet-4-5-20250929",
      schedule: "* * * * *", // every minute - will match
    });

    // Use a short check interval so the scheduler ticks quickly
    const fastScheduler = new AutopilotScheduler(50);
    const fastManager = new CronScheduleManager({
      scheduler: fastScheduler,
      eventBus,
      logger,
      onEnqueueTask,
    });

    fastManager.addSchedule(config);
    fastManager.start();

    // Wait for the scheduler to tick and fire the callback
    await new Promise((resolve) => setTimeout(resolve, 150));
    fastManager.stop();

    expect(onEnqueueTask).toHaveBeenCalled();
    const enqueuedTask: AgentTask = onEnqueueTask.mock.calls[0][0];
    expect(enqueuedTask.title).toBe("Fire test task");
    expect(enqueuedTask.description).toBe("Do something");
    expect(enqueuedTask.branch).toBe("feature/test");
    expect(enqueuedTask.labels).toEqual(["ci"]);
    expect(enqueuedTask.assignedModel).toBe("claude-sonnet-4-5-20250929");
  });

  it("emits schedule:fired event when schedule fires", async () => {
    const firedEvents: ForemanEvent[] = [];
    eventBus.on("schedule:fired", (event) => firedEvents.push(event));

    const config = makeScheduleConfig({
      id: "emit-fire-test",
      schedule: "* * * * *",
    });

    const fastScheduler = new AutopilotScheduler(50);
    const fastManager = new CronScheduleManager({
      scheduler: fastScheduler,
      eventBus,
      logger,
      onEnqueueTask,
    });

    fastManager.addSchedule(config);
    fastManager.start();

    await new Promise((resolve) => setTimeout(resolve, 150));
    fastManager.stop();

    expect(firedEvents.length).toBeGreaterThanOrEqual(1);
    const fired = firedEvents[0] as Extract<ForemanEvent, { type: "schedule:fired" }>;
    expect(fired.type).toBe("schedule:fired");
    expect(fired.scheduleId).toBe("emit-fire-test");
    expect(fired.taskId).toMatch(/^sched-emit-fire-test-\d+$/);
  });

  it("adds schedule at runtime and emits schedule:added", () => {
    const addedEvents: ForemanEvent[] = [];
    eventBus.on("schedule:added", (event) => addedEvents.push(event));

    const config = makeScheduleConfig({ id: "runtime-add" });
    manager.addSchedule(config);

    expect(manager.getSchedules().length).toBe(1);
    expect(manager.getSchedules()[0].id).toBe("runtime-add");

    expect(addedEvents.length).toBe(1);
    const added = addedEvents[0] as Extract<ForemanEvent, { type: "schedule:added" }>;
    expect(added.scheduleId).toBe("runtime-add");
  });

  it("removes schedule and emits schedule:removed", () => {
    const removedEvents: ForemanEvent[] = [];
    eventBus.on("schedule:removed", (event) => removedEvents.push(event));

    manager.addSchedule(makeScheduleConfig({ id: "to-remove" }));
    expect(manager.getSchedules().length).toBe(1);

    manager.removeSchedule("to-remove");

    expect(manager.getSchedules().length).toBe(0);
    expect(scheduler.getSchedules().length).toBe(0);

    expect(removedEvents.length).toBe(1);
    const removed = removedEvents[0] as Extract<ForemanEvent, { type: "schedule:removed" }>;
    expect(removed.scheduleId).toBe("to-remove");
  });

  it("toggles schedule enabled/disabled and emits schedule:toggled", () => {
    const toggledEvents: ForemanEvent[] = [];
    eventBus.on("schedule:toggled", (event) => toggledEvents.push(event));

    manager.addSchedule(makeScheduleConfig({ id: "toggle-me" }));

    manager.setEnabled("toggle-me", false);
    expect(scheduler.getSchedules()[0].enabled).toBe(false);

    manager.setEnabled("toggle-me", true);
    expect(scheduler.getSchedules()[0].enabled).toBe(true);

    expect(toggledEvents.length).toBe(2);

    const first = toggledEvents[0] as Extract<ForemanEvent, { type: "schedule:toggled" }>;
    expect(first.scheduleId).toBe("toggle-me");
    expect(first.enabled).toBe(false);

    const second = toggledEvents[1] as Extract<ForemanEvent, { type: "schedule:toggled" }>;
    expect(second.enabled).toBe(true);
  });

  it("returns all schedules via getSchedules()", () => {
    manager.addSchedule(makeScheduleConfig({ id: "a", schedule: "0 9 * * *" }));
    manager.addSchedule(makeScheduleConfig({ id: "b", schedule: "0 12 * * *" }));
    manager.addSchedule(makeScheduleConfig({ id: "c", schedule: "0 17 * * *" }));

    const schedules = manager.getSchedules();
    expect(schedules.length).toBe(3);
    expect(schedules.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("handles disabled schedules in config", () => {
    const configs = [
      makeScheduleConfig({ id: "enabled-one", enabled: true }),
      makeScheduleConfig({ id: "disabled-one", enabled: false }),
    ];

    manager.loadFromConfig(configs);

    // Both should be registered
    expect(manager.getSchedules().length).toBe(2);

    // But the underlying scheduler should have the disabled one marked
    const underlying = scheduler.getSchedules();
    const enabledEntry = underlying.find((s) => s.id === "enabled-one");
    const disabledEntry = underlying.find((s) => s.id === "disabled-one");

    expect(enabledEntry?.enabled).toBe(true);
    expect(disabledEntry?.enabled).toBe(false);
  });

  it("starts and stops the scheduler", () => {
    manager.addSchedule(makeScheduleConfig({ id: "lifecycle" }));

    expect(scheduler.isRunning()).toBe(false);

    manager.start();
    expect(scheduler.isRunning()).toBe(true);

    manager.stop();
    expect(scheduler.isRunning()).toBe(false);
  });

  it("creates tasks with correct id format sched-{id}-{timestamp}", async () => {
    const config = makeScheduleConfig({
      id: "id-format",
      schedule: "* * * * *",
    });

    const fastScheduler = new AutopilotScheduler(50);
    const fastManager = new CronScheduleManager({
      scheduler: fastScheduler,
      eventBus,
      logger,
      onEnqueueTask,
    });

    fastManager.addSchedule(config);
    fastManager.start();

    await new Promise((resolve) => setTimeout(resolve, 150));
    fastManager.stop();

    expect(onEnqueueTask).toHaveBeenCalled();
    const task: AgentTask = onEnqueueTask.mock.calls[0][0];
    expect(task.id).toMatch(/^sched-id-format-\d+$/);

    // Verify the timestamp portion is a valid number
    const parts = task.id.split("-");
    const timestamp = parseInt(parts[parts.length - 1], 10);
    expect(timestamp).toBeGreaterThan(0);
    expect(timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("passes branch, labels, and model from config to task", async () => {
    const config = makeScheduleConfig({
      id: "field-pass",
      schedule: "* * * * *",
      branch: "release/v2",
      labels: ["urgent", "backend"],
      model: "gpt-4o",
    });

    const fastScheduler = new AutopilotScheduler(50);
    const fastManager = new CronScheduleManager({
      scheduler: fastScheduler,
      eventBus,
      logger,
      onEnqueueTask,
    });

    fastManager.addSchedule(config);
    fastManager.start();

    await new Promise((resolve) => setTimeout(resolve, 150));
    fastManager.stop();

    expect(onEnqueueTask).toHaveBeenCalled();
    const task: AgentTask = onEnqueueTask.mock.calls[0][0];
    expect(task.branch).toBe("release/v2");
    expect(task.labels).toEqual(["urgent", "backend"]);
    expect(task.assignedModel).toBe("gpt-4o");
  });

  it("does not start scheduler twice on repeated start calls", () => {
    manager.addSchedule(makeScheduleConfig({ id: "double-start" }));

    manager.start();
    expect(scheduler.isRunning()).toBe(true);

    // Calling start again should be a no-op
    manager.start();
    expect(scheduler.isRunning()).toBe(true);

    manager.stop();
    expect(scheduler.isRunning()).toBe(false);
  });
});

// ── Config Parsing ──────────────────────────────────────────────

describe("Config parsing for [[schedules]]", () => {
  it("parses [[schedules]] TOML array-of-tables", () => {
    const toml = `
[foreman]
name = "test"

[[schedules]]
id = "nightly-scan"
description = "Nightly security scan"
schedule = "0 2 * * *"
timezone = "America/New_York"
enabled = true
prompt = "Run security scan on all endpoints"
model = "claude-sonnet-4-5-20250929"
branch = "main"
labels = ["security", "nightly"]

[[schedules]]
id = "weekly-report"
description = "Weekly status report"
schedule = "0 9 * * 1"
prompt = "Generate weekly progress report"
`;

    const parsed = parseTOML(toml);
    expect(parsed.schedules).toBeDefined();
    expect(Array.isArray(parsed.schedules)).toBe(true);

    const schedules = parsed.schedules as Record<string, unknown>[];
    expect(schedules.length).toBe(2);

    expect(schedules[0].id).toBe("nightly-scan");
    expect(schedules[0].description).toBe("Nightly security scan");
    expect(schedules[0].schedule).toBe("0 2 * * *");
    expect(schedules[0].timezone).toBe("America/New_York");
    expect(schedules[0].enabled).toBe(true);
    expect(schedules[0].prompt).toBe("Run security scan on all endpoints");
    expect(schedules[0].model).toBe("claude-sonnet-4-5-20250929");
    expect(schedules[0].branch).toBe("main");
    expect(schedules[0].labels).toEqual(["security", "nightly"]);

    expect(schedules[1].id).toBe("weekly-report");
    expect(schedules[1].schedule).toBe("0 9 * * 1");
  });

  it("applies defaults for optional fields", () => {
    const toml = `
[[schedules]]
id = "minimal"
description = "Minimal config"
schedule = "0 9 * * *"
prompt = "Do something"
`;

    const parsed = parseTOML(toml);
    const schedules = parsed.schedules as Record<string, unknown>[];
    expect(schedules.length).toBe(1);

    const sched = schedules[0];
    expect(sched.id).toBe("minimal");
    expect(sched.description).toBe("Minimal config");
    expect(sched.schedule).toBe("0 9 * * *");
    expect(sched.prompt).toBe("Do something");

    // Optional fields should be absent from raw parse (defaults applied during normalization)
    expect(sched.timezone).toBeUndefined();
    expect(sched.model).toBeUndefined();
    expect(sched.branch).toBeUndefined();
    expect(sched.labels).toBeUndefined();
  });

  it("handles empty config with no schedules", () => {
    const toml = `
[foreman]
name = "empty-test"
`;

    const parsed = parseTOML(toml);
    expect(parsed.schedules).toBeUndefined();
  });

  it("mixes [[schedules]] with other [sections]", () => {
    const toml = `
[foreman]
name = "mixed"

[autopilot]
enabled = true
schedule = "0 9 * * 1-5"

[[schedules]]
id = "task-1"
description = "First task"
schedule = "0 8 * * *"
prompt = "Run first task"

[sandbox]
type = "local"
warm_pool = 2

[[schedules]]
id = "task-2"
description = "Second task"
schedule = "0 18 * * *"
prompt = "Run second task"
`;

    const parsed = parseTOML(toml);

    // Other sections should still parse correctly
    expect(parsed.foreman).toBeDefined();
    expect((parsed.foreman as Record<string, unknown>).name).toBe("mixed");
    expect(parsed.autopilot).toBeDefined();
    expect(parsed.sandbox).toBeDefined();

    // Schedules should be collected as an array
    const schedules = parsed.schedules as Record<string, unknown>[];
    expect(schedules.length).toBe(2);
    expect(schedules[0].id).toBe("task-1");
    expect(schedules[1].id).toBe("task-2");
  });

  it("validates with Zod schema - rejects missing required fields", async () => {
    const { validateConfig } = await import("../src/config/loader.js");

    // Build a minimal valid config but with an invalid schedule entry (missing required id)
    const config = {
      foreman: { name: "test", logLevel: "info" as const, maxConcurrentAgents: 10 },
      models: {
        coder: {
          provider: "anthropic" as const,
          model: "claude-sonnet-4-5-20250929",
          role: "coder",
          maxTokens: 4096,
        },
      },
      routing: { strategy: "capability_match" as const, fallbackChain: ["coder"] },
      sandbox: { type: "local" as const, warmPool: 1, timeoutMinutes: 30, cleanup: "always" as const },
      policy: { protectedPaths: [], blockedCommands: [], maxDiffLines: 500, requireApprovalAbove: 200 },
      schedules: [
        {
          // Missing 'id' - should fail validation
          description: "No id",
          schedule: "0 9 * * *",
          prompt: "test",
        },
      ],
    };

    expect(() => validateConfig(config as any)).toThrow();
  });
});

// ── Schedule Events ─────────────────────────────────────────────

describe("Schedule events", () => {
  let eventBus: EventBus;
  let manager: CronScheduleManager;

  beforeEach(() => {
    const mocks = createMocks();
    eventBus = mocks.eventBus;
    manager = mocks.manager;
  });

  afterEach(() => {
    manager.stop();
  });

  it("emits schedule:added on addSchedule", () => {
    const events: ForemanEvent[] = [];
    eventBus.on("schedule:added", (event) => events.push(event));

    manager.addSchedule(makeScheduleConfig({ id: "add-event-1" }));
    manager.addSchedule(makeScheduleConfig({ id: "add-event-2", schedule: "0 12 * * *" }));

    expect(events.length).toBe(2);

    const first = events[0] as Extract<ForemanEvent, { type: "schedule:added" }>;
    const second = events[1] as Extract<ForemanEvent, { type: "schedule:added" }>;
    expect(first.scheduleId).toBe("add-event-1");
    expect(second.scheduleId).toBe("add-event-2");
  });

  it("emits schedule:removed on removeSchedule", () => {
    const events: ForemanEvent[] = [];
    eventBus.on("schedule:removed", (event) => events.push(event));

    manager.addSchedule(makeScheduleConfig({ id: "remove-event" }));
    manager.removeSchedule("remove-event");

    expect(events.length).toBe(1);
    const removed = events[0] as Extract<ForemanEvent, { type: "schedule:removed" }>;
    expect(removed.scheduleId).toBe("remove-event");
  });

  it("emits schedule:toggled on setEnabled", () => {
    const events: ForemanEvent[] = [];
    eventBus.on("schedule:toggled", (event) => events.push(event));

    manager.addSchedule(makeScheduleConfig({ id: "toggle-event" }));

    manager.setEnabled("toggle-event", false);
    manager.setEnabled("toggle-event", true);

    expect(events.length).toBe(2);

    const disableEvent = events[0] as Extract<ForemanEvent, { type: "schedule:toggled" }>;
    expect(disableEvent.scheduleId).toBe("toggle-event");
    expect(disableEvent.enabled).toBe(false);

    const enableEvent = events[1] as Extract<ForemanEvent, { type: "schedule:toggled" }>;
    expect(enableEvent.scheduleId).toBe("toggle-event");
    expect(enableEvent.enabled).toBe(true);
  });

  it("records all schedule events in event bus history", () => {
    manager.addSchedule(makeScheduleConfig({ id: "history-test" }));
    manager.setEnabled("history-test", false);
    manager.removeSchedule("history-test");

    const history = eventBus.getHistory();
    const scheduleEvents = history.filter((e) => e.type.startsWith("schedule:"));
    expect(scheduleEvents.length).toBe(3);
    expect(scheduleEvents[0].type).toBe("schedule:added");
    expect(scheduleEvents[1].type).toBe("schedule:toggled");
    expect(scheduleEvents[2].type).toBe("schedule:removed");
  });
});
