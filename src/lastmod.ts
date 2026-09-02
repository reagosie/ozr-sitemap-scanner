/**
 * The single place the lastmod comparison rule lives.
 *
 * WP core omits lastmod entirely on taxonomy and user sitemaps (verified: 51
 * such URLs on campwareagle.org). The natural form of skip logic --
 *
 *     if (current === baseline) skip()
 *
 * -- evaluates `undefined === undefined` as true and would skip those URLs on
 * EVERY run, forever, silently dropping them from review. That is precisely the
 * missed-pages failure this tool exists to prevent, so a missing timestamp on
 * either side means "unknown", which always means capture.
 */
export function isUnchanged(current?: string, baseline?: string): boolean {
  if (!current || !baseline) return false;
  return current === baseline;
}

/** Sort key: newest content first, entries without a timestamp first of all. */
export function lastmodRank(lastmod?: string): number {
  if (!lastmod) return Number.POSITIVE_INFINITY;
  const t = Date.parse(lastmod);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}
