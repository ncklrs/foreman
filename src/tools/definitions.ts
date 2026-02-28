/**
 * Tool definitions for the agent runtime.
 * These are the core six tools plus task_done that replace Claude Code's built-in tools.
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
      "Execute a shell command and return its stdout, stderr, and exit code. Use this for running tests, build commands, git operations, and other CLI tools. Commands run in the sandbox's working directory.",
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
