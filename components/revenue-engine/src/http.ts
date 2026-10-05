/** Minimal fetch signature so adapters can be tested with fixture fetch functions. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export type RetryOptions = { timeoutMs?: number; retries?: number; backoffMs?: number };

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Reads REVENUE_HTTP_TIMEOUT_MS / REVENUE_HTTP_RETRIES / REVENUE_HTTP_BACKOFF_MS. */
export function retryOptionsFromEnv(env: NodeJS.ProcessEnv): RetryOptions {
  const num = (v: string | undefined) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  return { timeoutMs: num(env.REVENUE_HTTP_TIMEOUT_MS), retries: num(env.REVENUE_HTTP_RETRIES), backoffMs: num(env.REVENUE_HTTP_BACKOFF_MS) };
}

/** GET JSON with per-attempt timeout and exponential backoff on network errors, 429 and 5xx. */
export async function getJsonWithRetry(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  opts: RetryOptions = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 500;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
    try {
      const res = await fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return await res.json();
      const body = (await res.text().catch(() => '')).slice(0, 200);
      const err = new HttpError(res.status, `HTTP ${res.status} for ${redact(url)}: ${body}`);
      if (res.status === 429 || res.status >= 500) {
        lastErr = err;
        continue;
      }
      throw err;
    } catch (err) {
      if (err instanceof HttpError && err.status !== 429 && err.status < 500) throw err;
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Strips secrets from URLs before they end up in logs. */
export function redact(url: string): string {
  return url.replace(/(access_token=)[^&]+/g, '$1***');
}
