#!/usr/bin/env node

/**
 * Foreman CLI entry point.
 * Parses arguments, loads configuration, and starts the runtime.
 */

import { loadConfig } from "./config/loader.js";
import { Orchestrator } from "./orchestrator.js";
import type { ForemanConfig, ForemanEvent, AgentSession, PolicyEvaluation } from "./types/index.js";

interface CliArgs {
  config?: string;
  task?: string;
  taskDescription?: string;
  model?: string;
  workingDir?: string;
  noTui?: boolean;
  watch?: boolean;
  autopilot?: boolean;
  autopilotOnce?: boolean;
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
      case "--autopilot":
        args.autopilot = true;
        break;
      case "--autopilot-once":
        args.autopilotOnce = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        // Treat bare arguments as task title
        if (!arg.startsWith("-")) {
          args.task = args.task ? `${args.task} ${arg}` : arg;
        }
        break;
    }
    i++;
  }

  return args;
}

function printHelp(): void {
  console.log(`
Foreman — Model-agnostic agentic coding runtime

USAGE
  foreman [OPTIONS] [TASK]

OPTIONS
  -c, --config <path>        Path to foreman.toml config file
  -t, --task <title>         Task title to execute
  -d, --description <text>   Task description
  -m, --model <role>         Force a specific model role (e.g., "architect", "coder")
      --dir <path>           Working directory for the agent
      --no-tui               Run without the terminal UI
  -w, --watch                Watch Linear for new tasks
      --autopilot            Start autopilot mode (cron-scheduled self-managing)
      --autopilot-once       Run one autopilot scan immediately, then exit
  -h, --help                 Show this help message

EXAMPLES
  foreman "Fix the login bug"
  foreman --task "Add dark mode" --model architect
  foreman --watch
  foreman --autopilot
  foreman --autopilot-once --no-tui
  foreman --config ./custom-foreman.toml --watch

CONFIGURATION
  Foreman looks for configuration in:
    1. ./foreman.toml
    2. ./.foreman.toml
    3. ~/.config/foreman/foreman.toml
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Load config
  let config: ForemanConfig;
  try {
    config = await loadConfig(args.config);
  } catch (error) {
    // If no config file and we have a task, use sensible defaults
    if (args.task) {
      config = getDefaultConfig();
    } else {
      console.error(
        `Error: ${error instanceof Error ? error.message : error}`
      );
      console.error('Run "foreman --help" for usage information.');
      process.exit(1);
    }
  }

  // Create orchestrator
  const orchestrator = new Orchestrator(config);

  // Handle shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    await orchestrator.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Initialize
  await orchestrator.initialize();

  if (args.noTui) {
    // Non-TUI mode: just log events
    orchestrator.getEventBus().onAny((event) => {
      switch (event.type) {
        case "agent:started":
          console.log(`[agent] Started: ${event.session.task.title}`);
          break;
        case "agent:stream":
          if (event.event.text) process.stdout.write(event.event.text);
          break;
        case "agent:tool_call":
          console.log(`\n[tool] ${event.toolName}`);
          break;
        case "agent:completed":
          console.log(`\n[agent] Completed: ${event.session.task.title}`);
          break;
        case "agent:failed":
          console.error(`\n[agent] Failed: ${event.error}`);
          break;
      }
    });
  } else {
    // TUI mode: render Ink React app
    await startTUI(orchestrator);
  }

  // Run a single task if provided
  if (args.task) {
    orchestrator.enqueueTask({
      id: `task_${Date.now()}`,
      title: args.task,
      description: args.taskDescription ?? args.task,
      assignedModel: args.model,
    });
  }

  // Autopilot event logging in --no-tui mode
  if (args.noTui && (args.autopilot || args.autopilotOnce)) {
    orchestrator.getEventBus().onAny((event) => {
      switch (event.type) {
        case "autopilot:run_started":
          console.log(`\n[autopilot] Run started: ${event.run.id}`);
          break;
        case "autopilot:scan_complete":
          console.log(`[autopilot] Scan complete: ${event.findingsCount} findings`);
          break;
        case "autopilot:ticket_created":
          console.log(`[autopilot] Ticket created: ${event.ticketId} — ${event.finding.title}`);
          break;
        case "autopilot:resolve_started":
          console.log(`[autopilot] Resolving: ${event.finding.title}`);
          break;
        case "autopilot:run_completed":
          console.log(`[autopilot] Run completed: ${event.run.ticketsCreated.length} tickets, ${event.run.ticketsResolved.length} resolved`);
          break;
      }
    });
  }

  // Autopilot-once: run a single scan and exit
  if (args.autopilotOnce) {
    const engine = orchestrator.getAutopilotEngine();
    if (!engine) {
      console.error("Error: autopilot is not configured. Add [autopilot] section to foreman.toml.");
      process.exit(1);
    }
    orchestrator.start();
    const run = await engine.triggerRun();
    await orchestrator.stop();
    console.log(`\nAutopilot run ${run.status}: ${run.findings.length} findings, ${run.ticketsCreated.length} tickets created`);
    process.exit(run.status === "failed" ? 1 : 0);
  }

  // Watch mode (includes autopilot if --autopilot is set)
  if (args.watch || args.autopilot) {
    orchestrator.start();
    if (args.watch) console.log("Watching for tasks...");
    if (args.autopilot) console.log(`Autopilot active (schedule: ${config.autopilot?.schedule ?? "not configured"})`);
  }

  // If we have a task but not watching/autopiloting, wait for completion
  if (args.task && !args.watch && !args.autopilot) {
    orchestrator.start();

    // Wait for all tasks to complete
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const sessions = orchestrator.getSessions();
        const allDone = sessions.every(
          (s) => s.status === "completed" || s.status === "failed"
        );
        if (allDone && sessions.length > 0) {
          clearInterval(check);
          resolve();
        }
      }, 1000);
    });

    await orchestrator.stop();

    // Exit with error if any task failed
    const sessions = orchestrator.getSessions();
    const hasFailed = sessions.some((s) => s.status === "failed");
    process.exit(hasFailed ? 1 : 0);
  }
}

async function startTUI(orchestrator: Orchestrator): Promise<void> {
  // Dynamic import to avoid loading React/Ink when running in --no-tui mode
  const { render } = await import("ink");
  const React = await import("react");
  const { App } = await import("./tui/App.js");

  const events: ForemanEvent[] = [];
  const sessions: AgentSession[] = [];

  // Subscribe to all events and accumulate them for the TUI
  orchestrator.getEventBus().onAny((event) => {
    events.push(event);
    // Keep only last 500 events in memory
    if (events.length > 500) events.splice(0, events.length - 500);
  });

  // Periodically sync sessions from orchestrator
  const syncInterval = setInterval(() => {
    sessions.length = 0;
    sessions.push(...orchestrator.getSessions());
  }, 500);

  const config = orchestrator.getConfig();

  const instance = render(
    React.createElement(App, {
      config,
      events,
      sessions,
      providerHealth: orchestrator.getProviderHealth(),
      performanceStats: orchestrator.getPerformanceStats(),
      onApproval: (handler: (evaluation: PolicyEvaluation, session: AgentSession) => Promise<boolean>) => {
        orchestrator.setApprovalHandler(handler);
      },
    })
  );

  // When the TUI exits, clean up
  instance.waitUntilExit().then(() => {
    clearInterval(syncInterval);
  });
}

function getDefaultConfig(): ForemanConfig {
  return {
    foreman: {
      name: "foreman",
      logLevel: "info" as const,
      maxConcurrentAgents: 1,
    },
    models: {
      coder: {
        provider: "anthropic" as const,
        model: "claude-sonnet-4-5-20250929",
        role: "code generation",
        maxTokens: 4096,
        temperature: 0.2,
      },
    },
    routing: {
      strategy: "capability_match" as const,
      fallbackChain: ["coder"],
    },
    sandbox: {
      type: "local" as const,
      warmPool: 1,
      timeoutMinutes: 30,
      cleanup: "on_success" as const,
    },
    policy: {
      protectedPaths: ["package.json", ".env"],
      blockedCommands: ["rm -rf /"],
      maxDiffLines: 500,
      requireApprovalAbove: 200,
    },
  };
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
