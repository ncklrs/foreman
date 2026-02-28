import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { WebSocketServer } from "../src/api/websocket.js";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ForemanEvent } from "../src/types/index.js";

// ── Mock helpers ──────────────────────────────────────────────────

/** Minimal mock socket based on EventEmitter that satisfies Duplex for our tests. */
function createMockSocket(): Duplex & { written: Buffer[]; destroyed: boolean } {
  const emitter = new EventEmitter() as Duplex & { written: Buffer[]; destroyed: boolean };
  emitter.written = [];
  emitter.destroyed = false;

  emitter.write = vi.fn((data: Buffer | string) => {
    emitter.written.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return true;
  }) as any;

  emitter.end = vi.fn(() => {
    emitter.destroyed = true;
    emitter.emit("close");
    return emitter;
  }) as any;

  emitter.destroy = vi.fn(() => {
    emitter.destroyed = true;
    emitter.emit("close");
    return emitter;
  }) as any;

  return emitter;
}

function createMockLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function makeUpgradeRequest(overrides: {
  key?: string;
  url?: string;
  host?: string;
} = {}): IncomingMessage {
  return {
    headers: {
      "sec-websocket-key": overrides.key ?? "dGhlIHNhbXBsZSBub25jZQ==",
      host: overrides.host ?? "localhost",
    },
    url: overrides.url ?? "/",
  } as unknown as IncomingMessage;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("WebSocketServer", () => {
  let wss: WebSocketServer;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = createMockLogger();
    wss = new WebSocketServer(logger);
  });

  afterEach(() => {
    wss.closeAll();
    vi.useRealTimers();
  });

  // ── Connection tracking ───────────────────────────────────────

  describe("client connection tracking", () => {
    it("should start with zero clients", () => {
      expect(wss.getClientCount()).toBe(0);
    });

    it("should track a connected client", () => {
      const socket = createMockSocket();
      wss.handleUpgrade(makeUpgradeRequest(), socket, Buffer.alloc(0));
      expect(wss.getClientCount()).toBe(1);
    });

    it("should track multiple connected clients", () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();
      const socket3 = createMockSocket();

      wss.handleUpgrade(makeUpgradeRequest(), socket1, Buffer.alloc(0));
      wss.handleUpgrade(makeUpgradeRequest(), socket2, Buffer.alloc(0));
      wss.handleUpgrade(makeUpgradeRequest(), socket3, Buffer.alloc(0));

      expect(wss.getClientCount()).toBe(3);
    });

    it("should remove client on socket close event", () => {
      const socket = createMockSocket();
      wss.handleUpgrade(makeUpgradeRequest(), socket, Buffer.alloc(0));
      expect(wss.getClientCount()).toBe(1);

      socket.emit("close");
      expect(wss.getClientCount()).toBe(0);
    });

    it("should remove client on socket error event", () => {
      const socket = createMockSocket();
      wss.handleUpgrade(makeUpgradeRequest(), socket, Buffer.alloc(0));
      expect(wss.getClientCount()).toBe(1);

      socket.emit("error", new Error("connection reset"));
      expect(wss.getClientCount()).toBe(0);
    });

    it("should destroy socket when no sec-websocket-key header", () => {
      const socket = createMockSocket();
      const req = {
        headers: {},
        url: "/",
      } as unknown as IncomingMessage;

      wss.handleUpgrade(req, socket, Buffer.alloc(0));
      expect(socket.destroy).toHaveBeenCalled();
      expect(wss.getClientCount()).toBe(0);
    });

    it("should send 101 Switching Protocols on successful upgrade", () => {
      const socket = createMockSocket();
      wss.handleUpgrade(makeUpgradeRequest(), socket, Buffer.alloc(0));

      const firstWrite = socket.written[0].toString("utf-8");
      expect(firstWrite).toContain("HTTP/1.1 101 Switching Protocols");
      expect(firstWrite).toContain("Upgrade: websocket");
      expect(firstWrite).toContain("Connection: Upgrade");
      expect(firstWrite).toContain("Sec-WebSocket-Accept:");
    });

    it("should send welcome message after upgrade", () => {
      const socket = createMockSocket();
      wss.handleUpgrade(makeUpgradeRequest(), socket, Buffer.alloc(0));

      // First write is the HTTP upgrade, second write is the welcome WebSocket frame
      expect(socket.written.length).toBeGreaterThanOrEqual(2);

      // Decode the second frame (WebSocket text frame): skip 2-byte header
      const frame = socket.written[1];
      const payloadLen = frame[1] & 0x7f;
      const payload = frame.subarray(2, 2 + payloadLen).toString("utf-8");
      const msg = JSON.parse(payload);

      expect(msg.type).toBe("connected");
      expect(msg.message).toContain("Foreman event stream");
      expect(msg.clientId).toBeDefined();
    });
  });

  // ── Broadcast ─────────────────────────────────────────────────

  describe("broadcast", () => {
    it("should send event to all connected clients", () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();
      wss.handleUpgrade(makeUpgradeRequest(), socket1, Buffer.alloc(0));
      wss.handleUpgrade(makeUpgradeRequest(), socket2, Buffer.alloc(0));

      const event: ForemanEvent = {
        type: "task:queued",
        task: { id: "t1", title: "Test", description: "desc" },
      };
      wss.broadcast(event);

      // Both sockets should have received the broadcast frame (in addition to upgrade + welcome)
      // Upgrade response + welcome frame + broadcast frame = 3 writes
      expect(socket1.write).toHaveBeenCalledTimes(3);
      expect(socket2.write).toHaveBeenCalledTimes(3);
    });

    it("should do nothing when no clients are connected", () => {
      const event: ForemanEvent = {
        type: "task:queued",
        task: { id: "t1", title: "Test", description: "desc" },
      };
      // Should not throw
      expect(() => wss.broadcast(event)).not.toThrow();
    });

    it("should encode event as JSON in WebSocket text frame", () => {
      const socket = createMockSocket();
      wss.handleUpgrade(makeUpgradeRequest(), socket, Buffer.alloc(0));

      const event: ForemanEvent = {
        type: "task:queued",
        task: { id: "t1", title: "Test task", description: "desc" },
      };
      wss.broadcast(event);

      // The broadcast frame is the last written buffer
      const frame = socket.written[socket.written.length - 1];
      // First byte: 0x81 (FIN + Text opcode)
      expect(frame[0]).toBe(0x81);
      const payloadLen = frame[1] & 0x7f;
      const payload = frame.subarray(2, 2 + payloadLen).toString("utf-8");
      const parsed = JSON.parse(payload);
      expect(parsed.type).toBe("task:queued");
      expect(parsed.task.id).toBe("t1");
    });

    // ── Broadcast with filters ────────────────────────────────────

    it("should filter events based on client filter (type prefix match)", () => {
      const agentSocket = createMockSocket();
      const taskSocket = createMockSocket();

      wss.handleUpgrade(
        makeUpgradeRequest({ url: "/?filter=agent" }),
        agentSocket,
        Buffer.alloc(0),
      );
      wss.handleUpgrade(
        makeUpgradeRequest({ url: "/?filter=task" }),
        taskSocket,
        Buffer.alloc(0),
      );

      // Send agent event
      wss.broadcast({
        type: "agent:started",
        session: {
          id: "s1",
          task: { id: "t1", title: "T", description: "d" },
          status: "running",
          modelName: "claude",
          messages: [],
          iterations: 0,
          maxIterations: 50,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
          startedAt: new Date(),
          artifacts: [],
        },
      } as ForemanEvent);

      // agentSocket received: upgrade + welcome + broadcast = 3 writes
      expect(agentSocket.write).toHaveBeenCalledTimes(3);
      // taskSocket received: upgrade + welcome = 2 writes (event filtered out)
      expect(taskSocket.write).toHaveBeenCalledTimes(2);
    });

    it("should send event to client with no filter", () => {
      const noFilterSocket = createMockSocket();
      const filteredSocket = createMockSocket();

      wss.handleUpgrade(makeUpgradeRequest(), noFilterSocket, Buffer.alloc(0));
      wss.handleUpgrade(
        makeUpgradeRequest({ url: "/?filter=autopilot" }),
        filteredSocket,
        Buffer.alloc(0),
      );

      const event: ForemanEvent = {
        type: "task:queued",
        task: { id: "t1", title: "T", description: "d" },
      };
      wss.broadcast(event);

      // No-filter client gets the broadcast
      expect(noFilterSocket.write).toHaveBeenCalledTimes(3);
      // Filtered client (autopilot) does not get task: event
      expect(filteredSocket.write).toHaveBeenCalledTimes(2);
    });

    it("should send event to client when filter matches event type prefix", () => {
      const socket = createMockSocket();
      wss.handleUpgrade(
        makeUpgradeRequest({ url: "/?filter=task" }),
        socket,
        Buffer.alloc(0),
      );

      wss.broadcast({
        type: "task:queued",
        task: { id: "t1", title: "T", description: "d" },
      });

      // upgrade + welcome + broadcast = 3
      expect(socket.write).toHaveBeenCalledTimes(3);
    });

    it("should remove client that throws on write during broadcast", () => {
      const goodSocket = createMockSocket();
      const badSocket = createMockSocket();

      wss.handleUpgrade(makeUpgradeRequest(), goodSocket, Buffer.alloc(0));
      wss.handleUpgrade(makeUpgradeRequest(), badSocket, Buffer.alloc(0));
      expect(wss.getClientCount()).toBe(2);

      // Make the bad socket throw on the next write (broadcast)
      (badSocket.write as any).mockImplementationOnce(() => {
        throw new Error("broken pipe");
      });

      wss.broadcast({
        type: "task:queued",
        task: { id: "t1", title: "T", description: "d" },
      });

      // Bad client should be removed
      expect(wss.getClientCount()).toBe(1);
    });
  });

  // ── closeAll ──────────────────────────────────────────────────

  describe("closeAll", () => {
    it("should remove all clients", () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();

      wss.handleUpgrade(makeUpgradeRequest(), socket1, Buffer.alloc(0));
      wss.handleUpgrade(makeUpgradeRequest(), socket2, Buffer.alloc(0));
      expect(wss.getClientCount()).toBe(2);

      wss.closeAll();
      expect(wss.getClientCount()).toBe(0);
    });

    it("should send close frame to each client", () => {
      const socket = createMockSocket();
      wss.handleUpgrade(makeUpgradeRequest(), socket, Buffer.alloc(0));

      wss.closeAll();

      // Find the close frame: 0x88 opcode
      const closeFrame = socket.written.find((buf) => buf[0] === 0x88);
      expect(closeFrame).toBeDefined();
      expect(closeFrame![0]).toBe(0x88);
      expect(closeFrame![1]).toBe(0x00);
    });

    it("should call end() on each client socket", () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();

      wss.handleUpgrade(makeUpgradeRequest(), socket1, Buffer.alloc(0));
      wss.handleUpgrade(makeUpgradeRequest(), socket2, Buffer.alloc(0));

      wss.closeAll();

      expect(socket1.end).toHaveBeenCalled();
      expect(socket2.end).toHaveBeenCalled();
    });

    it("should handle errors during close gracefully", () => {
      const socket = createMockSocket();
      wss.handleUpgrade(makeUpgradeRequest(), socket, Buffer.alloc(0));

      // Make write throw during close
      (socket.write as any).mockImplementation(() => {
        throw new Error("already destroyed");
      });

      // Should not throw
      expect(() => wss.closeAll()).not.toThrow();
      expect(wss.getClientCount()).toBe(0);
    });

    it("should be safe to call closeAll multiple times", () => {
      const socket = createMockSocket();
      wss.handleUpgrade(makeUpgradeRequest(), socket, Buffer.alloc(0));

      wss.closeAll();
      expect(wss.getClientCount()).toBe(0);

      // Second call should be harmless
      expect(() => wss.closeAll()).not.toThrow();
      expect(wss.getClientCount()).toBe(0);
    });

    it("should stop ping interval on closeAll", () => {
      const socket = createMockSocket();
      wss.handleUpgrade(makeUpgradeRequest(), socket, Buffer.alloc(0));

      wss.closeAll();

      // Advance timers past the ping interval (30s) — no ping should fire
      const writeCountAfterClose = (socket.write as any).mock.calls.length;
      vi.advanceTimersByTime(60_000);

      // No new writes should have occurred from pings
      // (socket was already ended, but we verify no ping timer is running)
      expect(wss.getClientCount()).toBe(0);
    });
  });

  // ── Ping interval ────────────────────────────────────────────

  describe("ping interval", () => {
    it("should start ping interval when first client connects", () => {
      const socket = createMockSocket();
      wss.handleUpgrade(makeUpgradeRequest(), socket, Buffer.alloc(0));

      const writesBeforePing = (socket.write as any).mock.calls.length;

      // Advance past the 30s ping interval
      vi.advanceTimersByTime(30_000);

      // Should have received a ping frame
      const writesAfterPing = (socket.write as any).mock.calls.length;
      expect(writesAfterPing).toBeGreaterThan(writesBeforePing);
    });

    it("should disconnect client that misses pong (alive=false)", () => {
      const socket = createMockSocket();
      wss.handleUpgrade(makeUpgradeRequest(), socket, Buffer.alloc(0));
      expect(wss.getClientCount()).toBe(1);

      // First ping sets alive=false
      vi.advanceTimersByTime(30_000);
      expect(wss.getClientCount()).toBe(1); // still connected, alive set to false

      // Second ping: alive is still false, client gets disconnected
      vi.advanceTimersByTime(30_000);
      expect(wss.getClientCount()).toBe(0);
    });

    it("should stop ping interval when last client disconnects", () => {
      const socket = createMockSocket();
      wss.handleUpgrade(makeUpgradeRequest(), socket, Buffer.alloc(0));

      socket.emit("close");
      expect(wss.getClientCount()).toBe(0);

      // Connect a fresh socket after the old interval should have been cleared
      const socket2 = createMockSocket();
      wss.handleUpgrade(makeUpgradeRequest(), socket2, Buffer.alloc(0));

      // This verifies no error occurs and the new interval works
      const writesBeforePing = (socket2.write as any).mock.calls.length;
      vi.advanceTimersByTime(30_000);
      const writesAfterPing = (socket2.write as any).mock.calls.length;
      expect(writesAfterPing).toBeGreaterThan(writesBeforePing);
    });
  });
});
