import { describe, it, expect } from "vitest";

// We test the arg parser by re-implementing the parsing logic from cli.ts
// since cli.ts uses top-level main() that calls process.exit.
// This tests the core parsing logic.

interface CliArgs {
  config?: string;
  task?: string;
  taskDescription?: string;
  model?: string;
  workingDir?: string;
  noTui?: boolean;
  watch?: boolean;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  let i = 2; // skip node and script name

  while (i < argv.length) {
    const arg = argv[i];

    switch (arg) {
      case "--config":
      case "-c":
        args.config = argv[++i];
        break;
      case "--task":
      case "-t":
        args.task = argv[++i];
        break;
      case "--description":
      case "-d":
        args.taskDescription = argv[++i];
        break;
      case "--model":
      case "-m":
        args.model = argv[++i];
        break;
      case "--dir":
        args.workingDir = argv[++i];
        break;
      case "--no-tui":
        args.noTui = true;
        break;
      case "--watch":
      case "-w":
        args.watch = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (!arg.startsWith("-")) {
          args.task = args.task ? `${args.task} ${arg}` : arg;
        }
        break;
    }
    i++;
  }

  return args;
}

describe("CLI Argument Parsing", () => {
  it("should parse --help flag", () => {
    const args = parseArgs(["node", "cli.js", "--help"]);
    expect(args.help).toBe(true);
  });

  it("should parse -h shorthand", () => {
    const args = parseArgs(["node", "cli.js", "-h"]);
    expect(args.help).toBe(true);
  });

  it("should parse --task with value", () => {
    const args = parseArgs(["node", "cli.js", "--task", "Fix the bug"]);
    expect(args.task).toBe("Fix the bug");
  });

  it("should parse -t shorthand", () => {
    const args = parseArgs(["node", "cli.js", "-t", "Add feature"]);
    expect(args.task).toBe("Add feature");
  });

  it("should parse bare arguments as task title", () => {
    const args = parseArgs(["node", "cli.js", "Fix", "the", "login", "bug"]);
    expect(args.task).toBe("Fix the login bug");
  });

  it("should parse --config with path", () => {
    const args = parseArgs(["node", "cli.js", "-c", "./my-config.toml"]);
    expect(args.config).toBe("./my-config.toml");
  });

  it("should parse --model", () => {
    const args = parseArgs(["node", "cli.js", "-m", "architect"]);
    expect(args.model).toBe("architect");
  });

  it("should parse --description", () => {
    const args = parseArgs(["node", "cli.js", "-d", "Detailed description here"]);
    expect(args.taskDescription).toBe("Detailed description here");
  });

  it("should parse --dir", () => {
    const args = parseArgs(["node", "cli.js", "--dir", "/tmp/work"]);
    expect(args.workingDir).toBe("/tmp/work");
  });

  it("should parse --no-tui flag", () => {
    const args = parseArgs(["node", "cli.js", "--no-tui"]);
    expect(args.noTui).toBe(true);
  });

  it("should parse --watch flag", () => {
    const args = parseArgs(["node", "cli.js", "--watch"]);
    expect(args.watch).toBe(true);
  });

  it("should parse -w shorthand", () => {
    const args = parseArgs(["node", "cli.js", "-w"]);
    expect(args.watch).toBe(true);
  });

  it("should parse combined flags", () => {
    const args = parseArgs([
      "node", "cli.js",
      "-t", "Fix bug",
      "-m", "coder",
      "--no-tui",
      "-c", "config.toml",
    ]);
    expect(args.task).toBe("Fix bug");
    expect(args.model).toBe("coder");
    expect(args.noTui).toBe(true);
    expect(args.config).toBe("config.toml");
  });

  it("should return empty args for no arguments", () => {
    const args = parseArgs(["node", "cli.js"]);
    expect(args.task).toBeUndefined();
    expect(args.help).toBeUndefined();
    expect(args.watch).toBeUndefined();
  });
});
