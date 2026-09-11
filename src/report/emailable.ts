import { launchBrowser } from '../capture/browser.js';
import { blobKey, hostDir } from '../store/runs.js';
import { joinKey } from '../store/backend.js';
import type { Backends } from '../store/factory.js';
import type { ReportInput } from './build.js';
import { silentReporter, type Reporter } from '../progress.js';
import { describeAssetChange } from '../assets.js';
import { findOutliers, worstRatio } from '../diff/run.js';
import type { CopyFinding } from '../copy/types.js';

export interface PublishOptions {
  /** Flagged pages whose screenshots are embedded. Beyond this, links only. */
  maxEmbeddedPages?: number;
  /** Width to downscale embedded screenshots to. */
  thumbWidth?: number;
  /** Stop embedding once the encoded images pass this, so the file stays mailable. */
  embedBudgetBytes?: number;
  presignSeconds?: number;
  reporter?: Reporter;
}

export interface PublishResult {
  htmlKey: string;
  pdfKey: string;
  htmlBytes: number;
  pdfBytes: number;
}

const DEFAULTS = {
  maxEmbeddedPages: 40,
  thumbWidth: 600,
  embedBudgetBytes: 12 * 1024 * 1024,
  presignSeconds: 7 * 24 * 60 * 60,
};

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );

/**
 * Build the two files that leave the building.
 *
 * The interactive report needs AWS credentials and a running server; these do
 * not. The person who fixes the site is not the person who runs the scan, so
 * the hand-off has to be a file you can attach to an email.
 *
 * Screenshots are the whole difficulty. Desktop captures average 3.5 MB and a
 * run has ~1,500 of them, so "include the screenshots" is not an option at any
 * quality setting -- 524 pages shrunk twelvefold is still 63 MB. What fits is
 * the pages that actually changed, downscaled, with everything else one
 * presigned click away.
 */
export async function publishEmailable(
  input: ReportInput,
  backends: Backends,
  origin: string,
  opts: PublishOptions = {},
): Promise<PublishResult | null> {
  const cfg = { ...DEFAULTS, ...opts };
  const reporter = opts.reporter ?? silentReporter;

  const host = hostDir(origin);
  const date = new Date().toISOString().slice(0, 10);
  const base = `audit-${host}-${date}`;
  const htmlKey = joinKey(host, input.runId, `${base}.html`);
  const pdfKey = joinKey(host, input.runId, `${base}.pdf`);

  const widest = [...input.breakpoints].sort((a, b) => b.width - a.width)[0];
  if (!widest) return null;

  const findings = buildFindings(input);

  // Presigned links only where they can actually be opened by a recipient. The
  // local backend hands back file:// URLs, which would be a broken promise in
  // an emailed document.
  const canLink = backends.data.canPresign;

  const browser = await launchBrowser();
  let htmlBytes = 0;
  let pdfBytes = 0;

  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><meta charset="utf-8"><title>encoder</title>');

    const flagged = (input.diffs ?? [])
      .filter((d) => d.flagged)
      .sort((a, b) => worstRatio(b) - worstRatio(a))
      .slice(0, cfg.maxEmbeddedPages);

    const embedded: EmbeddedPage[] = [];
    let embeddedBytes = 0;

    if (flagged.length) reporter.log(`    embedding ${flagged.length} flagged page(s)`);

    for (const diff of flagged) {
      if (embeddedBytes >= cfg.embedBudgetBytes) break;
      const bp = diff.breakpoints[widest.name];
      if (!bp || bp.status !== 'changed') continue;

      const capture = input.captures.find((c) => c.loc === diff.loc);
      const currentSha = capture?.breakpoints?.[widest.name]?.sha256;

      const images: EmbeddedImage[] = [];
      for (const [label, sha] of [
        ['Before', bp.baselineSha256],
        ['After', currentSha],
        ['Changes highlighted', bp.diffSha256],
      ] as const) {
        if (!sha) continue;
        const png = await backends.data.getBuffer(blobKey(origin, sha));
        if (!png) continue;
        const dataUri = await toWebp(page, png, cfg.thumbWidth);
        if (!dataUri) continue;
        embeddedBytes += dataUri.length;
        images.push({ label, dataUri });
      }

      if (images.length) {
        embedded.push({
          loc: diff.loc,
          ratio: bp.ratio,
          heightDelta: bp.heightDelta,
          breakpoint: widest.name,
          images,
        });
      }
    }

    const links = canLink ? await presignAll(input, backends, origin, widest.name, cfg.presignSeconds) : [];
    if (canLink) reporter.log(`    ${links.length} presigned screenshot link(s), valid 7 days`);

    const html = renderHtml(input, findings, embedded, links, {
      embeddedBytes,
      canLink,
      truncated: (input.diffs ?? []).filter((d) => d.flagged).length > embedded.length,
    });
    const htmlBuf = Buffer.from(html, 'utf8');
    await backends.reports.putBuffer(htmlKey, htmlBuf, 'text/html; charset=utf-8');
    htmlBytes = htmlBuf.length;

    // Findings only. A PDF carrying the screenshots would be the larger file and
    // the one most likely to bounce off a mail server.
    const pdfPage = await browser.newPage();
    await pdfPage.setContent(renderHtml(input, findings, [], links, {
      embeddedBytes: 0,
      canLink,
      truncated: false,
      forPrint: true,
    }), { waitUntil: 'load' });
    const pdfBuf = await pdfPage.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' },
    });
    await pdfPage.close();
    await backends.reports.putBuffer(pdfKey, pdfBuf, 'application/pdf');
    pdfBytes = pdfBuf.length;
  } finally {
    await browser.close().catch(() => {});
  }

  return {
    htmlKey: `${backends.reports.describe}/${htmlKey}`,
    pdfKey: `${backends.reports.describe}/${pdfKey}`,
    htmlBytes,
    pdfBytes,
  };
}

interface EmbeddedImage {
  label: string;
  dataUri: string;
}
interface EmbeddedPage {
  loc: string;
  ratio: number;
  heightDelta: number;
  breakpoint: string;
  images: EmbeddedImage[];
}
interface PageLink {
  loc: string;
  url: string;
}


/**
 * Downscale and re-encode in the browser we already launched for the PDF.
 *
 * The alternative was `sharp`, a native module with a real history of failing
 * to build on Windows -- a heavy dependency to add for roughly 120 images when
 * Chromium is already running and does this natively.
 */
async function toWebp(
  page: import('playwright').Page,
  png: Buffer,
  width: number,
): Promise<string | null> {
  const b64 = png.toString('base64');
  try {
    // Anonymous callbacks only: esbuild's keepNames helper does not exist in the
    // browser context. Same constraint as capture/screenshot.ts.
    return await page.evaluate(
      async (args) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + args.b64;
        await img.decode();

        const scale = Math.min(1, args.width / img.naturalWidth);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));

        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/webp', 0.75);
      },
      { b64, width },
    );
  } catch {
    // One unencodable image must not lose the report.
    return null;
  }
}

async function presignAll(
  input: ReportInput,
  backends: Backends,
  origin: string,
  breakpoint: string,
  seconds: number,
): Promise<PageLink[]> {
  const out: PageLink[] = [];
  for (const c of input.captures) {
    const sha = c.breakpoints?.[breakpoint]?.sha256;
    if (!sha) continue;
    out.push({ loc: c.loc, url: await backends.data.presign(blobKey(origin, sha), seconds) });
  }
  return out;
}

interface Findings {
  broken: { url: string; status: number; verdict: string; pages: string[]; anchorTexts?: string[] }[];
  copy: NonNullable<ReportInput['copy']>['findings'];
  copyCounts: Record<string, number>;
  copySkipped: { check: string; reason: string }[];
  missing: { type: string; urls: string[] }[];
  possiblyMissed: { type: string; restCount: number }[];
  errors: string[];
}

/**
  * What the link actually says on the page.
  *
  * A URL and a page count are not enough to find a link. Seven campotx pages
  * linked to a malformed address whose clickable text was the full stop at the
  * end of a sentence -- the report named the URL, the owner searched the page,
  * found nothing, and concluded the report was wrong. It was not.
  */
function anchorNote(texts?: string[]): string {
  if (!texts?.length) return '';
  const shown = texts.map((t) => (t ? `"${esc(t)}"` : '(no link text)')).join(', ');
  return ` &middot; linked from ${shown}`;
}

function buildFindings(input: ReportInput): Findings {
  const all = [...(input.links?.internal ?? []), ...(input.links?.external ?? [])];
  const broken = all
    .filter((r) => r.verdict === 'broken' || r.verdict === 'error')
    .map((r) => ({
      url: r.url,
      status: r.status,
      verdict: r.verdict,
      pages: r.referrers,
      ...(r.anchorTexts?.length ? { anchorTexts: r.anchorTexts } : {}),
    }))
    .sort((a, b) => b.pages.length - a.pages.length);

  return {
    broken,
    copy: input.copy?.findings ?? [],
    copyCounts: input.copy?.counts ?? {},
    copySkipped: input.copy?.skipped ?? [],
    missing: input.inventory.missingFromSitemap.map((m) => ({ type: m.type, urls: m.urls })),
    possiblyMissed: input.inventory.possiblyMissed.map((m) => ({
      type: m.type,
      restCount: m.restCount,
    })),
    errors: input.inventory.errors,
  };
}

const CATEGORY_LABELS: Record<string, string> = {
  spelling: 'Spelling',
  grammar: 'Grammar',
  mechanical: 'Mechanical',
  consistency: 'Naming consistency',
  date: 'Possibly out of date',
};

function renderHtml(
  input: ReportInput,
  f: Findings,
  embedded: EmbeddedPage[],
  links: PageLink[],
  meta: { embeddedBytes: number; canLink: boolean; truncated: boolean; forPrint?: boolean },
): string {
  const inv = input.inventory;
  const flaggedCount = (input.diffs ?? []).filter((d) => d.flagged).length;
  const missingCount = f.missing.reduce((n, m) => n + m.urls.length, 0);

  const cards: [string, number | string][] = [
    ['Broken links', f.broken.length],
    ['Copy issues', f.copy.length],
    ['Pages changed', flaggedCount],
    ['Missing from sitemap', missingCount],
    ['Pages checked', input.captures.length],
    ['Links checked', input.links?.checked ?? 0],
  ];

  // Every section is collapsed until it is clicked.
  //
  // A campozark report is hundreds of screenshots and hundreds of findings in
  // one scroll, and the length itself puts a reader off before they have read a
  // word of it. Collapsed, the whole report is a dozen named rows with a count
  // on each, and the reader chooses what to open. Nothing is removed -- only
  // the demand that they scroll past all of it.
  //
  // <details> needs no JavaScript, which matters: this file is emailed, saved
  // and reopened from disk. The expand-all buttons are the only scripted part,
  // and the report is complete without them.
  const section = (title: string, body: string, note = '', count?: number): string => {
    if (!body) return '';
    // Printing has no click, so every section is open in the PDF.
    const open = meta.forPrint ? ' open' : '';
    const badge = count === undefined ? '' : `<span class="cnt">${esc(count)}</span>`;
    return `<details class="sec"${open}><summary>${esc(title)}${badge}</summary>
      <div class="secbody">${note ? `<p class="note">${note}</p>` : ''}${body}</div></details>`;
  };

  const pageList = (pages: string[], cap = 12): string =>
    `<ul class="pages">${pages
      .slice(0, cap)
      .map((p) => `<li><a href="${esc(p)}">${esc(p)}</a></li>`)
      .join('')}${
      pages.length > cap ? `<li class="muted">and ${pages.length - cap} more</li>` : ''
    }</ul>`;

  // Code updates go first in the emailable report too. A stakeholder reading
  // this needs to know a theme changed before they read a list of changed pages,
  // or the list looks alarming for no reason.
  // A partial run has to say so before anything else. "Every page" below means
  // every page THIS RUN captured, which is not the same as the site when the run
  // was cut short. onwardlx.com's stored run holds 4 of its 44 pages and the
  // report presented those 4 as the whole site.
  const captureSet = input.inventory.entries.filter((e) => e.tier === 'A' || e.tier === 'B').length;
  const partialBody =
    captureSet > input.captures.length
      ? `<div class="item" style="border-left:4px solid #b91c1c;padding-left:12px">
          <div class="head"><span class="badge bad">Partial run</span></div>
          <div class="meta">This run captured <strong>${input.captures.length}</strong> of the
          <strong>${captureSet}</strong> pages that should be captured on this site. Everything
          in this report describes only those ${input.captures.length} pages. The other
          ${captureSet - input.captures.length} were not looked at.</div>
        </div>`
      : '';

  const assetChanges = input.assetChanges ?? [];
  const assetBody = assetChanges.length
    ? `<div class="item">
        <div class="meta">These updates landed between the two scans. An update can change how
        every page looks at once, which explains a large number of changed pages below.
        It is not a reason to skip checking them &mdash; the thing worth finding is a page
        the update broke.</div>
        <ul>${assetChanges.map((c) => `<li><code>${esc(describeAssetChange(c))}</code></li>`).join('')}</ul>
      </div>`
    : '';

  const { median: typicalChange, outliers } = input.diffs
    ? findOutliers(input.diffs)
    : { median: 0, outliers: [] };

  const outlierBody = outliers.length
    ? `<div class="item">
        <div class="meta">Most changed pages moved about
        ${(typicalChange * 100).toFixed(2)}% of their pixels. These moved far more. If an
        update broke a layout, it is most likely one of these. Open them first.</div>
        <ul>${outliers
          .slice(0, 25)
          .map(
            (d) =>
              `<li><code>${esc(d.loc)}</code> &mdash; ${(worstRatio(d) * 100).toFixed(2)}% changed</li>`,
          )
          .join('')}</ul>
        ${outliers.length > 25 ? `<div class="meta">... and ${outliers.length - 25} more.</div>` : ''}
      </div>`
    : '';

  const brokenBody = f.broken.length
    ? f.broken
        .map(
          (b) => `<div class="item">
            <div class="head"><span class="badge bad">${esc(b.status || b.verdict)}</span>
            <code>${esc(b.url)}</code></div>
            <div class="meta">Linked from ${b.pages.length} page${b.pages.length === 1 ? '' : 's'}${anchorNote(b.anchorTexts)}</div>
            ${pageList(b.pages)}
          </div>`,
        )
        .join('')
    : '';

  // Copy findings split by how sure the checker is, not just by category.
  //
  // "Sunday December 7th is actually a Monday" and "some style guides prefer a
  // comma here" were sitting in one list, and a reader who hits three
  // preferences first concludes the whole section is preferences. The low-
  // confidence group is still here in full -- a reviewer who wants to tighten
  // the copy can open it -- but it no longer stands between the reader and a
  // real defect.
  const copyGroup = (list: CopyFinding[]): string =>
    Object.keys(CATEGORY_LABELS)
      .map((cat) => {
        const inCat = list.filter((x) => x.category === cat);
        if (!inCat.length) return '';
        return `<h3>${esc(CATEGORY_LABELS[cat] ?? cat)} <span class="muted">(${inCat.length})</span></h3>${inCat
          .slice(0, 60)
          .map(
            (x) => `<div class="item">
              <div class="head"><span class="badge ${x.confidence === 'high' ? 'bad' : 'warn'}">${esc(
                x.confidence,
              )}</span> <code>${esc(x.match)}</code></div>
              <div class="msg">${esc(x.message)}</div>
              <div class="excerpt">${esc(x.excerpt)}</div>
              <div class="meta">On ${x.pages.length} page${x.pages.length === 1 ? '' : 's'}</div>
              ${pageList(x.pages, 6)}
            </div>`,
          )
          .join('')}${inCat.length > 60 ? `<p class="muted">and ${inCat.length - 60} more</p>` : ''}`;
      })
      .join('');

  const likelyCopy = f.copy.filter((x) => x.confidence !== 'low');
  const optionalCopy = f.copy.filter((x) => x.confidence === 'low');

  const copyBody = f.copy.length
    ? (likelyCopy.length
        ? `<h2 class="grp">Likely problems <span class="muted">(${likelyCopy.length})</span></h2>${copyGroup(
            likelyCopy,
          )}`
        : '') +
      (optionalCopy.length
        ? `<h2 class="grp">Style suggestions &mdash; your call <span class="muted">(${
            optionalCopy.length
          })</span></h2><p class="note">Nothing here is wrong. These are house-style preferences,
          and a different reviewer would disagree with some of them.</p>${copyGroup(optionalCopy)}`
        : '')
    : '';

  const discoveryCount =
    f.missing.reduce((n, m) => n + m.urls.length, 0) + f.possiblyMissed.length + f.errors.length;

  const discoveryBody =
    (f.missing.length
      ? `<h3>Published but absent from the sitemap</h3>${f.missing
          .map(
            (m) =>
              `<div class="item"><div class="head"><code>${esc(m.type)}</code> <span class="muted">${
                m.urls.length
              } URL(s)</span></div>${pageList(m.urls, 10)}</div>`,
          )
          .join('')}`
      : '') +
    (f.possiblyMissed.length
      ? `<h3>Post types with content but no sitemap entry</h3><ul>${f.possiblyMissed
          .map((m) => `<li><code>${esc(m.type)}</code> — ${m.restCount} published</li>`)
          .join('')}</ul>`
      : '') +
    (f.errors.length
      ? `<h3>Discovery errors</h3><ul>${f.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`
      : '');

  const visualBody = embedded.length
    ? embedded
        .map(
          (p) => `<div class="page">
            <div class="head"><a href="${esc(p.loc)}">${esc(p.loc)}</a></div>
            <div class="meta">${(p.ratio * 100).toFixed(2)}% of pixels changed at ${esc(p.breakpoint)}${
              p.heightDelta ? ` · height ${p.heightDelta > 0 ? '+' : ''}${p.heightDelta}px` : ''
            }</div>
            <div class="shots">${p.images
              .map(
                (i) =>
                  `<figure><figcaption>${esc(i.label)}</figcaption><img src="${i.dataUri}" alt="${esc(
                    i.label,
                  )}"></figure>`,
              )
              .join('')}</div>
          </div>`,
        )
        .join('')
    : '';

  const linksBody =
    meta.canLink && links.length
      ? `<details class="inner"><summary>Full-size screenshot for each of the ${links.length} pages checked</summary>
         <ul class="pages">${links
           .map((l) => `<li><a href="${esc(l.url)}">${esc(l.loc)}</a></li>`)
           .join('')}</ul></details>`
      : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Site audit — ${esc(inv.canonicalOrigin)}</title>
<style>
  :root {
    --ink: #1a1d21; --muted: #61686f; --line: #dfe3e7; --bg: #ffffff;
    --panel: #f6f8f9; --bad: #a5232b; --warn: #8a6100; --accent: #1f5c4a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 900px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2.grp {
    font-size: 16px; margin: 20px 0 10px; padding-bottom: 6px;
    border-bottom: 2px solid var(--accent);
  }
  h3 { font-size: 14px; margin: 22px 0 8px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
  .sub { color: var(--muted); margin: 0 0 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin: 20px 0 8px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; }
  .card .n { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .card .l { font-size: 12px; color: var(--muted); }
  .item { border-left: 3px solid var(--line); padding: 8px 0 8px 12px; margin: 12px 0; }
  .head { font-weight: 600; word-break: break-word; }
  .msg { margin: 3px 0; }
  .excerpt { color: var(--muted); font-style: italic; margin: 3px 0; }
  .meta, .note { color: var(--muted); font-size: 13px; }
  .muted { color: var(--muted); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; word-break: break-all; }
  .badge {
    display: inline-block; padding: 1px 7px; border-radius: 3px; font-size: 12px;
    font-weight: 600; background: var(--panel); border: 1px solid var(--line);
  }
  .badge.bad { color: var(--bad); border-color: #e6bfc2; background: #fdf3f4; }
  .badge.warn { color: var(--warn); border-color: #e8d9ae; background: #fdf9ee; }
  ul.pages { margin: 4px 0; padding-left: 18px; font-size: 13px; }
  ul.pages a { color: var(--accent); }
  a { color: var(--accent); }
  .page { border: 1px solid var(--line); border-radius: 6px; padding: 14px; margin: 16px 0; }
  .shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-top: 10px; }
  figure { margin: 0; }
  figcaption { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  img { width: 100%; height: auto; border: 1px solid var(--line); border-radius: 4px; }
  details.inner { margin: 10px 0; }
  details.inner > summary { cursor: pointer; color: var(--accent); }

  /* Collapsed sections. See the section() helper for why. */
  details.sec {
    border: 1px solid var(--line); border-radius: 6px; margin: 10px 0; overflow: hidden;
  }
  details.sec > summary {
    list-style: none; cursor: pointer; padding: 13px 15px;
    font-size: 17px; font-weight: 600; color: var(--ink);
    display: flex; align-items: center; gap: 11px;
  }
  details.sec > summary::-webkit-details-marker { display: none; }
  details.sec > summary::before {
    content: ''; flex: none; width: 0; height: 0;
    border-left: 6px solid var(--accent);
    border-top: 5px solid transparent; border-bottom: 5px solid transparent;
    transition: transform 0.12s ease;
  }
  details.sec[open] > summary::before { transform: rotate(90deg); }
  details.sec > summary:hover { background: var(--panel); }
  details.sec[open] > summary { border-bottom: 1px solid var(--line); }
  .secbody { padding: 2px 15px 16px; }
  .cnt {
    margin-left: auto; font-size: 13px; font-weight: 600; color: var(--muted);
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 11px; padding: 1px 10px; font-variant-numeric: tabular-nums;
  }
  .tools { display: flex; gap: 8px; margin: 18px 0 2px; }
  .tools button {
    font: inherit; font-size: 13px; color: var(--accent); cursor: pointer;
    background: var(--bg); border: 1px solid var(--line); border-radius: 5px; padding: 4px 11px;
  }
  .tools button:hover { background: var(--panel); }
  footer { margin-top: 48px; padding-top: 14px; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
  @media print {
    .wrap { max-width: none; padding: 0; }
    h2 { break-after: avoid; }
    .item, .page { break-inside: avoid; }
    /* Only the per-page screenshot links are dropped from print. The sections
       themselves are rendered open -- see section(). */
    details.inner, .tools { display: none; }
    details.sec { border: none; }
    details.sec > summary {
      font-size: 18px; padding: 0 0 6px; border-bottom: 2px solid var(--accent);
      margin-top: 30px; break-after: avoid;
    }
    details.sec > summary::before { display: none; }
    .secbody { padding: 0; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>Site audit — ${esc(inv.canonicalOrigin)}</h1>
  <p class="sub">${esc(new Date().toISOString().slice(0, 10))} · run ${esc(input.runId)}${
    input.baselineId ? ` · compared against ${esc(input.baselineId)}` : ' · first run, no comparison available'
  }</p>

  <div class="cards">
    ${cards.map(([label, n]) => `<div class="card"><div class="n">${esc(n)}</div><div class="l">${esc(label)}</div></div>`).join('')}
  </div>

  ${partialBody}
  ${
    meta.forPrint
      ? ''
      : `<div class="tools">
    <button type="button" data-all="1">Expand all</button>
    <button type="button" data-all="0">Collapse all</button>
  </div>`
  }
  ${section("The site's code changed", assetBody, '', assetChanges.length)}
  ${section('Changed much more than the rest', outlierBody, '', outliers.length)}
  ${section('Broken links', brokenBody, 'Each link is listed once, with the pages it appears on and the text it is linked from. A link in the site-wide header or footer will show a large page count.', f.broken.length)}
  ${section('Copy issues', copyBody, f.copySkipped.length ? `Not run: ${f.copySkipped.map((s) => `${esc(s.check)} (${esc(s.reason)})`).join('; ')}` : '', f.copy.length)}
  ${section('Discovery', discoveryBody, '', discoveryCount)}
  ${section(
    'Visual changes',
    visualBody,
    meta.truncated
      ? `Showing the ${embedded.length} most-changed pages of ${flaggedCount}. The rest are in the full report.`
      : '',
    embedded.length,
  )}
  ${section('Every page', linksBody, meta.canLink ? 'These screenshot links expire 7 days after this report was generated. The images above do not.' : '', links.length)}

  <footer>
    Generated by Sitemap Scanner. ${esc(input.captures.length)} pages captured at ${esc(
      input.breakpoints.map((b) => `${b.width}px`).join(', '),
    )}.
    ${input.copy ? `${esc(input.copy.blocksChecked)} distinct text blocks proofread (${esc(input.copy.wordsChecked.toLocaleString())} words).` : ''}
  </footer>
</div>
${
  meta.forPrint
    ? ''
    : `<script>
  // The only script in the file. Everything works with it removed.
  document.querySelectorAll('.tools button').forEach(function (b) {
    b.addEventListener('click', function () {
      var open = b.dataset.all === '1';
      document.querySelectorAll('details.sec').forEach(function (d) { d.open = open; });
    });
  });
</script>`
}
</body>
</html>`;
}
