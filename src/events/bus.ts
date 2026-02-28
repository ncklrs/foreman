/**
 * Typed event bus for Foreman.
 * Provides type-safe event emission and subscription with
 * support for wildcard listeners, event history, and backpressure.
 */

import type { ForemanEvent } from "../types/index.js";

type EventType = ForemanEvent["type"];
type EventOfType<T extends EventType> = Extract<ForemanEvent, { type: T }>;

type EventListener<T extends EventType = EventType> = (event: EventOfType<T>) => void;
type WildcardListener = (event: ForemanEvent) => void;

interface Subscription {
  unsubscribe: () => void;
}

export class EventBus {
  private listeners: Map<EventType, Set<EventListener<any>>> = new Map();
  private wildcardListeners: Set<WildcardListener> = new Set();
  private history: ForemanEvent[] = [];
  private maxHistorySize: number;
  private paused = false;
  private pendingEvents: ForemanEvent[] = [];

  constructor(maxHistorySize = 1000) {
    this.maxHistorySize = maxHistorySize;
  }

  /** Subscribe to a specific event type. */
  on<T extends EventType>(
    type: T,
    listener: EventListener<T>
  ): Subscription {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);

    return {
      unsubscribe: () => {
        this.listeners.get(type)?.delete(listener);
      },
    };
  }

  /** Subscribe to all events. */
  onAny(listener: WildcardListener): Subscription {
    this.wildcardListeners.add(listener);

    return {
      unsubscribe: () => {
        this.wildcardListeners.delete(listener);
      },
    };
  }

  /** Subscribe to a specific event type, firing only once. */
  once<T extends EventType>(
    type: T,
    listener: EventListener<T>
  ): Subscription {
    const sub = this.on(type, (event) => {
      sub.unsubscribe();
      listener(event);
    });
    return sub;
  }

  /** Wait for a specific event type (promise-based). */
  waitFor<T extends EventType>(
    type: T,
    timeoutMs?: number
  ): Promise<EventOfType<T>> {
    return new Promise((resolve, reject) => {
      const sub = this.once(type, resolve as EventListener<T>);

      if (timeoutMs) {
        setTimeout(() => {
          sub.unsubscribe();
          reject(new Error(`Timeout waiting for event: ${type}`));
        }, timeoutMs);
      }
    });
  }

  /** Emit an event to all matching listeners. */
  emit(event: ForemanEvent): void {
    // Record in history
    this.history.push(event);
    if (this.history.length > this.maxHistorySize) {
      this.history = this.history.slice(-this.maxHistorySize);
    }

    if (this.paused) {
      this.pendingEvents.push(event);
      return;
    }

    this.dispatch(event);
  }

  /** Pause event delivery (events are buffered). */
  pause(): void {
    this.paused = true;
  }

  /** Resume event delivery and flush buffered events. */
  resume(): void {
    this.paused = false;
    const pending = [...this.pendingEvents];
    this.pendingEvents = [];
    for (const event of pending) {
      this.dispatch(event);
    }
  }

  /** Get event history, optionally filtered by type. */
  getHistory(type?: EventType): ForemanEvent[] {
    if (type) {
      return this.history.filter((e) => e.type === type);
    }
    return [...this.history];
  }

  /** Get the most recent N events. */
  getRecent(count: number): ForemanEvent[] {
    return this.history.slice(-count);
  }

  /** Clear all listeners and history. */
  clear(): void {
    this.listeners.clear();
    this.wildcardListeners.clear();
    this.history = [];
    this.pendingEvents = [];
  }

  /** Get listener count for a given event type. */
  listenerCount(type?: EventType): number {
    if (type) {
      return (this.listeners.get(type)?.size ?? 0) + this.wildcardListeners.size;
    }
    let total = this.wildcardListeners.size;
    for (const set of this.listeners.values()) {
      total += set.size;
    }
    return total;
  }

  private dispatch(event: ForemanEvent): void {
    // Type-specific listeners
    const typeListeners = this.listeners.get(event.type as EventType);
    if (typeListeners) {
      for (const listener of typeListeners) {
        try {
          listener(event);
        } catch (error) {
          console.error(`Event listener error (${event.type}):`, error);
        }
      }
    }

    // Wildcard listeners
    for (const listener of this.wildcardListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error(`Wildcard event listener error:`, error);
      }
    }
  }
}
