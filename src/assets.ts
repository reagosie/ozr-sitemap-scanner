/**
 * Which theme and plugin versions the site was running when a scan happened.
 *
 * WordPress puts a version number on the end of every stylesheet and script it
 * loads, like `/wp-content/themes/ozr/style.css?ver=7.3`. That means the version
 * of every active theme and plugin is readable from the public page, with no
 * login and no access to the server.
 *
 * This exists to answer the question the diff cannot: WHY did this page change?
 * A page changes either because a person edited it, or because the code that
 * renders it was updated. The second kind arrives all at once across hundreds of
 * pages, and it is the kind nobody thinks to check, because nobody touched those
 * pages.
 *
 * IMPORTANT: knowing why a page changed is never a reason to stop checking it.
 * A theme update that quietly breaks one page's layout is the exact failure this
 * tool exists to catch. Version data groups and explains the changed pages, and
 * it adds one new alarm (see `outliers` in diff/run.ts). It must never be used
 * to skip a comparison.
 */

/** A theme, a plugin, or WordPress itself. */
export interface AssetVersions {
  /** Component name -> every version string seen on its files. */
  [component: string]: string[];
}

const PLUGIN_OR_THEME = /\/wp-content\/(plugins|themes)\/([A-Za-z0-9_.-]+)\//;
const CORE = /\/wp-includes\//;

/**
 * Version strings that change on their own and mean nothing.
 *
 * Some plugins use a Unix timestamp instead of a version, which moves every time
 * the site rebuilds its cached files. campotx does this with
 * `the-plus-addons-for-elementor-page-builder?ver=1788831584`. Reporting that as
 * "the plugin changed" would produce a false alarm on most scans, which is the
 * fastest way to make people stop reading the alarms.
 */
export function isUnstableVersion(version: string): boolean {
  // A bare number long enough to be a timestamp in seconds or milliseconds.
  if (/^\d{9,}$/.test(version)) return true;
  // A content hash rather than a version.
  if (/^[0-9a-f]{16,}$/i.test(version)) return true;
  return false;
}

export interface AssetRef {
  component: string;
  version: string;
}

/**
 * Read the component and version out of one asset URL.
 *
 * Returns null for anything that is not a versioned WordPress asset, which is
 * most of what a page loads: fonts, images, third-party scripts.
 */
export function parseAssetUrl(rawUrl: string): AssetRef | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const version = url.searchParams.get('ver');
  if (!version || isUnstableVersion(version)) return null;

  const match = PLUGIN_OR_THEME.exec(url.pathname);
  if (match) return { component: `${match[1]}/${match[2]}`, version };

  // Core assets carry the WordPress version itself, which is worth knowing:
  // a core update changes every page at once.
  if (CORE.test(url.pathname)) return { component: 'wordpress', version };

  return null;
}

/** Fold a page's asset URLs into a component -> versions map. */
export function collectAssetVersions(urls: string[]): AssetVersions {
  const found = new Map<string, Set<string>>();

  for (const raw of urls) {
    const ref = parseAssetUrl(raw);
    if (!ref) continue;
    const set = found.get(ref.component) ?? new Set<string>();
    set.add(ref.version);
    found.set(ref.component, set);
  }

  return Object.fromEntries([...found].map(([k, v]) => [k, [...v].sort()]));
}

/** Merge one page's versions into a running total for the whole site. */
export function mergeAssetVersions(into: AssetVersions, from: AssetVersions): void {
  for (const [component, versions] of Object.entries(from)) {
    const merged = new Set([...(into[component] ?? []), ...versions]);
    into[component] = [...merged].sort();
  }
}

export type AssetChangeKind = 'changed' | 'added' | 'removed';

export interface AssetChange {
  component: string;
  kind: AssetChangeKind;
  before: string[];
  after: string[];
}

/**
 * What changed between two scans.
 *
 * The version numbers themselves are not always the component's real version --
 * Elementor ships files carrying four different numbers. That does not matter
 * here. The question is only whether the set of numbers moved, because that is
 * what tells you the code rendering the site was replaced.
 */
export function diffAssetVersions(
  baseline: AssetVersions | undefined,
  current: AssetVersions | undefined,
): AssetChange[] {
  const before = baseline ?? {};
  const after = current ?? {};
  const changes: AssetChange[] = [];

  for (const component of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[component] ?? [];
    const b = after[component] ?? [];

    if (!a.length && b.length) {
      changes.push({ component, kind: 'added', before: a, after: b });
    } else if (a.length && !b.length) {
      changes.push({ component, kind: 'removed', before: a, after: b });
    } else if (a.join('|') !== b.join('|')) {
      changes.push({ component, kind: 'changed', before: a, after: b });
    }
  }

  // WordPress core first, then themes, then plugins: a core or theme update
  // explains more of a site-wide change than any single plugin does.
  const rank = (c: string): number =>
    c === 'wordpress' ? 0 : c.startsWith('themes/') ? 1 : 2;
  return changes.sort((x, y) => rank(x.component) - rank(y.component) || x.component.localeCompare(y.component));
}

/** One line a person can read, for the report and the terminal. */
export function describeAssetChange(change: AssetChange): string {
  const name = change.component;
  if (change.kind === 'added') return `${name} added (${change.after.join(', ')})`;
  if (change.kind === 'removed') return `${name} no longer loaded`;
  return `${name} ${change.before.join(', ')} -> ${change.after.join(', ')}`;
}
