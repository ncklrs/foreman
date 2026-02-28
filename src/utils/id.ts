/**
 * Shared ID generation utilities.
 * Centralizes all random ID generation to avoid scattered implementations.
 */

/**
 * Generate a prefixed unique ID.
 * Format: `{prefix}_{timestamp}_{random}`
 */
export function generateId(prefix: string = "id"): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
