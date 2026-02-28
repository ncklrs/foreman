import { describe, it, expect } from "vitest";
import { ToolResultCache } from "../src/runtime/cache.js";

describe("ToolResultCache", () => {
  it("caches read-only tool results", () => {
    const cache = new ToolResultCache();

    cache.set("read_file", { path: "src/index.ts" }, "file contents here");

    const result = cache.get("read_file", { path: "src/index.ts" });
    expect(result).toBe("file contents here");
  });

  it("returns null for cache misses", () => {
    const cache = new ToolResultCache();

    const result = cache.get("read_file", { path: "nonexistent.ts" });
    expect(result).toBeNull();
  });

  it("does not cache write operations", () => {
    const cache = new ToolResultCache();

    cache.set("write_file", { path: "a.ts", content: "x" }, "File written");

    const result = cache.get("write_file", { path: "a.ts", content: "x" });
    expect(result).toBeNull();
  });

  it("invalidates cache when file is modified", () => {
    const cache = new ToolResultCache();

    cache.set("read_file", { path: "src/index.ts" }, "original content");
    cache.recordFileModification("src/index.ts");

    const result = cache.get("read_file", { path: "src/index.ts" });
    expect(result).toBeNull();
  });

  it("invalidates cache on write_file", () => {
    const cache = new ToolResultCache();

    cache.set("read_file", { path: "src/index.ts" }, "original content");
    cache.recordWrite("write_file", { path: "src/index.ts" });

    const result = cache.get("read_file", { path: "src/index.ts" });
    expect(result).toBeNull();
  });

  it("invalidates cache on edit_file", () => {
    const cache = new ToolResultCache();

    cache.set("read_file", { path: "src/index.ts" }, "original content");
    cache.recordWrite("edit_file", { path: "src/index.ts" });

    const result = cache.get("read_file", { path: "src/index.ts" });
    expect(result).toBeNull();
  });

  it("clears all cache on potentially destructive commands", () => {
    const cache = new ToolResultCache();

    cache.set("read_file", { path: "a.ts" }, "content a");
    cache.set("read_file", { path: "b.ts" }, "content b");

    cache.recordWrite("run_command", { command: "mv a.ts c.ts" });

    expect(cache.get("read_file", { path: "a.ts" })).toBeNull();
    expect(cache.get("read_file", { path: "b.ts" })).toBeNull();
  });

  it("does not clear cache for read-only commands", () => {
    const cache = new ToolResultCache();

    cache.set("read_file", { path: "a.ts" }, "content a");
    cache.recordWrite("run_command", { command: "ls -la" });

    // ls is not a write command, cache should persist
    expect(cache.get("read_file", { path: "a.ts" })).toBe("content a");
  });

  it("tracks cache statistics", () => {
    const cache = new ToolResultCache();

    cache.set("read_file", { path: "a.ts" }, "content");
    cache.get("read_file", { path: "a.ts" }); // hit
    cache.get("read_file", { path: "b.ts" }); // miss

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.entries).toBe(1);
    expect(stats.hitRate).toBe("50.0%");
  });

  it("caches list_files and search_codebase results", () => {
    const cache = new ToolResultCache();

    cache.set("list_files", { path: "src/" }, "file1.ts\nfile2.ts");
    cache.set("search_codebase", { pattern: "TODO" }, "src/index.ts:10: // TODO");

    expect(cache.get("list_files", { path: "src/" })).toBe("file1.ts\nfile2.ts");
    expect(cache.get("search_codebase", { pattern: "TODO" })).toBe("src/index.ts:10: // TODO");
  });

  it("caches git_status, git_diff, and git_log results", () => {
    const cache = new ToolResultCache();

    cache.set("git_status", {}, "M src/index.ts");
    cache.set("git_diff", {}, "+new line\n-old line");
    cache.set("git_log", { count: 5 }, "abc123 initial commit");

    expect(cache.get("git_status", {})).toBe("M src/index.ts");
    expect(cache.get("git_diff", {})).toBe("+new line\n-old line");
    expect(cache.get("git_log", { count: 5 })).toBe("abc123 initial commit");
  });

  it("invalidates git caches on file modification", () => {
    const cache = new ToolResultCache();

    cache.set("git_status", {}, "clean");
    cache.set("git_diff", {}, "no changes");

    // Simulate a file write
    cache.recordWrite("write_file", { path: "src/app.ts" });

    // Git caches should be invalidated
    expect(cache.get("git_status", {})).toBeNull();
    expect(cache.get("git_diff", {})).toBeNull();
  });

  it("invalidates git caches on git_commit", () => {
    const cache = new ToolResultCache();

    cache.set("git_status", {}, "M file.ts");
    cache.set("git_log", { count: 5 }, "old log");

    cache.recordWrite("git_commit", { message: "fix" });

    expect(cache.get("git_status", {})).toBeNull();
    expect(cache.get("git_log", { count: 5 })).toBeNull();
  });

  it("does not cache write operations like git_commit", () => {
    const cache = new ToolResultCache();

    cache.set("git_commit", { message: "test" }, "committed");
    expect(cache.get("git_commit", { message: "test" })).toBeNull();
  });
});
