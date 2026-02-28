import { describe, it, expect, vi, beforeEach } from "vitest";
import { Logger } from "../src/logging/logger.js";

describe("Logger", () => {
  let output: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    output = vi.fn();
  });

  describe("log levels", () => {
    it("logs debug messages", () => {
      const logger = new Logger("debug", "test", output);

      logger.debug("debug message");

      expect(output).toHaveBeenCalledTimes(1);
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "debug",
          message: "debug message",
          component: "test",
        })
      );
    });

    it("logs info messages", () => {
      const logger = new Logger("debug", "test", output);

      logger.info("info message");

      expect(output).toHaveBeenCalledTimes(1);
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "info",
          message: "info message",
        })
      );
    });

    it("logs warn messages", () => {
      const logger = new Logger("debug", "test", output);

      logger.warn("warn message");

      expect(output).toHaveBeenCalledTimes(1);
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "warn",
          message: "warn message",
        })
      );
    });

    it("logs error messages", () => {
      const logger = new Logger("debug", "test", output);

      logger.error("error message");

      expect(output).toHaveBeenCalledTimes(1);
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "error",
          message: "error message",
        })
      );
    });

    it("includes a timestamp in every log entry", () => {
      const logger = new Logger("debug", "test", output);

      logger.info("timestamped");

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        })
      );
    });

    it("attaches data to log entries", () => {
      const logger = new Logger("debug", "test", output);

      logger.info("with data", { key: "value", count: 42 });

      const entry = output.mock.calls[0][0];
      expect(entry.data).toEqual({ key: "value", count: 42 });
    });

    it("omits data field when no data is provided", () => {
      const logger = new Logger("debug", "test", output);

      logger.info("no data");

      const entry = output.mock.calls[0][0];
      expect(entry.data).toBeUndefined();
    });
  });

  describe("log level filtering", () => {
    it("filters out debug when level is info", () => {
      const logger = new Logger("info", "test", output);

      logger.debug("should be filtered");

      expect(output).not.toHaveBeenCalled();
    });

    it("allows info and above when level is info", () => {
      const logger = new Logger("info", "test", output);

      logger.info("info msg");
      logger.warn("warn msg");
      logger.error("error msg");

      expect(output).toHaveBeenCalledTimes(3);
    });

    it("filters out debug and info when level is warn", () => {
      const logger = new Logger("warn", "test", output);

      logger.debug("filtered");
      logger.info("filtered");

      expect(output).not.toHaveBeenCalled();
    });

    it("allows warn and error when level is warn", () => {
      const logger = new Logger("warn", "test", output);

      logger.warn("warn msg");
      logger.error("error msg");

      expect(output).toHaveBeenCalledTimes(2);
    });

    it("only allows error when level is error", () => {
      const logger = new Logger("error", "test", output);

      logger.debug("filtered");
      logger.info("filtered");
      logger.warn("filtered");
      logger.error("allowed");

      expect(output).toHaveBeenCalledTimes(1);
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({ level: "error" })
      );
    });

    it("allows all levels when level is debug", () => {
      const logger = new Logger("debug", "test", output);

      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      expect(output).toHaveBeenCalledTimes(4);
    });
  });

  describe("child logger", () => {
    it("creates a child with a namespaced component", () => {
      const logger = new Logger("debug", "parent", output);
      const child = logger.child("child");

      child.info("from child");

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          component: "parent:child",
          message: "from child",
        })
      );
    });

    it("inherits the log level from the parent", () => {
      const logger = new Logger("warn", "parent", output);
      const child = logger.child("child");

      child.info("should be filtered");
      child.warn("should pass");

      expect(output).toHaveBeenCalledTimes(1);
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({ level: "warn" })
      );
    });

    it("shares the output function with the parent", () => {
      const logger = new Logger("debug", "parent", output);
      const child = logger.child("child");

      logger.info("parent msg");
      child.info("child msg");

      expect(output).toHaveBeenCalledTimes(2);
    });

    it("supports nested child loggers", () => {
      const logger = new Logger("debug", "root", output);
      const child = logger.child("mid");
      const grandchild = child.child("leaf");

      grandchild.info("deep");

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          component: "root:mid:leaf",
        })
      );
    });
  });

  describe("sanitize", () => {
    it("converts Error objects to { message, stack }", () => {
      const logger = new Logger("debug", "test", output);
      const err = new Error("something broke");

      logger.error("failure", { error: err });

      const entry = output.mock.calls[0][0];
      expect(entry.data.error).toEqual({
        message: "something broke",
        stack: expect.stringContaining("something broke"),
      });
    });

    it("converts bigint values to strings", () => {
      const logger = new Logger("debug", "test", output);

      logger.info("big number", { value: BigInt(9007199254740991) });

      const entry = output.mock.calls[0][0];
      expect(entry.data.value).toBe("9007199254740991");
    });

    it("passes through regular values unchanged", () => {
      const logger = new Logger("debug", "test", output);

      logger.info("data", {
        str: "hello",
        num: 42,
        bool: true,
        nil: null,
        arr: [1, 2, 3],
      });

      const entry = output.mock.calls[0][0];
      expect(entry.data.str).toBe("hello");
      expect(entry.data.num).toBe(42);
      expect(entry.data.bool).toBe(true);
      expect(entry.data.nil).toBeNull();
      expect(entry.data.arr).toEqual([1, 2, 3]);
    });

    it("should redact apiKey fields", () => {
      const logger = new Logger("debug", "test", output);

      logger.info("request", { apiKey: "sk-secret-key-12345", url: "/api" });

      const entry = output.mock.calls[0][0];
      expect(entry.data.apiKey).toBe("[REDACTED]");
      expect(entry.data.url).toBe("/api");
    });

    it("should redact token fields", () => {
      const logger = new Logger("debug", "test", output);

      logger.info("auth", { token: "ghp_abc123", user: "alice" });

      const entry = output.mock.calls[0][0];
      expect(entry.data.token).toBe("[REDACTED]");
      expect(entry.data.user).toBe("alice");
    });

    it("should redact password fields", () => {
      const logger = new Logger("debug", "test", output);

      logger.info("login", { password: "hunter2", username: "bob" });

      const entry = output.mock.calls[0][0];
      expect(entry.data.password).toBe("[REDACTED]");
      expect(entry.data.username).toBe("bob");
    });
  });

  describe("defaults", () => {
    it("defaults to info level", () => {
      const logger = new Logger(undefined, "test", output);

      logger.debug("filtered");
      logger.info("allowed");

      expect(output).toHaveBeenCalledTimes(1);
    });

    it("defaults component to foreman", () => {
      const logger = new Logger("debug", undefined, output);

      logger.info("msg");

      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({ component: "foreman" })
      );
    });

    it("uses defaultOutput when no output function is provided", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const logger = new Logger("info", "test");
      logger.info("hello default");

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("hello default")
      );

      consoleSpy.mockRestore();
    });

    it("routes error level to console.error", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const logger = new Logger("debug", "test");
      logger.error("bad thing");

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("bad thing")
      );

      consoleSpy.mockRestore();
    });

    it("routes warn level to console.warn", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const logger = new Logger("debug", "test");
      logger.warn("caution");

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("caution")
      );

      consoleSpy.mockRestore();
    });

    it("routes debug level to console.debug", () => {
      const consoleSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

      const logger = new Logger("debug", "test");
      logger.debug("trace info");

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("trace info")
      );

      consoleSpy.mockRestore();
    });
  });
});
