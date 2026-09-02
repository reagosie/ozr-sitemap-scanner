/**
 * HTTP fetching with retry/backoff.
 *
 * Two hard-won constraints from reconnaissance, both load-bearing:
 *  1. Cloudflare fronts every target site and is USER-AGENT SENSITIVE. A short
 *     "Mozilla/5.0" UA returns 403 on these hosts; a full desktop Chrome UA
 *     returns 200. Never trim UA_DESKTOP.
 *  2. Some sitemap endpoints drop the connection intermittently (campozark's
 *     /sitemap.xml and ozrsession-sitemap.xml both do). Retries are mandatory,
 *     and exhausting them must surface as a hard error, never a silent zero.
 */

export const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  method?: 'GET' | 'HEAD';
  redirect?: RequestRedirect;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  url: string;
  headers: Headers;
  body: string;
  attempts: number;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry on network faults and transient/rate-limit statuses only. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 425 || status >= 500;
}

export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const { timeoutMs = 30_000, retries = 3, method = 'GET', redirect = 'follow' } = opts;

  let lastError = '';
  let status = 0;
  let attempt = 0;

  while (attempt < retries) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        redirect,
        signal: controller.signal,
        headers: {
          'User-Agent': UA_DESKTOP,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      clearTimeout(timer);
      status = res.status;

      if (!res.ok && isRetryableStatus(res.status) && attempt < retries) {
        lastError = `HTTP ${res.status}`;

        // A 429 needs a real pause, not the generic exponential step. The full
        // campozark run checked 1,876 internal links and 151 came back 429 --
        // our own checker rate-limited the site, and 500ms/1s backoffs were far
        // too short to recover. Those URLs were then reported as "unverified",
        // which is honest but useless: a broken link could hide among them.
        let waitMs = 500 * 2 ** (attempt - 1);
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after'));
          waitMs =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 30_000)
              : Math.max(waitMs, 5_000 * attempt);
        }
        await sleep(waitMs);
        continue;
      }

      const body = method === 'HEAD' ? '' : await res.text();
      return {
        ok: res.ok,
        status: res.status,
        url: res.url || url,
        headers: res.headers,
        body,
        attempts: attempt,
      };
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < retries) await sleep(500 * 2 ** (attempt - 1));
    }
  }

  return {
    ok: false,
    status,
    url,
    headers: new Headers(),
    body: '',
    attempts: attempt,
    error: lastError || 'unknown fetch failure',
  };
}
