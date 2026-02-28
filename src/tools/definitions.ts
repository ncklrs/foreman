/**
 * Tool definitions for the agent runtime.
 * Core filesystem/shell tools, git tools, web fetch, sub-agent spawning, and task_done.
 */

import type { ToolDefinition } from "../types/index.js";

export const CORE_TOOLS: ToolDefinition[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file at the given path. Returns the full file contents as a string. Use this to understand existing code before making changes.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to the file to read",
        },
        offset: {
          type: "number",
          description: "Optional line number to start reading from (1-indexed)",
        },
        limit: {
          type: "number",
          description: "Optional maximum number of lines to read",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file, creating it if it doesn't exist or overwriting if it does. Use this for creating new files or completely replacing file contents.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to the file to write",
        },
        content: {
          type: "string",
          description: "The full content to write to the file",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description:
      "Apply a targeted edit to a file by replacing an exact string match with new content. The old_string must match exactly (including whitespace and indentation). Use this for surgical edits rather than rewriting entire files.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to the file to edit",
        },
        old_string: {
          type: "string",
          description:
            "The exact string to find in the file. Must match exactly including whitespace.",
        },
        new_string: {
          type: "string",
          description: "The string to replace old_string with",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "run_command",
    description:
      "Execute a shell command and return its stdout, stderr, and exit code. Use this for running tests, build commands, and other CLI tools. Commands run in the sandbox's working directory.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
        timeout: {
          type: "number",
          description:
            "Optional timeout in milliseconds (default: 60000). Command will be killed if it exceeds this.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "search_codebase",
    description:
      "Search for a pattern in files using ripgrep. Returns matching lines with file paths and line numbers. Supports regular expressions. Use this to find relevant code, usages, and definitions.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "The search pattern (regex supported)",
        },
        path: {
          type: "string",
          description:
            "Optional directory or file path to limit the search scope",
        },
        glob: {
          type: "string",
          description:
            'Optional glob pattern to filter files (e.g. "*.ts", "src/**/*.js")',
        },
        case_sensitive: {
          type: "boolean",
          description: "Whether the search should be case-sensitive (default: false)",
        },
        max_results: {
          type: "number",
          description: "Maximum number of matching lines to return (default: 50)",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "list_files",
    description:
      "List files and directories at the given path. Returns names with type indicators (file/directory). Use this to explore project structure.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory path to list (default: current working directory)",
        },
        recursive: {
          type: "boolean",
          description:
            "If true, list files recursively. Use with caution on large directories.",
        },
        glob: {
          type: "string",
          description:
            'Optional glob pattern to filter results (e.g. "*.ts", "**/*.test.js")',
        },
      },
    },
  },

  // ─── Git Tools ──────────────────────────────────────────────────
  {
    name: "git_status",
    description:
      "Show the working tree status — staged, modified, and untracked files. Use this to understand the current state before committing.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "git_diff",
    description:
      "Show changes in the working tree. By default shows unstaged changes. Use staged=true for staged changes, or provide a ref to diff against.",
    inputSchema: {
      type: "object",
      properties: {
        staged: {
          type: "boolean",
          description: "Show staged (cached) changes instead of working tree changes",
        },
        ref: {
          type: "string",
          description: "Git ref to diff against (e.g. HEAD~1, main, a commit SHA)",
        },
        path: {
          type: "string",
          description: "Optional path to restrict the diff to a specific file or directory",
        },
      },
    },
  },
  {
    name: "git_commit",
    description:
      "Stage files and create a git commit. If no files are specified, stages all modified and new files. Always provide a clear, descriptive commit message.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The commit message. Should be descriptive and follow conventional commit style.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of files to stage before committing. If omitted, stages all changes.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "git_log",
    description:
      "Show recent commit history. Returns commit hash, author, date, and message.",
    inputSchema: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of commits to show (default: 10)",
        },
        oneline: {
          type: "boolean",
          description: "Show compact one-line format (default: true)",
        },
        ref: {
          type: "string",
          description: "Branch or ref to show history for (default: HEAD)",
        },
      },
    },
  },
  {
    name: "git_branch",
    description:
      "Create, switch, or list git branches. Use this to manage branches before making changes.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "switch"],
          description: "Branch operation: list, create, or switch",
        },
        name: {
          type: "string",
          description: "Branch name (required for create/switch)",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "create_pull_request",
    description:
      "Push the current branch to the remote and create a pull request. Requires git commits to exist on the branch. Returns the PR URL.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Pull request title",
        },
        body: {
          type: "string",
          description: "Pull request description/body in markdown",
        },
        base: {
          type: "string",
          description: "Base branch to merge into (default: main)",
        },
        draft: {
          type: "boolean",
          description: "Create as draft PR (default: false)",
        },
      },
      required: ["title", "body"],
    },
  },

  // ─── Web Tools ──────────────────────────────────────────────────
  {
    name: "web_fetch",
    description:
      "Fetch content from a URL and return it as text. Useful for reading documentation, API responses, or checking endpoints. HTML is returned as-is (agent should extract what it needs).",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
          description: "HTTP method (default: GET)",
        },
        headers: {
          type: "object",
          description: "Optional HTTP headers as key-value pairs",
        },
        body: {
          type: "string",
          description: "Optional request body (for POST/PUT/PATCH)",
        },
        max_length: {
          type: "number",
          description: "Maximum response length in characters (default: 50000)",
        },
      },
      required: ["url"],
    },
  },

  // ─── Sub-Agent Tool ─────────────────────────────────────────────
  {
    name: "spawn_subagent",
    description:
      "Delegate a subtask to a separate agent that runs independently. The sub-agent gets its own conversation and can use a different model. Useful for parallelizing work or using a specialist model for a specific part of a task. Returns the sub-agent's summary and files changed.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title for the subtask",
        },
        description: {
          type: "string",
          description: "Detailed description of what the sub-agent should accomplish",
        },
        model_role: {
          type: "string",
          description:
            'Model role to assign (e.g. "coder", "fast", "architect"). Defaults to "coder".',
        },
        max_iterations: {
          type: "number",
          description: "Maximum iterations for the sub-agent (default: 25)",
        },
      },
      required: ["title", "description"],
    },
  },

  // ─── Task Completion ────────────────────────────────────────────
  {
    name: "task_done",
    description:
      "Signal that you have completed the assigned task. Call this when all work is done, tests pass, and the changes are ready for review. Include a summary of what was accomplished.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "A concise summary of the work done, changes made, and any important notes for the reviewer.",
        },
        files_changed: {
          type: "array",
          items: { type: "string" },
          description: "List of files that were created, modified, or deleted.",
        },
      },
      required: ["summary"],
    },
  },
];
