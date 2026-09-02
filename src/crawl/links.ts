import pLimit from 'p-limit';
import { fetchWithRetry } from './fetcher.js';
import { canonicalizeUrl, isInternal } from '../store/urls.js';

export type LinkVerdict = 'ok' | 'redirect' | 'broken' | 'blocked' | 'error';

export interface LinkResult {
  url: string;
  internal: boolean;
  status: number;
  verdict: LinkVerdict;
  /** Final URL after redirects, when it differs from the requested one. */
  finalUrl?: string;
  error?: string;
  /** Pages that link to this URL, so a broken link can actually be fixed. */
  referrers: string[];
}

export interface LinkCheckReport {
  internal: LinkResult[];
  external: LinkResult[];
  checked: number;
  broken: number;
  blocked: number;
  redirects: number;
}

/**
 * Status codes that mean "this client was rejected", not "this page is gone".
 *
 * Anti-bot responses are wildly inconsistent: Cloudflare uses 403, rate
 * limiters use 429, Facebook answers 400 to anything that is not a browser,
 * and LinkedIn famously returns 999. Verified against campozark.com: two
 * facebook.com profile links that load fine in a browser came back 400 and
 * were reported as broken -- precisely the false positive that teaches a
 * reviewer to stop trusting the report.
 *
 * Applied to EXTERNAL links only. Internal links get strict treatment because
 * we control the site and a 4xx there is a real defect. 404 and 410 stay
 * "broken" everywhere: those are unambiguous statements that a page is gone.
 */
const BOT_REJECTION_CODES = new Set([400, 401, 403, 405, 406, 429, 451, 999]);

function verdictFor(
  status: number,
  requested: string,
  finalUrl: string,
  internal: boolean,
): LinkVerdict {
  if (status === 403 || status === 429) return 'blocked';
  if (status >= 200 && status < 300) {
    return finalUrl && finalUrl !== requested ? 'redirect' : 'ok';
  }
  if (status >= 300 && status < 400) return 'redirect';
  if (!internal && BOT_REJECTION_CODES.has(status)) return 'blocked';
  return 'broken';
}

/**
 * Collect every distinct link target from the captured pages, mapped back to
 * the pages that reference it.
 */
export function collectLinks(
  pages: { loc: string; links: string[] }[],
  canonicalOrigin: string,
): Map<string, string[]> {
  const targets = new Map<string, string[]>();

  for (const page of pages) {
    for (const raw of page.links) {
      // Canonicalized WITHOUT folding onto the site origin: an external link
      // must keep its own host, or it would be checked against the wrong site.
      const url = canonicalizeUrl(raw);
      if (!url) continue; // mailto:, tel:, javascript:, fragments
      const referrers = targets.get(url) ?? [];
      if (!referrers.includes(page.loc)) referrers.push(page.loc);
      targets.set(url, referrers);
    }
  }

  return targets;
}

export interface CheckOptions {
  canonicalOrigin: string;
  checkExternal: boolean;
  concurrency?: number;
  externalConcurrency?: number;
  onProgress?: (msg: string) => void;
}

export async function checkLinks(
  targets: Map<string, string[]>,
  opts: CheckOptions,
): Promise<LinkCheckReport> {
  const {
    canonicalOrigin,
    checkExternal,
    // Deliberately low. WP Engine + Cloudflare rate-limited a 4-way internal
    // check across ~1,900 URLs; the link pass runs straight after the capture
    // pass, so the site has already had sustained traffic from us.
    concurrency = 2,
    externalConcurrency = 3,
    onProgress = () => {},
  } = opts;

  const internalTargets: [string, string[]][] = [];
  const externalTargets: [string, string[]][] = [];

  for (const [url, referrers] of targets) {
    (isInternal(url, canonicalOrigin) ? internalTargets : externalTargets).push([url, referrers]);
  }

  onProgress(
    `  ${internalTargets.length} internal, ${externalTargets.length} external unique link targets` +
      (checkExternal ? '' : ' (external checking disabled)'),
  );

  const check = async (url: string, referrers: string[]): Promise<LinkResult> => {
    // HEAD first (cheap), falling back to GET where a server rejects HEAD.
    let res = await fetchWithRetry(url, { method: 'HEAD', timeoutMs: 20_000, retries: 4 });
    if (res.status === 405 || res.status === 501 || res.status === 0) {
      res = await fetchWithRetry(url, { method: 'GET', timeoutMs: 25_000, retries: 3 });
    }

    const internal = isInternal(url, canonicalOrigin);
    if (res.status === 0) {
      return {
        url,
        internal,
        status: 0,
        verdict: 'error',
        ...(res.error ? { error: res.error } : {}),
        referrers,
      };
    }

    const verdict = verdictFor(res.status, url, res.url, internal);
    return {
      url,
      internal,
      status: res.status,
      verdict,
      ...(res.url && res.url !== url ? { finalUrl: res.url } : {}),
      referrers,
    };
  };

  const runBatch = async (entries: [string, string[]][], limitN: number, label: string) => {
    const limiter = pLimit(limitN);
    let done = 0;
    return Promise.all(
      entries.map(([url, refs]) =>
        limiter(async () => {
          const r = await check(url, refs);
          done++;
          if (done % 100 === 0 || done === entries.length) {
            onProgress(`    ${label} ${done}/${entries.length}`);
          }
          return r;
        }),
      ),
    );
  };

  const internal = await runBatch(internalTargets, concurrency, 'internal');
  const external = checkExternal
    ? await runBatch(externalTargets, externalConcurrency, 'external')
    : [];

  const all = [...internal, ...external];
  return {
    internal,
    external,
    checked: all.length,
    broken: all.filter((r) => r.verdict === 'broken' || r.verdict === 'error').length,
    blocked: all.filter((r) => r.verdict === 'blocked').length,
    redirects: all.filter((r) => r.verdict === 'redirect').length,
  };
}
