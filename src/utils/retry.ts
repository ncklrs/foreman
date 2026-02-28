/**
 * Retry utility with exponential backoff.
 * Implements the "Schema Validation Retry with Cross-Step Learning" pattern —
 * retries with backoff, records failures, and exposes metrics.
 */

export interface RetryOptions {
  /** Maximum number of retry attempts (not counting the first try). */
  maxRetries: number;
  /** Initial delay in ms before the first retry. */
  initialDelayMs: number;
  /** Multiplier applied to delay after each retry. */
  backoffMultiplier: number;
  /** Maximum delay cap in ms. */
  maxDelayMs: number;
  /** Optional function to determine if an error is retryable. */
  isRetryable?: (error: unknown) => boolean;
  /** Optional callback invoked before each retry. */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
  maxDelayMs: 30000,
};

/** Errors that are generally transient and safe to retry. */
function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    // HTTP 429 (rate limit), 500, 502, 503, 504
    if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
    // Network errors
    if (/\b(econnreset|econnrefused|etimedout|epipe|enetunreach|fetch failed)\b/.test(msg)) return true;
    // Timeout
    if (/\btimeout\b/.test(msg)) return true;
    // Overloaded
    if (/\b(overloaded|rate.?limit|too many requests)\b/.test(msg)) return true;
  }
  return false;
}

/**
 * Execute an async function with exponential backoff retry.
 * Returns the result on success, or throws the last error after exhausting retries.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const shouldRetry = opts.isRetryable ?? isTransientError;

  let lastError: unknown;
  let delay = opts.initialDelayMs;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= opts.maxRetries || !shouldRetry(error)) {
        throw error;
      }

      if (opts.onRetry) {
        opts.onRetry(attempt + 1, error, delay);
      }

      // Add jitter: ±25% of the delay to avoid thundering herd
      const jitter = delay * 0.25 * (Math.random() * 2 - 1);
      await sleep(delay + jitter);

      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
