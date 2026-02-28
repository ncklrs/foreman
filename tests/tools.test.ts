import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../src/tools/executor.js";

let workingDir: string;
let executor: ToolExecutor;

beforeEach(async () => {
  workingDir = await mkdtemp(join(tmpdir(), "foreman-test-"));
  executor = new ToolExecutor(workingDir);
});

afterEach(async () => {
  await rm(workingDir, { recursive: true, force: true });
});

describe("ToolExecutor", () => {
  describe("read_file", () => {
    it("reads a file with line numbers", async () => {
      await writeFile(join(workingDir, "test.txt"), "line 1\nline 2\nline 3");

      const result = await executor.execute("read_file", { path: "test.txt" });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("1\tline 1");
      expect(result.output).toContain("2\tline 2");
      expect(result.output).toContain("3\tline 3");
    });

    it("reads a file with offset and limit", async () => {
      await writeFile(join(workingDir, "test.txt"), "a\nb\nc\nd\ne");

      const result = await executor.execute("read_file", {
        path: "test.txt",
        offset: 2,
        limit: 2,
      });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("2\tb");
      expect(result.output).toContain("3\tc");
      expect(result.output).not.toContain("4\td");
    });

    it("returns error for non-existent file", async () => {
      const result = await executor.execute("read_file", { path: "missing.txt" });
      expect(result.isError).toBe(true);
    });
  });

  describe("write_file", () => {
    it("creates a new file", async () => {
      const result = await executor.execute("write_file", {
        path: "new.txt",
        content: "hello world",
      });
      expect(result.isError).toBe(false);

      const content = await readFile(join(workingDir, "new.txt"), "utf-8");
      expect(content).toBe("hello world");
    });

    it("creates parent directories", async () => {
      const result = await executor.execute("write_file", {
        path: "sub/dir/file.txt",
        content: "nested",
      });
      expect(result.isError).toBe(false);

      const content = await readFile(join(workingDir, "sub/dir/file.txt"), "utf-8");
      expect(content).toBe("nested");
    });

    it("overwrites existing file", async () => {
      await writeFile(join(workingDir, "exist.txt"), "old");

      const result = await executor.execute("write_file", {
        path: "exist.txt",
        content: "new",
      });
      expect(result.isError).toBe(false);

      const content = await readFile(join(workingDir, "exist.txt"), "utf-8");
      expect(content).toBe("new");
    });
  });

  describe("edit_file", () => {
    it("replaces a string in a file", async () => {
      await writeFile(join(workingDir, "edit.txt"), "hello world");

      const result = await executor.execute("edit_file", {
        path: "edit.txt",
        old_string: "world",
        new_string: "foreman",
      });
      expect(result.isError).toBe(false);

      const content = await readFile(join(workingDir, "edit.txt"), "utf-8");
      expect(content).toBe("hello foreman");
    });

    it("errors when old_string not found", async () => {
      await writeFile(join(workingDir, "edit.txt"), "hello world");

      const result = await executor.execute("edit_file", {
        path: "edit.txt",
        old_string: "missing",
        new_string: "replacement",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("not found");
    });

    it("errors when old_string is not unique", async () => {
      await writeFile(join(workingDir, "edit.txt"), "aaa aaa aaa");

      const result = await executor.execute("edit_file", {
        path: "edit.txt",
        old_string: "aaa",
        new_string: "bbb",
      });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("3 times");
    });
  });

  describe("run_command", () => {
    it("runs a command and returns output", async () => {
      const result = await executor.execute("run_command", { command: "echo hello" });
      expect(result.isError).toBe(false);
      expect(result.output.trim()).toBe("hello");
    });

    it("captures stderr", async () => {
      const result = await executor.execute("run_command", {
        command: "echo error >&2",
      });
      expect(result.output).toContain("error");
    });

    it("handles command failures", async () => {
      const result = await executor.execute("run_command", {
        command: "false",
      });
      expect(result.output).toContain("exit code");
    });
  });

  describe("list_files", () => {
    it("lists files in a directory", async () => {
      await writeFile(join(workingDir, "a.txt"), "");
      await writeFile(join(workingDir, "b.txt"), "");
      await mkdir(join(workingDir, "subdir"));

      const result = await executor.execute("list_files", {});
      expect(result.isError).toBe(false);
      expect(result.output).toContain("a.txt");
      expect(result.output).toContain("b.txt");
      expect(result.output).toContain("subdir");
    });
  });

  describe("unknown tool", () => {
    it("returns error for unknown tool", async () => {
      const result = await executor.execute("unknown_tool", {});
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Unknown tool");
    });
  });

  describe("task_done", () => {
    it("returns summary", async () => {
      const result = await executor.execute("task_done", {
        summary: "Completed the implementation",
      });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("Completed the implementation");
    });
  });
});
