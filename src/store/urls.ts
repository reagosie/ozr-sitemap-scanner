import { createHash } from 'node:crypto';

/** Query params that identify a campaign, not a page. Stripped before keying. */
const TRACKING_PARAMS = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^msclkid$/i,
  /^mc_(cid|eid)$/i,
  /^_ga$/i,
  /^ref$/i,
];

/**
 * Canonicalize a URL into the stable identity used as the diff key across runs.
 *
 * Trailing slashes are PRESERVED -- WordPress treats /about/ and /about as
 * distinct and redirects between them, so normalizing them away would collapse
 * URLs the site itself considers different.
 *
 * Returns null for anything unparseable or non-http(s) (mailto:, tel:, #anchor).
 */
export function canonicalizeUrl(raw: string, canonicalOrigin?: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.hash = '';
  u.hostname = u.hostname.toLowerCase();

  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((re) => re.test(key))) u.searchParams.delete(key);
  }
  u.searchParams.sort();

  // Fold host variants (www vs bare) onto the canonical origin, but only when
  // the registrable domain matches -- never rewrite a genuinely external host.
  if (canonicalOrigin) {
    try {
      const canon = new URL(canonicalOrigin);
      if (stripWww(u.hostname) === stripWww(canon.hostname)) {
        u.protocol = canon.protocol;
        u.hostname = canon.hostname;
        u.port = canon.port;
      }
    } catch {
      /* ignore a malformed canonical origin */
    }
  }

  return u.toString();
}

export function stripWww(host: string): string {
  return host.replace(/^www\./i, '');
}

/** True when the URL belongs to the site under scan. */
export function isInternal(url: string, canonicalOrigin: string): boolean {
  try {
    return stripWww(new URL(url).hostname) === stripWww(new URL(canonicalOrigin).hostname);
  } catch {
    return false;
  }
}

/**
 * URL -> filesystem-safe slug.
 *
 * Windows MAX_PATH is 260 and run directories already nest several levels deep,
 * so the readable portion is capped and disambiguated with a hash of the full
 * URL. Do not remove the truncation: some event URLs on these sites are long
 * enough to blow the limit on their own.
 */
export function slugForUrl(url: string): string {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 8);
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + (u.search ? u.search : '');
  } catch {
    path = url;
  }

  const readable = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .toLowerCase();

  return readable ? `${readable}__${hash}` : `home__${hash}`;
}
