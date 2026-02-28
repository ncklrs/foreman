import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../src/tools/executor.js";

let workingDir: string;
let executor: ToolExecutor;

beforeEach(async () => {
  workingDir = await mkdtemp(join(tmpdir(), "foreman-path-safety-"));
  executor = new ToolExecutor(workingDir);

  // Create a legitimate file inside the working directory for read tests
  await writeFile(join(workingDir, "allowed.txt"), "safe content");

  // Create a subdirectory with a file
  await mkdir(join(workingDir, "subdir"), { recursive: true });
  await writeFile(join(workingDir, "subdir", "nested.txt"), "nested content");
});

afterEach(async () => {
  await rm(workingDir, { recursive: true, force: true });
});

describe("Path traversal protection", () => {
  // ─── Allowed paths ──────────────────────────────────────────

  describe("paths within the working directory", () => {
    it("allows reading a file by relative path", async () => {
      const result = await executor.execute("read_file", { path: "allowed.txt" });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("safe content");
    });

    it("allows reading a file in a subdirectory", async () => {
      const result = await executor.execute("read_file", { path: "subdir/nested.txt" });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("nested content");
    });

    it("allows writing a new file inside the working directory", async () => {
      const result = await executor.execute("write_file", {
        path: "newfile.txt",
        content: "new content",
      });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("File written");
    });

    it("allows an absolute path that resolves inside the working directory", async () => {
      const absPath = join(workingDir, "allowed.txt");
      const result = await executor.execute("read_file", { path: absPath });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("safe content");
    });

    it("allows a path with './' prefix that stays within workdir", async () => {
      const result = await executor.execute("read_file", { path: "./allowed.txt" });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("safe content");
    });

    it("allows a path that uses '..' but still resolves inside workdir", async () => {
      const result = await executor.execute("read_file", {
        path: "subdir/../allowed.txt",
      });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("safe content");
    });
  });

  // ─── Blocked paths: relative traversal ──────────────────────

  describe("relative path traversal with '../'", () => {
    it("rejects a simple '../' path", async () => {
      const result = await executor.execute("read_file", { path: "../etc/passwd" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Path traversal denied");
    });

    it("rejects a deeply nested '../' path", async () => {
      const result = await executor.execute("read_file", {
        path: "../../../etc/shadow",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Path traversal denied");
    });

    it("rejects writing to a '../' path", async () => {
      const result = await executor.execute("write_file", {
        path: "../outside.txt",
        content: "malicious",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Path traversal denied");
    });

    it("rejects editing a file via '../' path", async () => {
      const result = await executor.execute("edit_file", {
        path: "../some-file.txt",
        old_string: "a",
        new_string: "b",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Path traversal denied");
    });

    it("rejects listing files via '../' path", async () => {
      const result = await executor.execute("list_files", { path: ".." });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Path traversal denied");
    });
  });

  // ─── Blocked paths: absolute paths outside workdir ──────────

  describe("absolute paths outside the working directory", () => {
    it("rejects /etc/passwd", async () => {
      const result = await executor.execute("read_file", { path: "/etc/passwd" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Path traversal denied");
    });

    it("rejects /etc/shadow", async () => {
      const result = await executor.execute("read_file", { path: "/etc/shadow" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Path traversal denied");
    });

    it("rejects /root/.ssh/id_rsa", async () => {
      const result = await executor.execute("read_file", { path: "/root/.ssh/id_rsa" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Path traversal denied");
    });

    it("rejects /tmp when workdir is not /tmp", async () => {
      // workingDir is a subdirectory under /tmp, not /tmp itself
      const result = await executor.execute("read_file", { path: "/tmp" });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Path traversal denied");
    });

    it("rejects writing to an absolute path outside workdir", async () => {
      const result = await executor.execute("write_file", {
        path: "/tmp/evil-file.txt",
        content: "malicious content",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Path traversal denied");
    });

    it("rejects searching outside the working directory", async () => {
      const result = await executor.execute("search_codebase", {
        pattern: "root",
        path: "/etc",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Path traversal denied");
    });
  });

  // ─── Edge cases ─────────────────────────────────────────────

  describe("edge cases", () => {
    it("rejects a path that uses encoded traversal patterns like 'subdir/../../'", async () => {
      const result = await executor.execute("read_file", {
        path: "subdir/../../etc/passwd",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Path traversal denied");
    });

    it("rejects a bare '..' path", async () => {
      const result = await executor.execute("read_file", { path: ".." });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Path traversal denied");
    });

    it("rejects a path starting with the workdir name as a prefix but outside it", async () => {
      // e.g., if workdir is /tmp/foreman-abc, reject /tmp/foreman-abcdef
      const result = await executor.execute("read_file", {
        path: workingDir + "xyz/file.txt",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Path traversal denied");
    });
  });
});
