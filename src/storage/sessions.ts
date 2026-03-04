/**
 * Session persistence store.
 * Saves and loads agent sessions to/from disk for recovery on restart.
 */

import { readFile, writeFile, readdir, mkdir, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentSession } from "../types/index.js";

export class SessionStore {
  private dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(homedir(), ".foreman", "sessions");
  }

  /** Save a session to disk. */
  async save(session: AgentSession): Promise<void> {
    await this.ensureDir();
    const path = this.sessionPath(session.id);
    const data = JSON.stringify(session, null, 2);
    await writeFile(path, data, "utf-8");
  }

  /** Load a session by ID. */
  async load(id: string): Promise<AgentSession | null> {
    const path = this.sessionPath(id);
    try {
      const data = await readFile(path, "utf-8");
      return this.deserialize(data);
    } catch {
      return null;
    }
  }

  /** Load all persisted sessions. */
  async loadAll(): Promise<AgentSession[]> {
    await this.ensureDir();
    const sessions: AgentSession[] = [];

    try {
      const files = await readdir(this.dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const data = await readFile(join(this.dir, file), "utf-8");
          const session = this.deserialize(data);
          if (session) sessions.push(session);
        } catch {
          // Skip corrupt files
        }
      }
    } catch {
      // Directory might not exist yet
    }

    return sessions;
  }

  /** Delete a session from disk. */
  async delete(id: string): Promise<void> {
    const path = this.sessionPath(id);
    try {
      await unlink(path);
    } catch {
      // Already deleted
    }
  }

  /** Prune old sessions (keep last N by file modification time). */
  async prune(keepLast = 50): Promise<number> {
    await this.ensureDir();
    try {
      const files = await readdir(this.dir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      if (jsonFiles.length <= keepLast) return 0;

      // Use file modification time instead of loading full JSON
      const fileStats = await Promise.all(
        jsonFiles.map(async (f) => {
          const path = join(this.dir, f);
          const s = await stat(path);
          return { file: f, path, mtime: s.mtimeMs };
        })
      );

      // Sort newest first, delete excess
      fileStats.sort((a, b) => b.mtime - a.mtime);
      const toDelete = fileStats.slice(keepLast);
      for (const entry of toDelete) {
        await unlink(entry.path).catch(() => {});
      }

      return toDelete.length;
    } catch {
      return 0;
    }
  }

  private sessionPath(id: string): string {
    // Sanitize ID for use as filename
    const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.dir, `${safe}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private deserialize(data: string): AgentSession | null {
    try {
      const raw = JSON.parse(data) as Record<string, unknown>;
      // Restore Date objects
      if (raw.startedAt) raw.startedAt = new Date(raw.startedAt as string);
      if (raw.completedAt) raw.completedAt = new Date(raw.completedAt as string);
      if (Array.isArray(raw.artifacts)) {
        for (const a of raw.artifacts as Array<Record<string, unknown>>) {
          if (a.createdAt) a.createdAt = new Date(a.createdAt as string);
        }
      }
      return raw as unknown as AgentSession;
    } catch {
      return null;
    }
  }
}
