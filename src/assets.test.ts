/**
 * Tests for theme/plugin version tracking and the outlier warning.
 *
 * Run: npx tsx src/assets.test.ts
 */
import {
  collectAssetVersions,
  describeAssetChange,
  diffAssetVersions,
  isUnstableVersion,
  mergeAssetVersions,
  parseAssetUrl,
} from './assets.js';
import { findOutliers } from './diff/run.js';
import type { PageDiff } from './diff/run.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
}

const B = 'https://campotx.com';

// --- reading a version off an asset URL --------------------------------------
check(
  'reads a plugin and its version',
  parseAssetUrl(`${B}/wp-content/plugins/elementor/assets/css/x.css?ver=3.21.0`)?.component ===
    'plugins/elementor',
);
check(
  'reads a theme',
  parseAssetUrl(`${B}/wp-content/themes/ozr/style.css?ver=7.3`)?.component === 'themes/ozr',
);
check(
  'reads WordPress core',
  parseAssetUrl(`${B}/wp-includes/js/jquery/jquery.min.js?ver=3.7.1`)?.component === 'wordpress',
);
check(
  'finds ver= even when it is not the first parameter',
  parseAssetUrl(`${B}/wp-content/plugins/x/a.js?foo=1&ver=2.0`)?.version === '2.0',
);
check('ignores an asset with no version', parseAssetUrl(`${B}/wp-content/themes/ozr/a.css`) === null);
check('ignores a third-party script', parseAssetUrl('https://cdn.example.com/x.js?ver=1.0') === null);
check('ignores an unparseable URL', parseAssetUrl('not a url') === null);

// --- version strings that churn on their own ---------------------------------
check('a 10-digit timestamp is unstable', isUnstableVersion('1788831584'));
check('a long hex hash is unstable', isUnstableVersion('a3f9c2e18b7d4460'));
check('a real version is stable', !isUnstableVersion('6.17.2'));
check('a two-part version is stable', !isUnstableVersion('7.3'));
check('a short number is stable', !isUnstableVersion('9'));
check(
  'a timestamped asset is skipped entirely',
  parseAssetUrl(`${B}/wp-content/plugins/the-plus-addons/a.js?ver=1788831584`) === null,
);

// --- collecting and merging --------------------------------------------------
const page1 = collectAssetVersions([
  `${B}/wp-content/themes/ozr/style.css?ver=7.3`,
  `${B}/wp-content/themes/ozr/extra.css?ver=1.0`,
  `${B}/wp-content/plugins/elementor/a.css?ver=3.21.0`,
  `${B}/wp-content/plugins/the-plus-addons/a.js?ver=1788831584`,
  'https://fonts.googleapis.com/css?family=X',
]);
check('collects one version list per component', Object.keys(page1).length === 2, Object.keys(page1).join(','));
check('several versions of one component are kept and sorted', page1['themes/ozr']?.join(',') === '1.0,7.3');
check('the timestamped plugin never appears', !('plugins/the-plus-addons' in page1));

const site = { ...page1 };
mergeAssetVersions(site, collectAssetVersions([`${B}/wp-content/themes/ozr/late.css?ver=7.4`]));
check('merging another page adds its versions', site['themes/ozr']?.join(',') === '1.0,7.3,7.4');

// --- comparing two scans ------------------------------------------------------
const before = { 'themes/ozr': ['7.3'], 'plugins/a': ['1.0'], wordpress: ['6.5'] };
const after = { 'themes/ozr': ['7.4'], 'plugins/b': ['2.0'], wordpress: ['6.5'] };
const changes = diffAssetVersions(before, after);

check('unchanged components are not reported', !changes.some((c) => c.component === 'wordpress'));
check('an updated theme is reported as changed', changes.find((c) => c.component === 'themes/ozr')?.kind === 'changed');
check('a new plugin is reported as added', changes.find((c) => c.component === 'plugins/b')?.kind === 'added');
check('a gone plugin is reported as removed', changes.find((c) => c.component === 'plugins/a')?.kind === 'removed');
check('nothing changes against itself', diffAssetVersions(before, before).length === 0);
check('a missing baseline reports everything as added', diffAssetVersions(undefined, after).length === 3);

const ordered = diffAssetVersions(
  { 'plugins/z': ['1'], 'themes/t': ['1'], wordpress: ['6.5'] },
  { 'plugins/z': ['2'], 'themes/t': ['2'], wordpress: ['6.6'] },
).map((c) => c.component);
check('core first, then theme, then plugin', ordered.join(' ') === 'wordpress themes/t plugins/z', ordered.join(' '));

check(
  'the description reads as a sentence',
  describeAssetChange({ component: 'themes/ozr', kind: 'changed', before: ['7.3'], after: ['7.4'] }) ===
    'themes/ozr 7.3 -> 7.4',
);

// --- the outlier warning ------------------------------------------------------
const page = (loc: string, ratio: number): PageDiff =>
  ({
    loc,
    slug: loc,
    type: 'page',
    tier: 'A',
    discoveredVia: 'sitemap',
    flagged: ratio > 0,
    breakpoints: { desktop: { status: ratio > 0 ? 'changed' : 'unchanged', ratio } },
  }) as unknown as PageDiff;

// A theme update nudged 20 pages by about 2%, and broke one.
const themeUpdate = [
  ...Array.from({ length: 20 }, (_, i) => page(`/p${i}`, 0.02 + i * 0.001)),
  page('/broken', 0.34),
];
const found = findOutliers(themeUpdate);
check('finds the one page the update broke', found.outliers.length === 1 && found.outliers[0]?.loc === '/broken',
  found.outliers.map((o) => o.loc).join(','));
check('reports the typical change alongside it', found.median > 0.02 && found.median < 0.04, String(found.median));

// Everything moved by a similar amount: nothing stands out.
const uniform = Array.from({ length: 20 }, (_, i) => page(`/u${i}`, 0.02 + i * 0.0005));
check('no outliers when every page moved similarly', findOutliers(uniform).outliers.length === 0);

// Too few pages to know what "typical" means.
check('stays quiet on a small group', findOutliers([page('/a', 0.01), page('/b', 0.5)]).outliers.length === 0);

// The absolute floor: three times a tiny number is still tiny.
const tiny = [...Array.from({ length: 20 }, (_, i) => page(`/t${i}`, 0.001 + i * 0.0001)), page('/slight', 0.004)];
check('a tiny change is not an outlier just for being 3x a tinier one',
  findOutliers(tiny).outliers.length === 0,
  findOutliers(tiny).outliers.map((o) => o.loc).join(','));

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exitCode = failures ? 1 : 0;
