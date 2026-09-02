/** Capture tier. A = primary content, B = thin/auxiliary, C = link-check only. */
export type Tier = 'A' | 'B' | 'C';

/** Which sitemap convention the site serves. */
export type SitemapFlavor = 'yoast' | 'wp-core' | 'unknown';

/** What a sub-sitemap enumerates. */
export type EntryKind = 'post' | 'taxonomy' | 'user' | 'unknown';

/** One URL in the inventory. */
export interface UrlEntry {
  /** Canonicalized URL — the stable identity used as the diff key. */
  loc: string;
  /** Exactly as it appeared in the sitemap, before canonicalization. */
  rawLoc: string;
  /**
   * Last-modified timestamp, ISO 8601. ABSENT for WP core taxonomy/user
   * sitemaps. Never treat absence as "unchanged" — see isUnchanged().
   */
  lastmod?: string;
  /** Post type or taxonomy slug, e.g. "page", "activity", "activity_type". */
  type: string;
  kind: EntryKind;
  tier: Tier;
  /** Sub-sitemap this URL came from, for provenance. */
  source: string;
  /**
   * How this URL was found. 'rest' means it is published in the REST API but
   * ABSENT from the sitemap -- a page the old manual process would have missed.
   */
  discoveredVia: 'sitemap' | 'rest';
}

/** Outcome of fetching one sub-sitemap. A failure here is a hard error. */
export interface SubSitemapResult {
  url: string;
  type: string;
  kind: EntryKind;
  ok: boolean;
  urlCount: number;
  withLastmod: number;
  error?: string;
  attempts: number;
}

/** WordPress detection evidence. */
export interface WpDetection {
  isWordPress: boolean;
  /** Base of the REST API, e.g. https://campozark.com/wp-json — null if absent. */
  restBase: string | null;
  evidence: string[];
}

/** A post type as reported by /wp-json/wp/v2/types. */
export interface WpType {
  slug: string;
  name: string;
  restBase: string;
  /** Published item count via X-WP-Total, or null if not queryable. */
  count: number | null;
}

/** robots.txt findings. */
export interface RobotsInfo {
  fetched: boolean;
  sitemaps: string[];
  /** Recorded for the manifest only — deliberately NOT obeyed (first-party sites). */
  crawlDelay: number | null;
  error?: string;
}

/** Per-type rollup for the --discover-only table. */
export interface TypeSummary {
  type: string;
  kind: EntryKind;
  tier: Tier;
  urls: number;
  withLastmod: number;
  /** REST published count, when cross-checkable. */
  restCount: number | null;
}

/** The full result of the discovery stage. */
export interface Inventory {
  site: string;
  canonicalOrigin: string;
  flavor: SitemapFlavor;
  discoveredAt: string;
  robots: RobotsInfo;
  detection: WpDetection;
  entries: UrlEntry[];
  subSitemaps: SubSitemapResult[];
  typeSummary: TypeSummary[];
  /** REST types with published items but no sitemap presence — needs human review. */
  possiblyMissed: { type: string; restCount: number; restBase: string }[];
  /**
   * Published URLs present in REST but absent from the sitemap, per type.
   * These ARE added to entries and captured — this is the permanent fix for
   * the missed-pages failure mode.
   */
  missingFromSitemap: { type: string; sitemapCount: number; restCount: number; urls: string[] }[];
  /** Sub-sitemaps that could not be fetched. Non-empty = incomplete inventory. */
  errors: string[];
}
