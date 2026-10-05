import { createHmac } from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export class WebhookError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

// ---------- SSRF guard ----------

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv4');
}
for (const [addr, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
  ['64:ff9b::', 96],
  ['100::', 64],
] as const) {
  blocked.addSubnet(addr, prefix, 'ipv6');
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and documentation ranges. */
export function isPrivateIp(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, 'ipv4');
  if (family === 6) {
    const lower = ip.toLowerCase();
    // IPv4-mapped addresses (::ffff:a.b.c.d or ::ffff:hhhh:hhhh): check the embedded IPv4 address
    if (lower.startsWith('::ffff:') && net.isIPv4(lower.slice(7))) return blocked.check(lower.slice(7), 'ipv4');
    const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
    if (hexMapped?.[1] && hexMapped[2]) {
      const hi = parseInt(hexMapped[1], 16);
      const lo = parseInt(hexMapped[2], 16);
      return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4');
    }
    return blocked.check(ip, 'ipv6');
  }
  return true; // not an IP at all → treat as unsafe
}

export function hostAllowed(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    if (e.startsWith('*.')) return h.endsWith(e.slice(1)) && h.length > e.length - 1;
    return h === e;
  });
}

export type LookupFn = (host: string) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: LookupFn = (host) => dns.lookup(host, { all: true, verbatim: true });

export type GuardOptions = { allowlist: string[]; allowPrivate?: boolean; lookup?: LookupFn };

/** Static checks that need no DNS (used when a service is registered). */
export function validateWebhookUrl(raw: string, opts: { allowlist: string[]; allowPrivate?: boolean }): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookError('invalid webhook URL');
  }
  if (url.protocol !== 'https:' && !(opts.allowPrivate && url.protocol === 'http:')) {
    throw new WebhookError('webhook URL must use https');
  }
  if (url.username || url.password) throw new WebhookError('credentials in webhook URL are not allowed');
  if (!hostAllowed(url.hostname, opts.allowlist)) {
    throw new WebhookError(`webhook host "${url.hostname}" is not in WEBHOOK_ALLOWLIST`);
  }
  const literal = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(literal) && !opts.allowPrivate && isPrivateIp(literal)) {
    throw new WebhookError('webhook URL points to a private address');
  }
  return url;
}

/**
 * Full guard: static checks + DNS resolution. Every resolved address must be public
 * (unless allowPrivate). Returns the address the request must be pinned to, so a DNS
 * rebinding between check and connect cannot redirect the request.
 */
export async function resolveWebhookTarget(raw: string, opts: GuardOptions): Promise<{ url: URL; address: string; family: number }> {
  const url = validateWebhookUrl(raw, opts);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ipFamily = net.isIP(host);
  const addrs = ipFamily ? [{ address: host, family: ipFamily }] : await (opts.lookup ?? defaultLookup)(host);
  if (addrs.length === 0) throw new WebhookError('webhook host did not resolve', true);
  if (!opts.allowPrivate) {
    for (const a of addrs) {
      if (isPrivateIp(a.address)) throw new WebhookError('webhook host resolves to a private address');
    }
  }
  const first = addrs[0]!;
  return { url, address: first.address, family: first.family };
}

// ---------- signing + delivery ----------

export const SIGNATURE_HEADER = 'x-marketplace-signature';
export const TIMESTAMP_HEADER = 'x-marketplace-timestamp';

/** HMAC-SHA256 over `${timestamp}.${body}`, hex encoded, prefixed with `sha256=`. */
export function signPayload(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export type SendRequest = {
  url: URL;
  address: string;
  family: number;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};
export type SendFn = (req: SendRequest) => Promise<{ status: number; body: string }>;

const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Node http(s) POST pinned to the pre-validated IP; never follows redirects. */
export const defaultSend: SendFn = (req) =>
  new Promise((resolve, reject) => {
    const mod = req.url.protocol === 'https:' ? https : http;
    const r = mod.request(
      req.url,
      {
        method: 'POST',
        headers: { ...req.headers, 'content-length': Buffer.byteLength(req.body).toString() },
        lookup: (_host, _opts, cb) => cb(null, req.address, req.family),
        timeout: req.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES) {
            r.destroy(new WebhookError('webhook response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    r.on('timeout', () => r.destroy(new WebhookError('webhook timed out', true)));
    r.on('error', (err) => reject(err instanceof WebhookError ? err : new WebhookError(err.message, true)));
    r.end(req.body);
  });

export type CallWebhookOptions = GuardOptions & {
  secret: string;
  timeoutMs: number;
  jobId: string;
  send?: SendFn;
  maxAttempts?: number;
  backoffMs?: number;
};

/**
 * POST `payload` as JSON to the provider webhook. Retries network errors / 5xx with
 * exponential backoff (the job id header lets providers deduplicate). Expects a JSON response.
 */
export async function callWebhook(rawUrl: string, payload: unknown, opts: CallWebhookOptions): Promise<unknown> {
  const target = await resolveWebhookTarget(rawUrl, opts);
  const body = JSON.stringify(payload);
  const send = opts.send ?? defaultSend;
  const maxAttempts = opts.maxAttempts ?? 2;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ts = Math.floor(Date.now() / 1000).toString();
    try {
      const res = await send({
        ...target,
        body,
        timeoutMs: opts.timeoutMs,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'agent-marketplace/0.1',
          'x-marketplace-job-id': opts.jobId,
          [TIMESTAMP_HEADER]: ts,
          [SIGNATURE_HEADER]: signPayload(opts.secret, ts, body),
        },
      });
      if (res.status >= 500) throw new WebhookError(`webhook returned HTTP ${res.status}`, true);
      if (res.status < 200 || res.status >= 300) throw new WebhookError(`webhook returned HTTP ${res.status}`);
      try {
        return JSON.parse(res.body) as unknown;
      } catch {
        throw new WebhookError('webhook returned invalid JSON');
      }
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof WebhookError ? err.retryable : true;
      if (!retryable || attempt === maxAttempts) break;
      await new Promise((r) => setTimeout(r, (opts.backoffMs ?? 500) * 2 ** (attempt - 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new WebhookError(String(lastErr));
}
