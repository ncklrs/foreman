/**
 * Tool result cache.
 * Avoids re-reading unchanged files within an agent session.
 * Tracks file modifications to invalidate stale entries.
 */

interface CacheEntry {
  result: string;
  timestamp: number;
}

export class ToolResultCache {
  private cache: Map<string, CacheEntry> = new Map();
  private modifiedFiles: Set<string> = new Set();
  /** Reverse index: file path → cache keys that reference it. */
  private pathToKeys: Map<string, Set<string>> = new Map();
  private hits = 0;
  private misses = 0;
  private maxEntries = 200;

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

    // Evict oldest entries if at capacity
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }

    this.cache.set(key, { result, timestamp: Date.now() });

    // Track path → key mapping for efficient invalidation
    const path = input.path as string | undefined;
    if (path) {
      let keys = this.pathToKeys.get(path);
      if (!keys) {
        keys = new Set();
        this.pathToKeys.set(path, keys);
      }
      keys.add(key);
    }
  }

  /** Record that a file was modified (invalidates read cache). */
  recordFileModification(path: string): void {
    this.modifiedFiles.add(path);
    // Invalidate cache entries for this exact path via reverse index
    const keys = this.pathToKeys.get(path);
    if (keys) {
      for (const key of keys) {
        this.cache.delete(key);
      }
      this.pathToKeys.delete(path);
    }
  }

  /** Record a write/edit operation — invalidates related caches. */
  recordWrite(toolName: string, input: Record<string, unknown>): void {
    if (toolName === "write_file" || toolName === "edit_file") {
      const path = input.path as string;
      if (path) {
        this.recordFileModification(path);
      }
      // File modifications invalidate git status/diff caches
      this.invalidateGitCaches();
    }

    // git_commit changes git state — invalidate git caches
    if (toolName === "git_commit" || toolName === "git_branch" || toolName === "create_pull_request") {
      this.invalidateGitCaches();
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

  /** Invalidate cached git results (status, diff, log). */
  private invalidateGitCaches(): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith("git_status:") || key.startsWith("git_diff:") || key.startsWith("git_log:")) {
        this.cache.delete(key);
      }
    }
  }

  /** Clear all cached results. */
  clear(): void {
    this.cache.clear();
    this.modifiedFiles.clear();
    this.pathToKeys.clear();
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
    switch (toolName) {
      case "read_file":
      case "list_files":
      case "search_codebase":
      case "git_status":
      case "git_diff":
      case "git_log":
        return true;
      default:
        return false;
    }
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
