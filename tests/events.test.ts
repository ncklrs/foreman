import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../src/events/bus.js";
import type { ForemanEvent, AgentSession, AgentTask } from "../src/types/index.js";

const mockTask: AgentTask = {
  id: "task_1",
  title: "Test Task",
  description: "A test task",
};

const mockSession: AgentSession = {
  id: "session_1",
  task: mockTask,
  status: "running",
  modelName: "test-model",
  messages: [],
  iterations: 0,
  maxIterations: 50,
  tokenUsage: { inputTokens: 0, outputTokens: 0 },
  startedAt: new Date(),
  artifacts: [],
};

describe("EventBus", () => {
  it("emits events to specific listeners", () => {
    const bus = new EventBus();
    const listener = vi.fn();

    bus.on("agent:started", listener);
    bus.emit({ type: "agent:started", session: mockSession });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: "agent:started", session: mockSession });
  });

  it("emits events to wildcard listeners", () => {
    const bus = new EventBus();
    const listener = vi.fn();

    bus.onAny(listener);
    bus.emit({ type: "agent:started", session: mockSession });
    bus.emit({ type: "agent:completed", session: mockSession });

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not emit to unsubscribed listeners", () => {
    const bus = new EventBus();
    const listener = vi.fn();

    const sub = bus.on("agent:started", listener);
    sub.unsubscribe();
    bus.emit({ type: "agent:started", session: mockSession });

    expect(listener).not.toHaveBeenCalled();
  });

  it("supports once listeners", () => {
    const bus = new EventBus();
    const listener = vi.fn();

    bus.once("agent:started", listener);
    bus.emit({ type: "agent:started", session: mockSession });
    bus.emit({ type: "agent:started", session: mockSession });

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("supports waitFor with promise", async () => {
    const bus = new EventBus();

    const promise = bus.waitFor("agent:completed");

    // Emit after a tick
    setTimeout(() => {
      bus.emit({ type: "agent:completed", session: mockSession });
    }, 10);

    const event = await promise;
    expect(event.type).toBe("agent:completed");
  });

  it("supports waitFor with timeout", async () => {
    const bus = new EventBus();

    await expect(bus.waitFor("agent:completed", 50)).rejects.toThrow("Timeout");
  });

  it("maintains event history", () => {
    const bus = new EventBus();

    bus.emit({ type: "agent:started", session: mockSession });
    bus.emit({ type: "agent:completed", session: mockSession });

    const history = bus.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].type).toBe("agent:started");
    expect(history[1].type).toBe("agent:completed");
  });

  it("filters history by type", () => {
    const bus = new EventBus();

    bus.emit({ type: "agent:started", session: mockSession });
    bus.emit({ type: "agent:completed", session: mockSession });
    bus.emit({ type: "agent:started", session: mockSession });

    const started = bus.getHistory("agent:started");
    expect(started).toHaveLength(2);
  });

  it("respects max history size", () => {
    const bus = new EventBus(5);

    for (let i = 0; i < 10; i++) {
      bus.emit({ type: "agent:started", session: mockSession });
    }

    expect(bus.getHistory()).toHaveLength(5);
  });

  it("supports pause and resume", () => {
    const bus = new EventBus();
    const listener = vi.fn();

    bus.on("agent:started", listener);
    bus.pause();

    bus.emit({ type: "agent:started", session: mockSession });
    expect(listener).not.toHaveBeenCalled();

    bus.resume();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reports listener count", () => {
    const bus = new EventBus();

    bus.on("agent:started", () => {});
    bus.on("agent:started", () => {});
    bus.on("agent:completed", () => {});
    bus.onAny(() => {});

    // Type-specific: 2 specific + 1 wildcard
    expect(bus.listenerCount("agent:started")).toBe(3);
    // Total: 3 specific + 1 wildcard
    expect(bus.listenerCount()).toBe(4);
  });

  it("handles listener errors gracefully", () => {
    const bus = new EventBus();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    bus.on("agent:started", () => {
      throw new Error("Listener error");
    });

    // Should not throw
    expect(() => {
      bus.emit({ type: "agent:started", session: mockSession });
    }).not.toThrow();

    errorSpy.mockRestore();
  });
});
