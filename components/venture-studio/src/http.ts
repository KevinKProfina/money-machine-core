export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpOptions = {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  init?: RequestInit;
};

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 429 || error.status >= 500;
  return true; // network errors, timeouts, invalid JSON from a flaky proxy
}

/**
 * Fetch + parse JSON with a per-attempt timeout and exponential backoff retry.
 * Non-idempotent requests must carry an idempotency key before being retried.
 * Throws after the last attempt; callers decide how to degrade.
 */
export async function fetchJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const backoffMs = opts.backoffMs ?? 500;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { ...opts.init, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        let body = '';
        try {
          body = (await res.text()).slice(0, 500);
        } catch {
          // ignore
        }
        throw new HttpError(`HTTP ${res.status} for ${url.split('?')[0]}${body ? `: ${body}` : ''}`, res.status, body);
      }
      return (await res.json()) as T;
    } catch (error) {
      lastError = error;
      if (attempt === retries || !isRetryable(error)) break;
      await sleep(backoffMs * 2 ** attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
