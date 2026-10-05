export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type RetryOptions = {
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  fetchImpl?: FetchLike;
};

/**
 * fetch with per-attempt timeout and exponential backoff. Retries on network
 * errors, timeouts, 429 and 5xx. Throws after the last attempt; callers degrade.
 */
export async function fetchWithRetry(url: string, init: RequestInit = {}, opts: RetryOptions = {}): Promise<Response> {
  const { timeoutMs = 10_000, retries = 2, backoffMs = 500, fetchImpl = fetch } = opts;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 429 && res.status < 500) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, backoffMs * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
