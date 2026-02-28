import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../src/utils/retry.js";

describe("withRetry", () => {
  it("should return result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should retry on transient errors", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("API error (429): rate limited"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { initialDelayMs: 10, maxRetries: 2 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should not retry on non-transient errors", async () => {
    const fn = vi.fn()
      .mockRejectedValue(new Error("Invalid API key"));

    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toThrow("Invalid API key");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("should respect maxRetries", async () => {
    const fn = vi.fn()
      .mockRejectedValue(new Error("API error (500): internal server error"));

    await expect(
      withRetry(fn, { maxRetries: 2, initialDelayMs: 10 })
    ).rejects.toThrow("500");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("should call onRetry callback", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("API error (502): bad gateway"))
      .mockResolvedValue("ok");

    await withRetry(fn, { initialDelayMs: 10, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error), 10);
  });

  it("should use custom isRetryable", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("custom error"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, {
      initialDelayMs: 10,
      isRetryable: (err) => err instanceof Error && err.message === "custom error",
    });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should retry on connection errors", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { initialDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("should retry on timeout errors", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("Request timeout"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { initialDelayMs: 10 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
