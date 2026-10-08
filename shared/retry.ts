/**
 * Centralized retry utility with exponential backoff
 * Handles Gemini API "high traffic" / 503 / rate limit errors
 */

const RETRYABLE_MESSAGES = [
  'high traffic',
  'overloaded',
  'rate limit',
  'quota exceeded',
  '503',
  '429',
  'try again',
  'resource exhausted',
];

function isRetryable(error: unknown): boolean {
  if (!error) return false;
  const msg = String(error instanceof Error ? error.message : error).toLowerCase();
  return RETRYABLE_MESSAGES.some(pattern => msg.includes(pattern));
}

/**
 * Retry a Gemini API call with exponential backoff
 * @param fn - async function to retry
 * @param maxAttempts - max number of attempts (default: 4)
 * @param baseDelayMs - base delay in ms (default: 2000 → 2s, 4s, 8s...)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
  baseDelayMs = 2000,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isRetryable(err) || attempt === maxAttempts) {
        throw err;
      }

      // Exponential backoff with jitter: 2s, 4s, 8s (+0-500ms random)
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500;
      console.warn(
        `[Retry] Gemini API error (attempt ${attempt}/${maxAttempts}). Retrying in ${Math.round(delay)}ms...`,
        err instanceof Error ? err.message : String(err)
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
