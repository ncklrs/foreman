/**
 * Tool executor — runs the core tool set against a working directory.
 */

import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { resolve, dirname, relative, join } from "node:path";
import type { ToolExecutionResult } from "../types/index.js";

export class ToolExecutor {
  private workingDir: string;

  constructor(workingDir: string) {
    this.workingDir = workingDir;
  }

  async execute(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    const start = Date.now();

    try {
      let output: string;

      switch (toolName) {
        case "read_file":
          output = await this.readFile(input);
          break;
        case "write_file":
          output = await this.writeFile(input);
          break;
        case "edit_file":
          output = await this.editFile(input);
          break;
        case "run_command":
          output = await this.runCommand(input);
          break;
        case "search_codebase":
          output = await this.searchCodebase(input);
          break;
        case "list_files":
          output = await this.listFiles(input);
          break;
        case "git_status":
          output = await this.gitStatus();
          break;
        case "git_diff":
          output = await this.gitDiff(input);
          break;
        case "git_commit":
          output = await this.gitCommit(input);
          break;
        case "git_log":
          output = await this.gitLog(input);
          break;
        case "git_branch":
          output = await this.gitBranch(input);
          break;
        case "create_pull_request":
          output = await this.createPullRequest(input);
          break;
        case "web_fetch":
          output = await this.webFetch(input);
          break;
        case "task_done":
          output = `Task completed: ${input.summary as string}`;
          break;
        // spawn_subagent is handled by the agent loop, not the executor
        default:
          return {
            output: `Unknown tool: ${toolName}`,
            isError: true,
            duration: Date.now() - start,
          };
      }

      return {
        output,
        isError: false,
        duration: Date.now() - start,
      };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
        duration: Date.now() - start,
      };
    }
  }

  private resolvePath(inputPath: string): string {
    if (inputPath.startsWith("/")) {
      return inputPath;
    }
    return resolve(this.workingDir, inputPath);
  }

  private async readFile(input: Record<string, unknown>): Promise<string> {
    const path = this.resolvePath(input.path as string);
    const content = await readFile(path, "utf-8");

    const offset = (input.offset as number) ?? 0;
    const limit = input.limit as number | undefined;

    if (offset > 0 || limit !== undefined) {
      const lines = content.split("\n");
      const startLine = Math.max(0, offset - 1); // Convert 1-indexed to 0-indexed
      const endLine = limit !== undefined ? startLine + limit : lines.length;
      const selected = lines.slice(startLine, endLine);

      return selected
        .map((line, i) => `${startLine + i + 1}\t${line}`)
        .join("\n");
    }

    // Return with line numbers
    return content
      .split("\n")
      .map((line, i) => `${i + 1}\t${line}`)
      .join("\n");
  }

  private async writeFile(input: Record<string, unknown>): Promise<string> {
    const path = this.resolvePath(input.path as string);
    const content = input.content as string;

    // Ensure parent directory exists
    const dir = dirname(path);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    await writeFile(path, content, "utf-8");
    const lineCount = content.split("\n").length;
    return `File written: ${relative(this.workingDir, path)} (${lineCount} lines)`;
  }

  private async editFile(input: Record<string, unknown>): Promise<string> {
    const path = this.resolvePath(input.path as string);
    const oldString = input.old_string as string;
    const newString = input.new_string as string;

    const content = await readFile(path, "utf-8");

    if (!content.includes(oldString)) {
      throw new Error(
        `old_string not found in ${relative(this.workingDir, path)}. ` +
          "Make sure the string matches exactly, including whitespace and indentation."
      );
    }

    // Check for uniqueness
    const occurrences = content.split(oldString).length - 1;
    if (occurrences > 1) {
      throw new Error(
        `old_string found ${occurrences} times in ${relative(this.workingDir, path)}. ` +
          "Provide more context to make the match unique."
      );
    }

    const newContent = content.replace(oldString, newString);
    await writeFile(path, newContent, "utf-8");

    return `File edited: ${relative(this.workingDir, path)}`;
  }

  private async runCommand(input: Record<string, unknown>): Promise<string> {
    const command = input.command as string;
    const timeout = (input.timeout as number) ?? 60000;

    return new Promise<string>((resolve, reject) => {
      const child = exec(
        command,
        {
          cwd: this.workingDir,
          timeout,
          maxBuffer: 1024 * 1024 * 10, // 10MB
          env: { ...process.env },
        },
        (error, stdout, stderr) => {
          const parts: string[] = [];

          if (stdout.trim()) {
            parts.push(stdout.trim());
          }
          if (stderr.trim()) {
            parts.push(`[stderr]\n${stderr.trim()}`);
          }

          if (error && error.killed) {
            reject(new Error(`Command timed out after ${timeout}ms`));
            return;
          }

          if (error) {
            parts.push(`[exit code: ${error.code ?? 1}]`);
          }

          resolve(parts.join("\n") || "(no output)");
        }
      );

      // Safety: kill if somehow still running after timeout + grace period
      setTimeout(() => {
        child.kill("SIGKILL");
      }, timeout + 5000);
    });
  }

  private async searchCodebase(input: Record<string, unknown>): Promise<string> {
    const pattern = input.pattern as string;
    const searchPath = input.path ? this.resolvePath(input.path as string) : this.workingDir;
    const glob = input.glob as string | undefined;
    const caseSensitive = (input.case_sensitive as boolean) ?? false;
    const maxResults = (input.max_results as number) ?? 50;

    const args = ["rg", "--line-number", "--no-heading", "--color=never"];

    if (!caseSensitive) args.push("-i");
    if (glob) args.push("--glob", glob);
    args.push("--max-count", String(maxResults));
    args.push("--", pattern, searchPath);

    const command = args
      .map((a) => (a.includes(" ") ? `"${a}"` : a))
      .join(" ");

    try {
      const result = await this.runCommand({ command, timeout: 15000 });
      return result || "No matches found.";
    } catch {
      return "No matches found.";
    }
  }

  private async listFiles(input: Record<string, unknown>): Promise<string> {
    const dirPath = input.path
      ? this.resolvePath(input.path as string)
      : this.workingDir;
    const recursive = (input.recursive as boolean) ?? false;
    const globPattern = input.glob as string | undefined;

    if (recursive || globPattern) {
      // Use find or a glob for recursive listing
      const args = ["find", dirPath, "-maxdepth", recursive ? "10" : "1"];
      if (globPattern) {
        args.push("-name", globPattern);
      }
      args.push("-not", "-path", "*/node_modules/*");
      args.push("-not", "-path", "*/.git/*");

      const command = args.join(" ");
      try {
        const result = await this.runCommand({ command, timeout: 10000 });
        return result;
      } catch {
        return "(empty directory)";
      }
    }

    const entries = await readdir(dirPath, { withFileTypes: true });
    const lines = entries
      .filter((e) => !e.name.startsWith(".git"))
      .map((e) => {
        const type = e.isDirectory() ? "[dir]" : "[file]";
        return `${type}  ${e.name}`;
      });

    return lines.join("\n") || "(empty directory)";
  }

  // ─── Git Tools ──────────────────────────────────────────────────

  private async gitStatus(): Promise<string> {
    return this.runCommand({ command: "git status --short", timeout: 10000 });
  }

  private async gitDiff(input: Record<string, unknown>): Promise<string> {
    const staged = (input.staged as boolean) ?? false;
    const ref = input.ref as string | undefined;
    const path = input.path as string | undefined;

    const args = ["git", "diff"];
    if (staged) args.push("--cached");
    if (ref) args.push(ref);
    if (path) args.push("--", path);

    return this.runCommand({ command: args.join(" "), timeout: 15000 });
  }

  private async gitCommit(input: Record<string, unknown>): Promise<string> {
    const message = input.message as string;
    const files = input.files as string[] | undefined;

    // Stage files
    if (files && files.length > 0) {
      const escaped = files.map((f) => `"${f}"`).join(" ");
      await this.runCommand({ command: `git add ${escaped}`, timeout: 10000 });
    } else {
      await this.runCommand({ command: "git add -A", timeout: 10000 });
    }

    // Commit — use heredoc to handle message with special chars
    const escapedMsg = message.replace(/'/g, "'\\''");
    const result = await this.runCommand({
      command: `git commit -m '${escapedMsg}'`,
      timeout: 15000,
    });

    return result;
  }

  private async gitLog(input: Record<string, unknown>): Promise<string> {
    const count = (input.count as number) ?? 10;
    const oneline = (input.oneline as boolean) ?? true;
    const ref = (input.ref as string) ?? "HEAD";

    const format = oneline ? "--oneline" : "--format=%H %an %ad %s";
    return this.runCommand({
      command: `git log ${format} -${count} ${ref}`,
      timeout: 10000,
    });
  }

  private async gitBranch(input: Record<string, unknown>): Promise<string> {
    const action = input.action as string;
    const name = input.name as string | undefined;

    switch (action) {
      case "list":
        return this.runCommand({ command: "git branch -a", timeout: 10000 });
      case "create":
        if (!name) throw new Error("Branch name is required for create action");
        return this.runCommand({ command: `git checkout -b '${name}'`, timeout: 10000 });
      case "switch":
        if (!name) throw new Error("Branch name is required for switch action");
        return this.runCommand({ command: `git checkout '${name}'`, timeout: 10000 });
      default:
        throw new Error(`Unknown branch action: ${action}`);
    }
  }

  private async createPullRequest(input: Record<string, unknown>): Promise<string> {
    const title = input.title as string;
    const body = input.body as string;
    const base = (input.base as string) ?? "main";
    const draft = (input.draft as boolean) ?? false;

    // Get current branch name
    const branchResult = await this.runCommand({
      command: "git rev-parse --abbrev-ref HEAD",
      timeout: 5000,
    });
    const branch = branchResult.trim();

    if (branch === base) {
      throw new Error(`Cannot create PR: currently on base branch '${base}'. Create a feature branch first.`);
    }

    // Push branch to remote
    await this.runCommand({
      command: `git push -u origin '${branch}'`,
      timeout: 30000,
    });

    // Create PR via gh CLI
    const escapedTitle = title.replace(/'/g, "'\\''");
    const escapedBody = body.replace(/'/g, "'\\''");
    const args = [
      "gh", "pr", "create",
      "--title", `'${escapedTitle}'`,
      "--body", `'${escapedBody}'`,
      "--base", base,
    ];
    if (draft) args.push("--draft");

    const result = await this.runCommand({
      command: args.join(" "),
      timeout: 30000,
    });

    return result;
  }

  // ─── Web Tools ──────────────────────────────────────────────────

  private async webFetch(input: Record<string, unknown>): Promise<string> {
    const url = input.url as string;
    const method = (input.method as string) ?? "GET";
    const headers = (input.headers as Record<string, string>) ?? {};
    const body = input.body as string | undefined;
    const maxLength = (input.max_length as number) ?? 50000;

    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }

    // Block non-http(s) schemes
    if (!parsedUrl.protocol.startsWith("http")) {
      throw new Error(`Only HTTP/HTTPS URLs are supported, got: ${parsedUrl.protocol}`);
    }

    const fetchOptions: RequestInit = {
      method,
      headers: {
        "User-Agent": "Foreman/1.0",
        ...headers,
      },
      signal: AbortSignal.timeout(30000),
    };

    if (body && method !== "GET") {
      fetchOptions.body = body;
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    let text: string;

    if (contentType.includes("application/json")) {
      const json = await response.json();
      text = JSON.stringify(json, null, 2);
    } else {
      text = await response.text();
    }

    if (text.length > maxLength) {
      text = text.slice(0, maxLength) + `\n\n[truncated — ${text.length} chars total]`;
    }

    return `[${response.status} ${response.statusText}]\n${text}`;
  }
}
