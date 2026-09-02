import { XMLParser } from 'fast-xml-parser';
import { fetchWithRetry } from '../crawl/fetcher.js';
import { canonicalizeUrl } from '../store/urls.js';
import type { EntryKind, SitemapFlavor, SubSitemapResult, UrlEntry } from '../types.js';

const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  isArray: (_name, jpath) => jpath === 'sitemapindex.sitemap' || jpath === 'urlset.url',
});

/**
 * Derive post type / taxonomy from a sub-sitemap filename. The two conventions
 * encode it completely differently:
 *
 *   Yoast    activity-sitemap.xml
 *   WP core  wp-sitemap-posts-activity-1.xml
 *            wp-sitemap-taxonomies-activity_type-1.xml
 *            wp-sitemap-users-1.xml
 *
 * The trailing -N on core names is a PAGE NUMBER, not part of the type. Core
 * paginates at 2,000 entries and campwareagle's tribe_events is already at
 * 1,455, so page 2 will appear on its own; the index lists every page, so this
 * only needs to avoid baking "-1" into the type name.
 */
export function parseSitemapName(url: string): { type: string; kind: EntryKind; flavor: SitemapFlavor } {
  const file = url.split('/').pop() ?? url;

  let m = /^wp-sitemap-posts-(.+)-\d+\.xml$/i.exec(file);
  if (m && m[1]) return { type: m[1], kind: 'post', flavor: 'wp-core' };

  m = /^wp-sitemap-taxonomies-(.+)-\d+\.xml$/i.exec(file);
  if (m && m[1]) return { type: m[1], kind: 'taxonomy', flavor: 'wp-core' };

  m = /^wp-sitemap-users-\d+\.xml$/i.exec(file);
  if (m) return { type: 'user', kind: 'user', flavor: 'wp-core' };

  // Yoast: <type>-sitemap.xml. Whether the type is a post type or a taxonomy
  // cannot be told from the name alone -- reconcile.ts resolves it against the
  // REST taxonomy list.
  m = /^(.+)-sitemap\d*\.xml$/i.exec(file);
  if (m && m[1]) return { type: m[1], kind: 'unknown', flavor: 'yoast' };

  return { type: file.replace(/\.xml$/i, ''), kind: 'unknown', flavor: 'unknown' };
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Fetch and parse a sitemap index into its child sitemap URLs. */
export async function fetchSitemapIndex(
  url: string,
): Promise<{ ok: boolean; children: string[]; isUrlset: boolean; error?: string }> {
  if (/\.gz$/i.test(url)) {
    return { ok: false, children: [], isUrlset: false, error: 'gzipped sitemaps are not supported' };
  }

  const res = await fetchWithRetry(url, { timeoutMs: 30_000, retries: 4 });
  if (!res.ok) {
    return { ok: false, children: [], isUrlset: false, error: res.error ?? `HTTP ${res.status}` };
  }

  let doc: any;
  try {
    doc = parser.parse(res.body);
  } catch (err) {
    return {
      ok: false,
      children: [],
      isUrlset: false,
      error: `XML parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Some sites serve a flat urlset at the index location rather than an index.
  if (doc?.urlset) return { ok: true, children: [], isUrlset: true };

  const children = asArray(doc?.sitemapindex?.sitemap)
    .map((s: any) => (typeof s?.loc === 'string' ? s.loc.trim() : null))
    .filter((s: unknown): s is string => typeof s === 'string' && s.length > 0);

  if (children.length === 0) {
    return { ok: false, children: [], isUrlset: false, error: 'no <sitemap> entries found in index' };
  }

  return { ok: true, children, isUrlset: false };
}

/** Fetch and parse one urlset sub-sitemap. */
export async function fetchUrlset(
  url: string,
  canonicalOrigin: string,
): Promise<{ result: SubSitemapResult; entries: UrlEntry[] }> {
  const { type, kind } = parseSitemapName(url);

  if (/\.gz$/i.test(url)) {
    return {
      result: { url, type, kind, ok: false, urlCount: 0, withLastmod: 0, attempts: 0, error: 'gzipped sitemaps are not supported' },
      entries: [],
    };
  }

  const res = await fetchWithRetry(url, { timeoutMs: 30_000, retries: 4 });
  if (!res.ok) {
    return {
      result: { url, type, kind, ok: false, urlCount: 0, withLastmod: 0, attempts: res.attempts, error: res.error ?? `HTTP ${res.status}` },
      entries: [],
    };
  }

  let doc: any;
  try {
    doc = parser.parse(res.body);
  } catch (err) {
    return {
      result: {
        url, type, kind, ok: false, urlCount: 0, withLastmod: 0, attempts: res.attempts,
        error: `XML parse failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      entries: [],
    };
  }

  const entries: UrlEntry[] = [];
  let withLastmod = 0;

  for (const node of asArray(doc?.urlset?.url)) {
    const rawLoc = typeof node?.loc === 'string' ? node.loc.trim() : String(node?.loc ?? '').trim();
    if (!rawLoc) continue;

    const loc = canonicalizeUrl(rawLoc, canonicalOrigin);
    if (!loc) continue;

    // lastmod is genuinely absent on WP core taxonomy/user sitemaps. Leave it
    // undefined rather than substituting a default -- downstream skip logic
    // treats "missing" as "always capture", and a fake value would defeat that.
    const lastmodRaw = node?.lastmod;
    const lastmod = lastmodRaw ? String(lastmodRaw).trim() : undefined;
    if (lastmod) withLastmod++;

    entries.push({
      loc,
      rawLoc,
      ...(lastmod ? { lastmod } : {}),
      type,
      kind,
      tier: 'A', // provisional; classify.ts assigns the real tier
      source: url,
      discoveredVia: 'sitemap',
    });
  }

  return {
    result: { url, type, kind, ok: true, urlCount: entries.length, withLastmod, attempts: res.attempts },
    entries,
  };
}
