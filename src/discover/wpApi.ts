import pLimit from 'p-limit';
import { fetchWithRetry } from '../crawl/fetcher.js';
import type { WpType } from '../types.js';

/**
 * Types WordPress exposes over REST that are never public pages. /wp/v2/types
 * lists everything with show_in_rest=true and does NOT expose a public/viewable
 * flag in the default context, so this list does the filtering the API won't.
 * Verified present across the target sites.
 */
const INTERNAL_TYPES = new Set([
  'attachment', 'nav_menu_item', 'wp_block', 'wp_template', 'wp_template_part',
  'wp_global_styles', 'wp_navigation', 'wp_font_family', 'wp_font_face',
  'elementor_library', 'elementor_snippet', 'e-floating-buttons',
  'tec_calendar_embed', 'email_templates', 'gvar',
]);

export function isInternalType(slug: string): boolean {
  return INTERNAL_TYPES.has(slug);
}

/** GET /wp-json/wp/v2/types, filtered to plausibly-public types. */
export async function fetchTypes(restBase: string): Promise<{ types: WpType[]; error?: string }> {
  const res = await fetchWithRetry(`${restBase}/wp/v2/types`, { timeoutMs: 30_000 });
  if (!res.ok) return { types: [], error: res.error ?? `HTTP ${res.status}` };

  let doc: any;
  try {
    doc = JSON.parse(res.body);
  } catch (err) {
    return { types: [], error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const types: WpType[] = [];
  for (const [slug, val] of Object.entries<any>(doc ?? {})) {
    if (isInternalType(slug)) continue;
    const restPath = typeof val?.rest_base === 'string' ? val.rest_base : slug;
    // font-faces and friends embed regex in rest_base; they are not queryable.
    if (/[()<>?]/.test(restPath)) continue;
    types.push({
      slug,
      name: typeof val?.name === 'string' ? val.name : slug,
      restBase: restPath,
      count: null,
    });
  }

  return { types };
}

/**
 * GET /wp-json/wp/v2/taxonomies -> set of taxonomy slugs.
 *
 * This is what makes Yoast sitemaps classifiable: a Yoast child named
 * "activity_type-sitemap.xml" is indistinguishable from a post-type sitemap by
 * filename alone, but is resolvable by checking the name against this set.
 */
export async function fetchTaxonomies(restBase: string): Promise<Set<string>> {
  const res = await fetchWithRetry(`${restBase}/wp/v2/taxonomies`, { timeoutMs: 30_000 });
  if (!res.ok) return new Set();
  try {
    const doc = JSON.parse(res.body);
    return new Set(Object.keys(doc ?? {}));
  } catch {
    return new Set();
  }
}

/**
 * Published item count per type, read from the X-WP-Total header of a
 * per_page=1 query. Used only as a cross-check against the sitemap -- a type
 * with published items but no sitemap presence is a candidate MISSED PAGE.
 */
export async function fetchTypeCounts(restBase: string, types: WpType[], concurrency = 3): Promise<WpType[]> {
  const limit = pLimit(concurrency);
  return Promise.all(
    types.map((t) =>
      limit(async () => {
        const res = await fetchWithRetry(
          `${restBase}/wp/v2/${t.restBase}?per_page=1&status=publish`,
          { timeoutMs: 20_000, retries: 2 },
        );
        if (!res.ok) return { ...t, count: null };
        const total = res.headers.get('x-wp-total');
        const n = total === null ? NaN : Number(total);
        return { ...t, count: Number.isFinite(n) ? n : null };
      }),
    ),
  );
}

/**
 * Every published permalink for one post type, via REST pagination.
 *
 * This is what turns "the counts disagree" into "these specific URLs are
 * missing from the sitemap" -- the difference between knowing pages are missed
 * and being able to review them. Yoast legitimately omits noindexed posts, so
 * a difference is not automatically a bug, but it is always worth a look.
 */
export async function fetchTypeLinks(
  restBase: string,
  type: { slug: string; restBase: string },
  maxPages = 50,
): Promise<{ links: { url: string; modified?: string }[]; error?: string }> {
  const links: { url: string; modified?: string }[] = [];
  let page = 1;

  while (page <= maxPages) {
    const url = `${restBase}/wp/v2/${type.restBase}?per_page=100&page=${page}&status=publish&_fields=link,modified_gmt`;
    const res = await fetchWithRetry(url, { timeoutMs: 30_000, retries: 2 });

    // Past the last page WordPress returns 400 rest_post_invalid_page_number.
    if (!res.ok) {
      if (res.status === 400 && page > 1) break;
      return { links, error: res.error ?? `HTTP ${res.status}` };
    }

    let batch: any;
    try {
      batch = JSON.parse(res.body);
    } catch {
      return { links, error: 'JSON parse failed' };
    }
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const item of batch) {
      if (typeof item?.link !== 'string' || !item.link) continue;
      // modified_gmt has no timezone suffix; make it an explicit UTC instant so
      // it compares cleanly against sitemap lastmod values across runs.
      const mod = typeof item?.modified_gmt === 'string' && item.modified_gmt
        ? `${item.modified_gmt}Z`
        : undefined;
      links.push({ url: item.link, ...(mod ? { modified: mod } : {}) });
    }

    const totalPages = Number(res.headers.get('x-wp-totalpages') ?? '1');
    if (!Number.isFinite(totalPages) || page >= totalPages) break;
    page++;
  }

  return { links };
}
