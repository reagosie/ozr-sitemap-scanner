import { fetchWithRetry } from '../crawl/fetcher.js';
import type { RobotsInfo } from '../types.js';

/**
 * robots.txt is the RELIABLE route to a site's sitemap index, not a guess at
 * /sitemap.xml. Verified: campwareagle.org declares wp-sitemap.xml (WP core)
 * while the other five declare sitemap_index.xml (Yoast), and campozark.com's
 * /sitemap.xml drops the connection entirely while its declared index works.
 */
export async function fetchRobots(origin: string): Promise<RobotsInfo> {
  const url = new URL('/robots.txt', origin).toString();
  const res = await fetchWithRetry(url, { timeoutMs: 20_000 });

  if (!res.ok) {
    return {
      fetched: false,
      sitemaps: [],
      crawlDelay: null,
      error: res.error ?? `HTTP ${res.status}`,
    };
  }

  const sitemaps: string[] = [];
  let crawlDelay: number | null = null;

  for (const rawLine of res.body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sm = /^sitemap:\s*(\S+)/i.exec(line);
    if (sm && sm[1]) {
      sitemaps.push(sm[1]);
      continue;
    }

    const cd = /^crawl-delay:\s*(\S+)/i.exec(line);
    if (cd && cd[1]) {
      const n = Number(cd[1]);
      if (Number.isFinite(n)) crawlDelay = n;
    }
  }

  return { fetched: true, sitemaps: [...new Set(sitemaps)], crawlDelay };
}

/**
 * Fallback sitemap index candidates, tried in order only when robots.txt
 * declares none. Ordered by observed reliability across the six target sites.
 */
export const SITEMAP_FALLBACKS = ['/sitemap_index.xml', '/wp-sitemap.xml', '/sitemap.xml'];
