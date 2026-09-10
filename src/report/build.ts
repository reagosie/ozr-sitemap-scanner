import type { PageCapture } from '../capture/run.js';
import type { PageDiff } from '../diff/run.js';
import type { LinkCheckReport } from '../crawl/links.js';
import type { CopyReport } from '../copy/types.js';
import type { Inventory } from '../types.js';
import { describeAssetChange, type AssetChange } from '../assets.js';
import { findOutliers } from '../diff/run.js';

export interface ReportInput {
  inventory: Inventory;
  captures: PageCapture[];
  diffs: PageDiff[] | null;
  links: LinkCheckReport | null;
  copy: CopyReport | null;
  runId: string;
  baselineId: string | null;
  breakpoints: { name: string; width: number }[];
  threshold: number;
  /** Theme and plugin updates since the baseline. Explains a mass of changes. */
  assetChanges?: AssetChange[];
}

/** One row of the reviewer's worklist. */
interface Row {
  loc: string;
  slug: string;
  type: string;
  tier: string;
  lastmod: string | null;
  discoveredVia: string;
  shots: Record<
    string,
    { file: string; sha256?: string; height: number; ok: boolean; status: number; blocked: boolean }
  >;
  diffs: Record<
    string,
    {
      status: string;
      ratio: number;
      heightDelta: number;
      diffSha256?: string;
      baselineSha256?: string;
    }
  >;
  flagged: boolean;
  worstRatio: number;
  brokenLinks: number;
  /** Copy findings whose text appears on this page. */
  copyIssues: number;
}

function buildRows(input: ReportInput): Row[] {
  const diffByLoc = new Map((input.diffs ?? []).map((d) => [d.loc, d]));

  // Broken outbound links attributed back to the pages that contain them, so a
  // reviewer opening a row sees the problem without cross-referencing.
  const brokenByPage = new Map<string, number>();
  for (const r of [...(input.links?.internal ?? []), ...(input.links?.external ?? [])]) {
    if (r.verdict !== 'broken' && r.verdict !== 'error') continue;
    for (const ref of r.referrers) brokenByPage.set(ref, (brokenByPage.get(ref) ?? 0) + 1);
  }

  // Copy findings counted per page the same way, so a reviewer scanning the
  // worklist sees "this page has three typos" without opening the copy section.
  const copyByPage = new Map<string, number>();
  for (const f of input.copy?.findings ?? []) {
    for (const p of f.pages) copyByPage.set(p, (copyByPage.get(p) ?? 0) + 1);
  }

  const rows: Row[] = input.captures.map((c) => {
    const d = diffByLoc.get(c.loc);
    const diffs: Row['diffs'] = {};
    let worstRatio = 0;

    for (const [bp, r] of Object.entries(d?.breakpoints ?? {})) {
      diffs[bp] = {
        status: r.status,
        ratio: r.ratio,
        heightDelta: r.heightDelta,
        ...(r.diffSha256 ? { diffSha256: r.diffSha256 } : {}),
        ...(r.baselineSha256 ? { baselineSha256: r.baselineSha256 } : {}),
      };
      if (r.status === 'changed') worstRatio = Math.max(worstRatio, r.ratio);
    }

    const brokenLinks = brokenByPage.get(c.loc) ?? 0;
    const copyIssues = copyByPage.get(c.loc) ?? 0;
    return {
      loc: c.loc,
      slug: c.slug,
      type: c.type,
      tier: c.tier,
      lastmod: c.lastmod ?? null,
      discoveredVia: c.discoveredVia,
      shots: c.breakpoints,
      diffs,
      flagged: Boolean(d?.flagged) || brokenLinks > 0,
      worstRatio,
      brokenLinks,
      copyIssues,
    };
  });

  return rows.sort((a, b) => {
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
    if (b.worstRatio !== a.worstRatio) return b.worstRatio - a.worstRatio;
    if (b.brokenLinks !== a.brokenLinks) return b.brokenLinks - a.brokenLinks;
    return b.copyIssues - a.copyIssues;
  });
}

/**
 * Render the interactive report.
 *
 * Returns HTML rather than writing a file: the report may be destined for S3,
 * and this layer has no business knowing which.
 */
export function buildReport(input: ReportInput): string {
  const rows = buildRows(input);
  const inv = input.inventory;

  const linkIssues = [...(input.links?.internal ?? []), ...(input.links?.external ?? [])]
    .filter((r) => r.verdict !== 'ok')
    .sort((a, b) => {
      const rank = (v: string) => (v === 'broken' || v === 'error' ? 0 : v === 'redirect' ? 1 : 2);
      return rank(a.verdict) - rank(b.verdict);
    });

  // Which pages changed far more than the rest. Computed here so both the
  // interactive report and the emailable one rank the same pages first.
  const { median: outlierMedian, outliers } = input.diffs
    ? findOutliers(input.diffs)
    : { median: 0, outliers: [] };
  const outlierLocs = outliers.map((d) => d.loc);

  const payload = {
    site: inv.canonicalOrigin,
    runId: input.runId,
    baselineId: input.baselineId,
    generatedAt: new Date().toISOString(),
    breakpoints: input.breakpoints,
    threshold: input.threshold,
    hasDiffs: Boolean(input.diffs && input.diffs.length),
    assetChanges: (input.assetChanges ?? []).map((c) => ({
      component: c.component,
      kind: c.kind,
      text: describeAssetChange(c),
    })),
    outliers: outlierLocs,
    typicalChange: outlierMedian,
    rows,
    linkIssues,
    copy: input.copy
      ? {
          findings: input.copy.findings,
          counts: input.copy.counts,
          skipped: input.copy.skipped,
          dismissed: input.copy.dismissed,
          blocksChecked: input.copy.blocksChecked,
          wordsChecked: input.copy.wordsChecked,
        }
      : null,
    summary: {
      urls: inv.entries.length,
      captured: input.captures.length,
      flagged: rows.filter((r) => r.flagged).length,
      brokenLinks: input.links?.broken ?? 0,
      blockedLinks: input.links?.blocked ?? 0,
      redirects: input.links?.redirects ?? 0,
      recoveredFromRest: inv.entries.filter((e) => e.discoveredVia === 'rest').length,
      copyFindings: input.copy?.findings.length ?? 0,
    },
    discoveryErrors: inv.errors,
    possiblyMissed: inv.possiblyMissed,
    missingFromSitemap: inv.missingFromSitemap,
    tierC: inv.entries.filter((e) => e.tier === 'C').length,
  };

  // The payload is base64-encoded rather than inlined as raw JSON. That
  // removes two hazards outright instead of escaping around them:
  //  1. a closing script tag inside any page title or URL would end the
  //     <script> block early and break the whole report;
  //  2. String.replace assigns special meaning to $& and friends in the
  //     REPLACEMENT string, and this payload is full of arbitrary site text.
  // Base64 output is alphanumeric, so neither sequence can occur.
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return TEMPLATE.replace('__DATA_B64__', () => b64);
}

/**
 * Single-file report. Screenshots are referenced by RELATIVE path rather than
 * inlined: a run holds well over a gigabyte of full-page PNGs, so embedding
 * them would produce a document no browser could open. `serve` exists to make
 * those relative paths resolve.
 */
const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sitemap Scanner report</title>
<style>
  :root {
    --bg:#0f1115; --panel:#171a21; --line:#262b36; --text:#e6e9ef; --dim:#9aa4b8;
    --flag:#ff6b6b; --ok:#4ade80; --warn:#fbbf24; --info:#60a5fa;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  header { padding:20px 24px; border-bottom:1px solid var(--line); }
  h1 { margin:0 0 4px; font-size:18px; }
  .sub { color:var(--dim); font-size:13px; }
  .cards { display:flex; flex-wrap:wrap; gap:12px; padding:16px 24px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px;
    padding:12px 16px; min-width:120px; }
  .card .n { font-size:22px; font-weight:600; }
  .card .l { color:var(--dim); font-size:12px; }
  .alert { margin:0 24px 12px; padding:12px 16px; border-radius:8px;
    border:1px solid var(--line); background:var(--panel); }
  .alert h3 { margin:0 0 8px; font-size:13px; text-transform:uppercase; letter-spacing:.05em; }
  .alert.err h3 { color:var(--flag); }
  .alert.warn h3 { color:var(--warn); }
  .alert ul { margin:0; padding-left:18px; }
  .alert li { margin:2px 0; color:var(--dim); }
  .controls { display:flex; gap:12px; align-items:center; flex-wrap:wrap;
    padding:12px 24px; border-top:1px solid var(--line); border-bottom:1px solid var(--line);
    position:sticky; top:0; background:var(--bg); z-index:5; }
  input[type=search], select { background:var(--panel); color:var(--text);
    border:1px solid var(--line); border-radius:6px; padding:7px 10px; font-size:13px; }
  input[type=search] { min-width:260px; }
  label { color:var(--dim); font-size:13px; display:flex; align-items:center; gap:6px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line);
    vertical-align:top; font-size:13px; }
  th { color:var(--dim); font-weight:500; font-size:12px; text-transform:uppercase;
    letter-spacing:.04em; }
  tr.row { cursor:pointer; }
  tr.row:hover { background:#1b1f28; }
  .pill { display:inline-block; padding:1px 7px; border-radius:99px; font-size:11px;
    border:1px solid var(--line); color:var(--dim); }
  .pill.flag { color:var(--flag); border-color:var(--flag); }
  .pill.ok { color:var(--ok); border-color:var(--ok); }
  .pill.new { color:var(--info); border-color:var(--info); }
  .pill.rest { color:var(--warn); border-color:var(--warn); }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .detail { background:#12151c; }
  .shots { display:flex; gap:16px; flex-wrap:wrap; padding:12px 0; }
  .shot { border:1px solid var(--line); border-radius:6px; overflow:hidden;
    background:#0b0d11; max-width:420px; }
  .shot h4 { margin:0; padding:6px 10px; font-size:12px; color:var(--dim);
    border-bottom:1px solid var(--line); }
  .shot img { display:block; width:100%; height:auto; }
  .muted { color:var(--dim); }
  .linkbox { padding:12px 0 4px; }
  .linkbox h4 { margin:0 0 8px; font-size:12px; text-transform:uppercase;
    letter-spacing:.04em; color:var(--dim); }
  .linkbox ul { margin:0 0 4px; padding-left:0; list-style:none; }
  .linkbox li { margin:4px 0; display:flex; gap:8px; align-items:baseline;
    flex-wrap:wrap; }
  .why { padding:10px 0 2px; color:var(--dim); font-size:13px; }
  .linkbox details { margin-top:6px; }
  .linkbox summary { cursor:pointer; font-size:12px; padding:4px 0; }
  a { color:var(--info); }
  .empty { padding:40px 24px; color:var(--dim); text-align:center; }
</style>
</head>
<body>
<header>
  <h1 id="title"></h1>
  <div class="sub" id="subtitle"></div>
</header>
<div class="cards" id="cards"></div>
<div id="alerts"></div>
<div class="controls">
  <input type="search" id="q" placeholder="Filter by URL or type...">
  <label><input type="checkbox" id="onlyFlagged"> Flagged only</label>
  <select id="tier">
    <option value="">All tiers</option>
    <option value="A">Tier A</option>
    <option value="B">Tier B</option>
  </select>
  <select id="type"><option value="">All types</option></select>
  <span class="muted" id="count"></span>
</div>
<table>
  <thead><tr>
    <th style="width:44%">URL</th><th>Type</th><th>Tier</th>
    <th>Visual diff</th><th>Links</th><th>Last modified</th>
  </tr></thead>
  <tbody id="tbody"></tbody>
</table>
<div class="empty" id="empty" style="display:none">No rows match these filters.</div>

<script>
var DATA = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('__DATA_B64__'), function (c) { return c.charCodeAt(0); })));

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function pct(r) { return (r * 100).toFixed(3) + '%'; }

// What the link says on the page.
//
// Without this a broken link is a URL and a page count, and the person who has
// to fix it has no way to find it. On campotx seven pages linked to a malformed
// address whose clickable text was the full stop ending a sentence -- invisible
// unless you know to look for it, and the report gave no hint that you should.
function anchorLabel(l) {
  if (!l.anchorTexts || !l.anchorTexts.length) return '';
  var shown = l.anchorTexts.map(function (t) {
    return t ? '"' + esc(t) + '"' : '(no link text)';
  }).join(', ');
  return ' <span class="muted">linked from ' + shown + '</span>';
}

// Relative to this report, which lives at <host>/<runId>/report.html, so
// ../blobs/ lands on the host-level blob store shared by every run.
function blobUrl(sha) { return '../blobs/' + sha + '.png'; }

document.getElementById('title').textContent = 'Sitemap Scanner - ' + DATA.site;
document.getElementById('subtitle').textContent =
  'run ' + DATA.runId + (DATA.baselineId ? '  vs baseline ' + DATA.baselineId : '  (no baseline - first run)') +
  '  -  threshold ' + pct(DATA.threshold);

var s = DATA.summary;
var cards = [
  ['Flagged', s.flagged, s.flagged ? 'flag' : 'ok'],
  ['Captured', s.captured, ''],
  ['URLs found', s.urls, ''],
  ['Broken links', s.brokenLinks, s.brokenLinks ? 'flag' : 'ok'],
  ['Blocked (not broken)', s.blockedLinks, ''],
  ['Redirects', s.redirects, ''],
  ['Copy issues', s.copyFindings || 0, s.copyFindings ? 'flag' : 'ok'],
  ['Recovered from REST', s.recoveredFromRest, s.recoveredFromRest ? 'rest' : ''],
  ['Link-checked only', DATA.tierC, '']
];
document.getElementById('cards').innerHTML = cards.map(function (c) {
  return '<div class="card"><div class="n ' + (c[2] === 'flag' ? 'muted' : '') + '">' + c[1] +
    '</div><div class="l">' + c[0] + '</div></div>';
}).join('');

var alerts = [];

// Theme and plugin updates come FIRST, before any list of changed pages,
// because they are usually the reason those pages changed. Without this the
// reviewer sees hundreds of flagged pages and no explanation for any of them.
if (DATA.assetChanges && DATA.assetChanges.length) {
  alerts.push('<div class="alert warn"><h3>The site's code changed since the baseline (' +
    DATA.assetChanges.length + ')</h3><ul>' +
    DATA.assetChanges.map(function (c) { return '<li class="mono">' + esc(c.text) + '</li>'; }).join('') +
    '</ul><p class="muted">An update like this can change how every page looks at once. ' +
    'That explains why many pages are flagged below. It is not a reason to skip them: ' +
    'the thing worth finding is a page the update broke.</p></div>');
}

// The pages that changed far more than the rest.
if (DATA.outliers && DATA.outliers.length) {
  alerts.push('<div class="alert err"><h3>Changed much more than the rest (' + DATA.outliers.length + ')</h3>' +
    '<p class="muted">Most changed pages moved about ' + pct(DATA.typicalChange) +
    ' of their pixels. These moved far more, so if an update broke a layout, it is most likely here. Open these first.</p><ul>' +
    DATA.outliers.slice(0, 25).map(function (loc) {
      return '<li><a href="#" onclick="openRow(' + JSON.stringify(loc).replace(/"/g, '&quot;') +
        ');return false;" class="mono">' + esc(loc) + '</a></li>';
    }).join('') +
    (DATA.outliers.length > 25 ? '<li class="muted">... and ' + (DATA.outliers.length - 25) + ' more</li>' : '') +
    '</ul></div>');
}
if (DATA.discoveryErrors.length) {
  alerts.push('<div class="alert err"><h3>Discovery errors - inventory is incomplete</h3><ul>' +
    DATA.discoveryErrors.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul></div>');
}
if (DATA.missingFromSitemap.length) {
  alerts.push('<div class="alert warn"><h3>Recovered from REST - published but absent from the sitemap</h3><ul>' +
    DATA.missingFromSitemap.map(function (m) {
      return '<li><strong>' + esc(m.type) + '</strong>: sitemap ' + m.sitemapCount + ' vs REST ' + m.restCount +
        ' - ' + m.urls.length + ' URL(s) added to this run<ul>' +
        m.urls.slice(0, 10).map(function (u) { return '<li><a href="' + esc(u) + '" target="_blank">' + esc(u) + '</a></li>'; }).join('') +
        (m.urls.length > 10 ? '<li>... and ' + (m.urls.length - 10) + ' more</li>' : '') + '</ul></li>';
    }).join('') + '</ul></div>');
}
if (DATA.possiblyMissed.length) {
  alerts.push('<div class="alert warn"><h3>Possibly missed - post types with published items but no sitemap</h3><ul>' +
    DATA.possiblyMissed.map(function (m) {
      return '<li><strong>' + esc(m.type) + '</strong> - ' + m.restCount + ' published (needs a one-time human check)</li>';
    }).join('') + '</ul></div>');
}
if (DATA.linkIssues.length) {
  alerts.push('<div class="alert"><h3>Link issues (' + DATA.linkIssues.length + ')</h3><ul>' +
    DATA.linkIssues.slice(0, 60).map(function (l) {
      var cls = (l.verdict === 'broken' || l.verdict === 'error') ? 'flag' : '';
      return '<li><span class="pill ' + cls + '">' + esc(l.verdict) + ' ' + (l.status || '') + '</span> ' +
        '<a href="' + esc(l.url) + '" target="_blank" class="mono">' + esc(l.url) + '</a>' +
        (l.finalUrl ? ' <span class="muted">-> ' + esc(l.finalUrl) + '</span>' : '') +
        ' <span class="muted">(' + l.referrers.length + ' page' + (l.referrers.length === 1 ? '' : 's') + ')</span>' +
        anchorLabel(l) + '</li>';
    }).join('') + (DATA.linkIssues.length > 60 ? '<li>... see links.json for the rest</li>' : '') + '</ul></div>');
}
if (DATA.copy) {
  var CATEGORY_LABELS = {
    spelling: 'Spelling', grammar: 'Grammar', mechanical: 'Mechanical',
    consistency: 'Naming consistency', date: 'Possibly out of date'
  };
  var COPY_CAP = 150;

  var body = '';
  if (DATA.copy.skipped.length) {
    body += '<p class="muted">Not run: ' + DATA.copy.skipped.map(function (s) {
      return esc(s.check) + ' (' + esc(s.reason) + ')';
    }).join('; ') + '</p>';
  }

  if (!DATA.copy.findings.length) {
    body += '<p class="muted">No copy issues found across ' + DATA.copy.blocksChecked +
      ' distinct text blocks (' + DATA.copy.wordsChecked.toLocaleString() + ' words).</p>';
  } else {
    // Grouped by category, and within a category the sort from copy/run.ts is
    // preserved: certain findings that appear on the most pages come first.
    var groups = {};
    DATA.copy.findings.slice(0, COPY_CAP).forEach(function (f) {
      (groups[f.category] = groups[f.category] || []).push(f);
    });

    Object.keys(CATEGORY_LABELS).forEach(function (cat) {
      var list = groups[cat];
      if (!list || !list.length) return;
      body += '<h4 style="margin:14px 0 6px">' + CATEGORY_LABELS[cat] +
        ' (' + (DATA.copy.counts[cat] || list.length) + ')</h4><ul>';

      list.forEach(function (f) {
        var cls = f.confidence === 'high' ? 'flag' : '';
        body += '<li style="margin-bottom:10px">' +
          '<span class="pill ' + cls + '">' + esc(f.confidence) + '</span> ' +
          '<strong class="mono">' + esc(f.match) + '</strong> - ' + esc(f.message) +
          (f.suggestions.length
            ? ' <span class="muted">suggests: ' + f.suggestions.map(esc).join(', ') + '</span>'
            : '') +
          '<div class="muted" style="margin:3px 0">' + esc(f.excerpt) + '</div>' +
          '<details><summary class="muted">' + f.pages.length + ' page' +
          (f.pages.length === 1 ? '' : 's') + ' - id ' + esc(f.id) + '</summary><ul>' +
          f.pages.slice(0, 25).map(function (p) {
            return '<li><a href="' + esc(p) + '" target="_blank" class="mono">' + esc(p) + '</a></li>';
          }).join('') +
          (f.pages.length > 25 ? '<li class="muted">... and ' + (f.pages.length - 25) + ' more</li>' : '') +
          '</ul></details></li>';
      });

      body += '</ul>';
    });

    if (DATA.copy.findings.length > COPY_CAP) {
      body += '<p class="muted">Showing the first ' + COPY_CAP + ' of ' +
        DATA.copy.findings.length + '; the rest are in copy.json.</p>';
    }
    body += '<p class="muted">A false positive can be retired for good: ' +
      '<code>npm run scan -- dismiss &lt;site&gt; &lt;id&gt;</code>. ' +
      'Dismissed findings never reappear' +
      (DATA.copy.dismissed ? ' (' + DATA.copy.dismissed + ' already hidden).' : '.') + '</p>';
  }

  alerts.push('<div class="alert"><h3>Copy issues (' + DATA.copy.findings.length + ')</h3>' + body + '</div>');
}

document.getElementById('alerts').innerHTML = alerts.join('');

var typeSel = document.getElementById('type');
var types = DATA.rows.map(function (r) { return r.type; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).sort();
types.forEach(function (t) {
  var o = document.createElement('option'); o.value = t; o.textContent = t; typeSel.appendChild(o);
});

// Default to "flagged only" whenever there is a baseline to compare against.
// On a first run everything is new, so that filter would hide the whole report.
document.getElementById('onlyFlagged').checked = DATA.hasDiffs;

function diffCell(r) {
  var out = [];
  DATA.breakpoints.forEach(function (bp) {
    var d = r.diffs[bp.name];
    var shot = r.shots[bp.name];
    if (!d) {
      out.push('<span class="pill">' + bp.name + (shot && !shot.ok ? ' err' : ' -') + '</span>');
      return;
    }
    var cls = d.status === 'changed' ? 'flag' : d.status === 'new' ? 'new' : 'ok';
    var label = d.status === 'changed' ? pct(d.ratio) : d.status === 'new' ? 'new' : 'same';
    var h = d.heightDelta ? ' h' + (d.heightDelta > 0 ? '+' : '') + d.heightDelta : '';
    out.push('<span class="pill ' + cls + '">' + bp.name + ' ' + label + h + '</span>');
  });
  return out.join(' ');
}

function linkCell(r) {
  var issues = linkIssuesFor(r.loc);
  var broken = issues.filter(function (l) { return l.verdict === 'broken' || l.verdict === 'error'; }).length;
  var redirects = issues.filter(function (l) { return l.verdict === 'redirect'; }).length;
  var out = [];
  if (broken) out.push('<span class="pill flag">' + broken + ' broken</span>');
  if (redirects) out.push('<span class="pill">' + redirects + ' redirect' + (redirects === 1 ? '' : 's') + '</span>');
  return out.length ? out.join(' ') : '<span class="muted">-</span>';
}

// Jump to one page's row from a link elsewhere in the report, and open it.
// Uses the search box rather than its own lookup, so there is one code path
// that decides which rows exist.
function openRow(loc) {
  document.getElementById('q').value = loc;
  document.getElementById('onlyFlagged').checked = false;
  render();
  var first = document.querySelector('tr.row');
  if (first) {
    first.onclick();
    first.scrollIntoView({ block: 'center' });
  }
}

var OUTLIERS = {};
(DATA.outliers || []).forEach(function (loc) { OUTLIERS[loc] = true; });

function render() {
  var q = document.getElementById('q').value.toLowerCase();
  var onlyFlagged = document.getElementById('onlyFlagged').checked;
  var tier = document.getElementById('tier').value;
  var type = typeSel.value;

  var rows = DATA.rows.filter(function (r) {
    if (onlyFlagged && !r.flagged) return false;
    if (tier && r.tier !== tier) return false;
    if (type && r.type !== type) return false;
    if (q && r.loc.toLowerCase().indexOf(q) === -1 && r.type.toLowerCase().indexOf(q) === -1) return false;
    return true;
  });

  document.getElementById('count').textContent = rows.length + ' of ' + DATA.rows.length + ' pages';
  document.getElementById('empty').style.display = rows.length ? 'none' : 'block';

  document.getElementById('tbody').innerHTML = rows.map(function (r, i) {
    return '<tr class="row" data-i="' + i + '">' +
      '<td><a href="' + esc(r.loc) + '" target="_blank" onclick="event.stopPropagation()">' + esc(r.loc) + '</a>' +
        (r.discoveredVia === 'rest' ? ' <span class="pill rest">rest</span>' : '') +
        (OUTLIERS[r.loc] ? ' <span class="pill flag" title="Changed far more than other pages in this run">changed a lot</span>' : '') + '</td>' +
      '<td class="mono">' + esc(r.type) + '</td>' +
      '<td>' + r.tier + '</td>' +
      '<td>' + diffCell(r) + '</td>' +
      '<td>' + linkCell(r) + '</td>' +
      '<td class="mono muted">' + (r.lastmod ? esc(r.lastmod.slice(0, 10)) : 'none') + '</td>' +
    '</tr><tr class="detail" id="d' + i + '" style="display:none"><td colspan="6"></td></tr>';
  }).join('');

  Array.prototype.forEach.call(document.querySelectorAll('tr.row'), function (tr) {
    tr.onclick = function () {
      var i = tr.getAttribute('data-i');
      var d = document.getElementById('d' + i);
      if (d.style.display === 'none') {
        d.style.display = '';
        if (!d.dataset.built) { d.querySelector('td').innerHTML = detailHtml(rows[i]); d.dataset.built = '1'; }
      } else { d.style.display = 'none'; }
    };
  });
}

function linkIssuesFor(loc) {
  return DATA.linkIssues.filter(function (l) { return l.referrers.indexOf(loc) !== -1; });
}

function detailHtml(r) {
  var out = '';

  // Say plainly why this row is in the list. A page can be flagged for a broken
  // link while looking perfectly fine on screen -- the site-wide footer link is
  // exactly that case -- and without this the reviewer is left hunting.
  var reasons = [];
  if (r.brokenLinks) reasons.push(r.brokenLinks + ' broken link' + (r.brokenLinks === 1 ? '' : 's') + ' on this page');
  var changed = DATA.breakpoints.filter(function (bp) {
    return r.diffs[bp.name] && r.diffs[bp.name].status === 'changed';
  }).map(function (bp) { return bp.name + ' ' + pct(r.diffs[bp.name].ratio); });
  if (changed.length) reasons.push('visual change at ' + changed.join(', '));
  if (r.copyIssues) {
    reasons.push(r.copyIssues + ' copy issue' + (r.copyIssues === 1 ? '' : 's') + ' (see Copy issues above)');
  }
  if (r.discoveredVia === 'rest') reasons.push('published but MISSING from the sitemap');
  if (reasons.length) out += '<div class="why"><strong>Flagged because:</strong> ' + reasons.join(' &middot; ') + '</div>';

  var issues = linkIssuesFor(r.loc);
  if (issues.length) {
    var rank = { broken: 0, error: 0, blocked: 1, redirect: 2 };
    issues = issues.slice().sort(function (a, b) {
      return (rank[a.verdict] === undefined ? 9 : rank[a.verdict]) - (rank[b.verdict] === undefined ? 9 : rank[b.verdict]);
    });
    // Broken links are shown outright; redirects are collapsed behind a
    // disclosure. One real page carried 35 broken links and 180 redirects, and
    // listing them together buried the thing the reviewer has to act on. A
    // redirect is worth knowing about but is not a defect.
    var renderItem = function (l) {
      var cls = (l.verdict === 'broken' || l.verdict === 'error') ? 'flag' : (l.verdict === 'redirect' ? '' : 'ok');
      return '<li><span class="pill ' + cls + '">' + esc(l.verdict) + (l.status ? ' ' + l.status : '') + '</span>' +
        '<a href="' + esc(l.url) + '" target="_blank" class="mono">' + esc(l.url) + '</a>' +
        (l.finalUrl ? '<span class="muted mono">&rarr; ' + esc(l.finalUrl) + '</span>' : '') +
        '<span class="muted">on ' + l.referrers.length + ' page' + (l.referrers.length === 1 ? '' : 's') + '</span>' +
        anchorLabel(l) + '</li>';
    };

    var needsAction = issues.filter(function (l) { return l.verdict !== 'redirect'; });
    var redirects = issues.filter(function (l) { return l.verdict === 'redirect'; });

    out += '<div class="linkbox">';
    if (needsAction.length) {
      out += '<h4>Broken links on this page (' + needsAction.length + ')</h4><ul>' +
        needsAction.map(renderItem).join('') + '</ul>';
    }
    if (redirects.length) {
      out += '<details><summary class="muted">' + redirects.length +
        ' redirect' + (redirects.length === 1 ? '' : 's') + ' (working, but the link could be updated)</summary><ul>' +
        redirects.map(renderItem).join('') + '</ul></details>';
    }
    out += '</div>';
  }

  // Images are content-addressed and shared across runs, so every src points at
  // ../blobs/<sha>.png. The baseline is reached by hash too rather than by
  // walking into another run's directory - which is what lets an unchanged page
  // cost nothing to store twice.
  out += '<div class="shots">';
  DATA.breakpoints.forEach(function (bp) {
    var shot = r.shots[bp.name];
    if (!shot || !shot.sha256) return;
    var d = r.diffs[bp.name] || {};
    out += '<div class="shot"><h4>' + bp.name + ' - current' +
      (shot.blocked ? ' (BLOCKED)' : '') + '</h4><img loading="lazy" src="' + blobUrl(shot.sha256) + '"></div>';
    if (d.status === 'changed') {
      if (d.baselineSha256) {
        out += '<div class="shot"><h4>' + bp.name + ' - baseline</h4><img loading="lazy" src="' +
          blobUrl(d.baselineSha256) + '"></div>';
      }
      if (d.diffSha256) {
        out += '<div class="shot"><h4>' + bp.name + ' - diff overlay</h4><img loading="lazy" src="' +
          blobUrl(d.diffSha256) + '"></div>';
      }
    }
  });
  return out + '</div>';
}

['q', 'onlyFlagged', 'tier', 'type'].forEach(function (id) {
  var el = document.getElementById(id);
  el.addEventListener(el.tagName === 'INPUT' && el.type === 'search' ? 'input' : 'change', render);
});
render();
</script>
</body>
</html>`;
