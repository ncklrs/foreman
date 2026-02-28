import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SecretsManager } from "../src/secrets/manager.js";

describe("SecretsManager", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should load secrets from environment variables", async () => {
    process.env.MY_API_KEY = "sk-test-123";
    const mgr = new SecretsManager({ sources: [{ type: "env" }] });
    await mgr.initialize();

    expect(mgr.get("MY_API_KEY")).toBe("sk-test-123");
  });

  it("should return undefined for missing secrets", async () => {
    const mgr = new SecretsManager({ sources: [{ type: "env" }] });
    await mgr.initialize();

    expect(mgr.get("NONEXISTENT_KEY")).toBeUndefined();
  });

  it("should throw on getRequired for missing secrets", async () => {
    const mgr = new SecretsManager({ sources: [{ type: "env" }] });
    await mgr.initialize();

    expect(() => mgr.getRequired("MISSING_SECRET")).toThrow(
      'Required secret "MISSING_SECRET" is not set'
    );
  });

  it("should set and get secrets programmatically", async () => {
    const mgr = new SecretsManager({ sources: [] });
    await mgr.initialize();

    mgr.set("CUSTOM_KEY", "custom-value");
    expect(mgr.get("CUSTOM_KEY")).toBe("custom-value");
    expect(mgr.has("CUSTOM_KEY")).toBe(true);
  });

  it("should validate required secrets", async () => {
    process.env.FOUND_KEY = "value";
    const mgr = new SecretsManager({ sources: [{ type: "env" }] });
    await mgr.initialize();

    const missing = mgr.validateRequired(["FOUND_KEY", "MISSING_KEY"]);
    expect(missing).toEqual(["MISSING_KEY"]);
  });

  it("should resolve config values with secret references", async () => {
    process.env.DB_PASSWORD = "secret123";
    const mgr = new SecretsManager({ sources: [{ type: "env" }] });
    await mgr.initialize();

    const resolved = mgr.resolveValue("postgres://user:${DB_PASSWORD}@localhost/db");
    expect(resolved).toBe("postgres://user:secret123@localhost/db");
  });

  it("should throw when resolving missing secret references", async () => {
    const mgr = new SecretsManager({ sources: [{ type: "env" }] });
    await mgr.initialize();

    expect(() => mgr.resolveValue("key=${MISSING}")).toThrow(
      'Secret "MISSING" referenced in config but not found'
    );
  });

  it("should mask secrets for safe logging", async () => {
    const mgr = new SecretsManager({ sources: [] });
    await mgr.initialize();

    mgr.set("LONG_KEY", "abcdefghijklmnop");
    expect(mgr.masked("LONG_KEY")).toBe("abcd****mnop");

    mgr.set("SHORT_KEY", "abc");
    expect(mgr.masked("SHORT_KEY")).toBe("****");

    expect(mgr.masked("NONEXISTENT")).toBe("(not set)");
  });

  it("should list loaded secret keys", async () => {
    const mgr = new SecretsManager({ sources: [] });
    await mgr.initialize();

    mgr.set("KEY_A", "a");
    mgr.set("KEY_B", "b");

    const keys = mgr.keys();
    expect(keys).toContain("KEY_A");
    expect(keys).toContain("KEY_B");
  });

  it("should track access in audit log", async () => {
    const mgr = new SecretsManager({ sources: [] });
    await mgr.initialize();

    mgr.set("TRACKED_KEY", "value");
    mgr.get("TRACKED_KEY");

    const log = mgr.getAccessLog();
    expect(log.length).toBe(1);
    expect(log[0].key).toBe("TRACKED_KEY");
  });
});
