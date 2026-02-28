/**
 * Tool result cache.
 * Avoids re-reading unchanged files within an agent session.
 * Tracks file modifications to invalidate stale entries.
 */

interface CacheEntry {
  result: string;
  timestamp: number;
  /** Hash of the key arguments that produced this result. */
  keyHash: string;
}

export class ToolResultCache {
  private cache: Map<string, CacheEntry> = new Map();
  private modifiedFiles: Set<string> = new Set();
  private hits = 0;
  private misses = 0;

  /** Cache-aware tool result lookup. */
  get(toolName: string, input: Record<string, unknown>): string | null {
    // Only cache read-only tools
    if (!this.isCacheable(toolName)) return null;

    const key = this.buildKey(toolName, input);

    // Check if any relevant file was modified since cache entry
    if (toolName === "read_file") {
      const path = input.path as string;
      if (this.modifiedFiles.has(path)) {
        this.cache.delete(key);
        this.modifiedFiles.delete(path);
        this.misses++;
        return null;
      }
    }

    const entry = this.cache.get(key);
    if (entry) {
      this.hits++;
      return entry.result;
    }

    this.misses++;
    return null;
  }

  /** Store a tool result in the cache. */
  set(toolName: string, input: Record<string, unknown>, result: string): void {
    if (!this.isCacheable(toolName)) return;

    const key = this.buildKey(toolName, input);
    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      keyHash: key,
    });
  }

  /** Record that a file was modified (invalidates read cache). */
  recordFileModification(path: string): void {
    this.modifiedFiles.add(path);
    // Also invalidate any cached reads of this file
    for (const [key, entry] of this.cache.entries()) {
      if (key.includes(path)) {
        this.cache.delete(key);
      }
    }
  }

  /** Record a write/edit operation — invalidates related caches. */
  recordWrite(toolName: string, input: Record<string, unknown>): void {
    if (toolName === "write_file" || toolName === "edit_file") {
      const path = input.path as string;
      if (path) {
        this.recordFileModification(path);
      }
    }

    // run_command could modify anything — be conservative
    if (toolName === "run_command") {
      const command = input.command as string;
      // Only clear cache for commands that might modify files
      if (this.isWriteCommand(command)) {
        this.clear();
      }
    }
  }

  /** Clear all cached results. */
  clear(): void {
    this.cache.clear();
    this.modifiedFiles.clear();
  }

  /** Get cache statistics. */
  getStats(): { hits: number; misses: number; entries: number; hitRate: string } {
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? ((this.hits / total) * 100).toFixed(1) + "%" : "N/A";
    return {
      hits: this.hits,
      misses: this.misses,
      entries: this.cache.size,
      hitRate,
    };
  }

  private isCacheable(toolName: string): boolean {
    // Only cache read-only operations
    return toolName === "read_file" || toolName === "list_files" || toolName === "search_codebase";
  }

  private buildKey(toolName: string, input: Record<string, unknown>): string {
    return `${toolName}:${JSON.stringify(input, Object.keys(input).sort())}`;
  }

  private isWriteCommand(command: string): boolean {
    const writePatterns = [
      /\b(mv|cp|rm|touch|mkdir|rmdir)\b/,
      /\bchmod\b/,
      /\bchown\b/,
      /\bgit\s+(checkout|reset|merge|rebase|cherry-pick|stash)/,
      /\bnpm\s+(install|uninstall)/,
      /\bpnpm\s+(add|remove)/,
      /\byarn\s+(add|remove)/,
      /\bsed\s+-i/,
      />/,  // redirect (could write files)
      /\btee\b/,
    ];

    return writePatterns.some((p) => p.test(command));
  }
}
