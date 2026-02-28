import { describe, it, expect } from "vitest";
import { parseTOML, validateConfig } from "../src/config/loader.js";
import type { ForemanConfig } from "../src/types/index.js";

describe("TOML Parser", () => {
  it("parses basic key-value pairs", () => {
    const result = parseTOML(`
name = "foreman"
log_level = "info"
max_agents = 10
enabled = true
    `);

    expect(result.name).toBe("foreman");
    expect(result.log_level).toBe("info");
    expect(result.max_agents).toBe(10);
    expect(result.enabled).toBe(true);
  });

  it("parses tables", () => {
    const result = parseTOML(`
[foreman]
name = "test"
log_level = "debug"
    `);

    const foreman = result.foreman as Record<string, unknown>;
    expect(foreman.name).toBe("test");
    expect(foreman.log_level).toBe("debug");
  });

  it("parses nested tables", () => {
    const result = parseTOML(`
[sandbox.cloud]
provider = "fly"
app = "my-app"
region = "iad"
    `);

    const sandbox = result.sandbox as Record<string, unknown>;
    const cloud = sandbox.cloud as Record<string, unknown>;
    expect(cloud.provider).toBe("fly");
    expect(cloud.app).toBe("my-app");
    expect(cloud.region).toBe("iad");
  });

  it("parses arrays", () => {
    const result = parseTOML(`
labels = ["agent-ready", "bug"]
numbers = [1, 2, 3]
    `);

    expect(result.labels).toEqual(["agent-ready", "bug"]);
    expect(result.numbers).toEqual([1, 2, 3]);
  });

  it("ignores comments", () => {
    const result = parseTOML(`
# This is a comment
name = "test" # inline comment doesn't work in our parser but line comments do
    `);

    expect(result.name).toBe("test");
  });

  it("handles empty input", () => {
    const result = parseTOML("");
    expect(result).toEqual({});
  });

  it("parses a full foreman config", () => {
    const result = parseTOML(`
[foreman]
name = "hive-fleet-01"
log_level = "info"
max_concurrent_agents = 10

[models.coder]
provider = "anthropic"
model = "claude-sonnet-4-5-20250929"
role = "code generation"
max_tokens = 4096
temperature = 0.2

[routing]
strategy = "capability_match"
fallback_chain = ["coder", "architect", "fast"]

[sandbox]
type = "docker"
warm_pool = 3
timeout_minutes = 30
cleanup = "on_success"

[policy]
protected_paths = ["package.json", ".env*"]
blocked_commands = ["rm -rf /"]
max_diff_lines = 500
require_approval_above = 200
    `);

    const foreman = result.foreman as Record<string, unknown>;
    expect(foreman.name).toBe("hive-fleet-01");
    expect(foreman.max_concurrent_agents).toBe(10);

    const models = result.models as Record<string, Record<string, unknown>>;
    expect(models.coder.provider).toBe("anthropic");
    expect(models.coder.temperature).toBe(0.2);

    const routing = result.routing as Record<string, unknown>;
    expect(routing.strategy).toBe("capability_match");
    expect(routing.fallback_chain).toEqual(["coder", "architect", "fast"]);

    const policy = result.policy as Record<string, unknown>;
    expect(policy.max_diff_lines).toBe(500);
    expect(policy.protected_paths).toEqual(["package.json", ".env*"]);
  });
});

describe("Config Validation", () => {
  function makeValidConfig(): ForemanConfig {
    return {
      foreman: {
        name: "test",
        logLevel: "info",
        maxConcurrentAgents: 5,
      },
      models: {
        coder: {
          provider: "anthropic",
          model: "claude-sonnet-4-5-20250929",
          role: "code generation",
          maxTokens: 4096,
        },
      },
      routing: {
        strategy: "capability_match",
        fallbackChain: ["coder"],
      },
      sandbox: {
        type: "local",
        warmPool: 3,
        timeoutMinutes: 30,
        cleanup: "on_success",
      },
      policy: {
        protectedPaths: [],
        blockedCommands: [],
        maxDiffLines: 500,
        requireApprovalAbove: 200,
      },
    };
  }

  it("accepts a valid config", () => {
    const config = makeValidConfig();
    expect(() => validateConfig(config)).not.toThrow();
  });

  it("rejects invalid provider", () => {
    const config = makeValidConfig();
    (config.models.coder as Record<string, unknown>).provider = "invalid_provider";
    expect(() => validateConfig(config)).toThrow("Invalid foreman configuration");
  });

  it("rejects invalid log level", () => {
    const config = makeValidConfig();
    (config.foreman as Record<string, unknown>).logLevel = "verbose";
    expect(() => validateConfig(config)).toThrow("Invalid foreman configuration");
  });

  it("rejects negative maxConcurrentAgents", () => {
    const config = makeValidConfig();
    config.foreman.maxConcurrentAgents = -1;
    expect(() => validateConfig(config)).toThrow("Invalid foreman configuration");
  });

  it("rejects empty model name", () => {
    const config = makeValidConfig();
    config.models.coder.model = "";
    expect(() => validateConfig(config)).toThrow("Invalid foreman configuration");
  });

  it("rejects invalid sandbox type", () => {
    const config = makeValidConfig();
    (config.sandbox as Record<string, unknown>).type = "aws";
    expect(() => validateConfig(config)).toThrow("Invalid foreman configuration");
  });

  it("rejects invalid routing strategy", () => {
    const config = makeValidConfig();
    (config.routing as Record<string, unknown>).strategy = "random";
    expect(() => validateConfig(config)).toThrow("Invalid foreman configuration");
  });

  it("rejects port out of range", () => {
    const config = makeValidConfig();
    config.api = {
      enabled: true,
      port: 99999,
      host: "127.0.0.1",
      corsOrigins: ["*"],
    };
    expect(() => validateConfig(config)).toThrow("Invalid foreman configuration");
  });
});
