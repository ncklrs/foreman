/**
 * WebSocket server for real-time event streaming.
 * Implements the WebSocket protocol over Node's built-in net module.
 * Supports RFC 6455 for browser and programmatic clients.
 */

import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { ForemanEvent } from "../types/index.js";
import type { Logger } from "../logging/logger.js";
import { generateId } from "../utils/id.js";

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-5AB5-11D85B9A";

interface WsClient {
  socket: Duplex;
  id: string;
  filter?: string;
  alive: boolean;
}

export class WebSocketServer {
  private clients: Map<string, WsClient> = new Map();
  private logger: Logger;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /** Handle an HTTP upgrade request. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, _head: Buffer): void {
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }

    // Compute accept key per RFC 6455
    const acceptKey = createHash("sha1")
      .update(key + WS_MAGIC)
      .digest("base64");

    // Complete the handshake
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
      "\r\n"
    );

    const clientId = generateId("ws");

    // Check for event filter from query params
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const filter = url.searchParams.get("filter") ?? undefined;

    const client: WsClient = { socket, id: clientId, filter, alive: true };
    this.clients.set(clientId, client);

    this.logger.debug("WebSocket client connected", { clientId, filter });

    // Start ping interval if first client
    if (this.clients.size === 1) {
      this.startPingInterval();
    }

    // Listen for data (pong frames, close frames)
    socket.on("data", (data: Buffer) => {
      this.handleFrame(client, data);
    });

    socket.on("close", () => {
      this.clients.delete(clientId);
      this.logger.debug("WebSocket client disconnected", { clientId });
      if (this.clients.size === 0) {
        this.stopPingInterval();
      }
    });

    socket.on("error", () => {
      this.clients.delete(clientId);
    });

    // Send welcome message
    this.sendToClient(client, {
      type: "connected",
      clientId,
      message: "Connected to Foreman event stream",
    });
  }

  /** Broadcast an event to all connected clients. */
  broadcast(event: ForemanEvent): void {
    if (this.clients.size === 0) return;

    const payload = JSON.stringify(event);

    for (const client of this.clients.values()) {
      // Apply client filter
      if (client.filter && !event.type.startsWith(client.filter)) {
        continue;
      }

      try {
        this.sendRaw(client.socket, payload);
      } catch {
        this.clients.delete(client.id);
      }
    }
  }

  /** Close all client connections. */
  closeAll(): void {
    this.stopPingInterval();
    for (const client of this.clients.values()) {
      try {
        // Send close frame
        const frame = Buffer.alloc(2);
        frame[0] = 0x88; // FIN + Close
        frame[1] = 0x00;
        client.socket.write(frame);
        client.socket.end();
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.clients.clear();
  }

  /** Get the number of connected clients. */
  getClientCount(): number {
    return this.clients.size;
  }

  private sendToClient(client: WsClient, data: unknown): void {
    try {
      this.sendRaw(client.socket, JSON.stringify(data));
    } catch {
      this.clients.delete(client.id);
    }
  }

  /** Send a text frame per RFC 6455. */
  private sendRaw(socket: Duplex, payload: string): void {
    const data = Buffer.from(payload, "utf-8");
    const length = data.length;

    let header: Buffer;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81; // FIN + Text
      header[1] = length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    socket.write(Buffer.concat([header, data]));
  }

  /** Handle incoming WebSocket frames. */
  private handleFrame(client: WsClient, data: Buffer): void {
    if (data.length < 2) return;

    const opcode = data[0] & 0x0f;
    const masked = (data[1] & 0x80) !== 0;
    let payloadLength = data[1] & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (data.length < 4) return;
      payloadLength = data.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      if (data.length < 10) return;
      payloadLength = Number(data.readBigUInt64BE(2));
      offset = 10;
    }

    let maskKey: Buffer | null = null;
    if (masked) {
      if (data.length < offset + 4) return;
      maskKey = data.subarray(offset, offset + 4);
      offset += 4;
    }

    const payload = data.subarray(offset, offset + payloadLength);
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    switch (opcode) {
      case 0x08: // Close
        this.clients.delete(client.id);
        client.socket.end();
        break;
      case 0x09: // Ping
        this.sendPong(client.socket, payload);
        break;
      case 0x0a: // Pong
        client.alive = true;
        break;
      case 0x01: { // Text
        // Handle client messages (e.g., filter changes)
        try {
          const msg = JSON.parse(payload.toString("utf-8")) as Record<string, unknown>;
          if (msg.type === "filter" && typeof msg.filter === "string") {
            client.filter = msg.filter || undefined;
            this.sendToClient(client, {
              type: "filter_set",
              filter: client.filter ?? null,
            });
          }
        } catch {
          // Ignore malformed messages
        }
        break;
      }
    }
  }

  private sendPong(socket: Duplex, payload: Buffer): void {
    const frame = Buffer.alloc(2 + payload.length);
    frame[0] = 0x8a; // FIN + Pong
    frame[1] = payload.length;
    payload.copy(frame, 2);
    socket.write(frame);
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.alive) {
          this.clients.delete(client.id);
          client.socket.end();
          continue;
        }
        client.alive = false;
        // Send ping frame
        const frame = Buffer.alloc(2);
        frame[0] = 0x89; // FIN + Ping
        frame[1] = 0x00;
        try {
          client.socket.write(frame);
        } catch {
          this.clients.delete(client.id);
        }
      }
    }, 30_000);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
