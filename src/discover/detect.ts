import { fetchWithRetry } from '../crawl/fetcher.js';
import type { WpDetection } from '../types.js';

/**
 * Assert the target is WordPress and locate its REST API.
 *
 * All six candidate sites are WordPress on WP Engine, so this is a guard that
 * fails loudly on an unexpected target rather than the entry point to a
 * multi-CMS framework. The strongest signal is the Link header:
 *   Link: <https://host/wp-json/>; rel="https://api.w.org/"
 */
export async function detectWordPress(origin: string): Promise<WpDetection> {
  const res = await fetchWithRetry(origin, { timeoutMs: 30_000 });
  const evidence: string[] = [];
  let restBase: string | null = null;

  if (!res.ok) {
    return {
      isWordPress: false,
      restBase: null,
      evidence: [`homepage fetch failed: ${res.error ?? `HTTP ${res.status}`}`],
    };
  }

  const link = res.headers.get('link');
  if (link) {
    const m = /<([^>]+)>;\s*rel="https:\/\/api\.w\.org\/"/.exec(link);
    if (m && m[1]) {
      restBase = m[1].replace(/\/$/, '');
      evidence.push('Link header advertises api.w.org REST base');
    }
  }

  const html = res.body;
  if (/wp-content|wp-includes/.test(html)) evidence.push('wp-content/wp-includes asset paths');
  if (/wp-json/.test(html)) evidence.push('wp-json reference in markup');

  const gen = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/gi;
  for (const m of html.matchAll(gen)) {
    if (m[1]) evidence.push(`generator: ${m[1]}`);
  }

  if (!restBase && /wp-json/.test(html)) {
    restBase = new URL('/wp-json', res.url).toString().replace(/\/$/, '');
  }

  const isWordPress = evidence.some((e) => /api\.w\.org|wp-content|wp-json/.test(e));
  return { isWordPress, restBase, evidence };
}

/**
 * Resolve the canonical origin by following redirects from whatever the user
 * typed. www.campozark.com 301s to campozark.com, and sitemap URLs use the
 * bare host -- if we key screenshots by the wrong host the diff breaks.
 */
export async function resolveCanonicalOrigin(input: string): Promise<string> {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const res = await fetchWithRetry(withScheme, { timeoutMs: 30_000 });
  const finalUrl = res.ok ? res.url : withScheme;
  return new URL(finalUrl).origin;
}
