import type { BrowserContext } from 'playwright';
import { collectAssetVersions, type AssetVersions } from '../assets.js';

/**
 * Neutralize motion without erasing layout.
 *
 * Deliberately NOT `animation: none` -- Elementor entrance effects commonly
 * animate from opacity:0, and killing the animation outright can freeze an
 * element in its invisible starting state. Collapsing duration/delay to zero
 * and forcing a single iteration lands every animation on its FINAL frame,
 * which is what a human sees once a page settles.
 */
const FREEZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
}
html { scroll-behavior: auto !important; }
`;

/** One readable chunk of page copy, as rendered. */
export interface TextBlock {
  /** Element tag, lowercased -- gives the reviewer somewhere to look. */
  tag: string;
  text: string;
}

/**
 * Where lazy-loading scripts keep the real image URL.
 *
 * WordPress sites almost all run one of these. The script puts a tiny grey SVG
 * in `src` and the real address in one of these attributes, then swaps them
 * when the image scrolls into view. onwardlx.com uses `data-lazy-src`, which is
 * WP Rocket's.
 *
 * This matters because a placeholder passes every ordinary "has this image
 * loaded?" test: it reports complete=true and a non-zero naturalWidth, since
 * the placeholder itself really did load. The whole pricing panel on
 * onwardlx.com/about-ole/ was captured as an empty grey box for exactly this
 * reason, and nothing in the capture noticed.
 */
const LAZY_ATTRS = {
  src: ['data-lazy-src', 'data-src', 'data-original', 'data-echo'],
  srcset: ['data-lazy-srcset', 'data-srcset'],
};

export interface CaptureResult {
  url: string;
  ok: boolean;
  status: number;
  /** True when the response looks like bot protection rather than a real fault. */
  blocked: boolean;
  height: number;
  links: string[];
  /** Anchor text per href, for locating a broken link on the page. */
  linkTexts: Record<string, string>;
  /** Theme and plugin versions read off this page's stylesheets and scripts. */
  assetVersions: AssetVersions;
  /** Empty unless `extractText` was requested. */
  textBlocks: TextBlock[];
  /** The PNG itself. Absent when the capture failed. */
  buffer?: Buffer;
  error?: string;
}

export interface CaptureOptions {
  mask?: string[];
  /**
   * Selectors removed from layout (display:none) BEFORE the page is measured.
   *
   * Distinct from `mask`, which paints over an element after layout: masking
   * hides changing pixels but not a changing HEIGHT. A third-party embed that
   * loads a variable number of items shifts everything below it and resizes the
   * page, so only removal makes the capture deterministic. Use `hide` for
   * third-party content that is not part of the site review; use `mask` for
   * first-party regions whose layout matters but whose content churns.
   */
  hide?: string[];
  navTimeoutMs?: number;
  idleTimeoutMs?: number;
  /**
   * Collect page copy for the proofreader.
   *
   * Only requested at ONE breakpoint. The text is identical across widths --
   * responsive CSS changes layout, not words -- so extracting it three times
   * would triple the work and then throw two thirds of it away.
   */
  extractText?: boolean;
  /**
   * Selectors whose text is excluded from proofreading, comma-separated.
   *
   * Distinct from `hide` and `mask`: those change the SCREENSHOT. This changes
   * only what the copy checks read, so a cookie banner is still reviewed
   * visually while its boilerplate stays out of the findings list.
   */
  textIgnoreSelector?: string;
}

export async function capturePage(
  ctx: BrowserContext,
  url: string,
  opts: CaptureOptions,
): Promise<CaptureResult> {
  const {
    mask = [],
    hide = [],
    navTimeoutMs = 45_000,
    idleTimeoutMs = 8_000,
    extractText = false,
    textIgnoreSelector = '',
  } = opts;
  const page = await ctx.newPage();

  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: navTimeoutMs });
    const status = response?.status() ?? 0;

    // Cloudflare fronts every target site. A 403/429 here is bot protection,
    // not a broken page -- surfacing it as "broken" would cry wolf.
    const blocked = status === 403 || status === 429;

    // networkidle is BOUNDED: analytics and Cloudflare beacons can keep the
    // network busy indefinitely, so a timeout here is normal, not a failure.
    await page.waitForLoadState('networkidle', { timeout: idleTimeoutMs }).catch(() => {});

    // WP Rocket (ozarkleadershipinstitute.com, onwardlx.com) defers ALL JS
    // until a genuine user interaction. Without this the page can be captured
    // unhydrated. A real mouse move plus the events its listener watches for.
    await page.mouse.move(20, 20).catch(() => {});
    await page.evaluate(() => {
      for (const type of ['mousemove', 'mousedown', 'keydown', 'touchstart', 'touchmove', 'wheel']) {
        window.dispatchEvent(new Event(type, { bubbles: true }));
        document.dispatchEvent(new Event(type, { bubbles: true }));
      }
    });

    await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});

    // Applied before the scroll pass so hidden elements never contribute height.
    if (hide.length) {
      await page
        .addStyleTag({ content: hide.map((sel) => `${sel} { display: none !important; }`).join(' ') })
        .catch(() => {});
    }

    // Scroll the page end to end to trigger lazy loading, driven from Node
    // rather than from an in-page timer.
    //
    // An in-page setInterval can only guess how long a step needs. Stepping
    // from here lets each stop actually WAIT for network activity to quiet
    // before moving on, which is the difference between requesting an image and
    // having it decoded. The failure this fixes: a photo grid where the second
    // image was present in one run and blank in the next, on a page whose
    // height was byte-identical -- the space was reserved, the image just had
    // not painted yet.
    //
    // Height is re-measured each pass because lazy content can extend the page
    // as it loads, and a fixed bound computed up front would stop short.
    {
      const viewport = page.viewportSize();
      const step = Math.max(400, Math.floor((viewport?.height ?? 900) * 0.8));
      let position = 0;
      let guard = 0;

      while (guard++ < 60) {
        const pageHeight: number = await page.evaluate(() => document.documentElement.scrollHeight);
        if (position >= pageHeight) break;
        await page.evaluate((y) => window.scrollTo(0, y), position);
        await page.waitForLoadState('networkidle', { timeout: 2_000 }).catch(() => {});
        position += step;
      }

      await page.evaluate(() => window.scrollTo(0, 0));
    }

    // Repair pass: hunt down images that STILL have not painted.
    //
    // The scroll above fixes most of them, but a few stragglers survived it --
    // 2 of 20 pages self-diffed on a single band, always a photo grid whose
    // second image was blank in one run and present in the other, on a page of
    // byte-identical height. Rather than wait longer globally (which measurably
    // made things worse), this seeks out only the specific images that are
    // still incomplete, scrolls each back into view so the browser re-prioritises
    // it, and gives it a moment.
    //
    // Bounded twice over: at most two rounds, and at most 20 images per round.
    // An image that is never going to load must not be able to stall the run.
    for (let round = 0; round < 2; round++) {
      const stragglers: number[] = await page.evaluate((lazyAttrs) => {
        const out: number[] = [];
        for (const img of Array.from(document.images)) {
          const current = img.currentSrc || img.src || '';
          // A `data:` URI in src next to a real URL in a data- attribute is a
          // lazy-loading placeholder that was never swapped in.
          const showingPlaceholder = !current || current.startsWith('data:');
          const realSrc = lazyAttrs.src.map((a) => img.getAttribute(a)).find(Boolean);
          const realSet = lazyAttrs.srcset.map((a) => img.getAttribute(a)).find(Boolean);

          if (showingPlaceholder && (realSrc || realSet)) {
            // Assign the real source directly instead of hoping another scroll
            // makes the site's lazy-load script notice. Scrolling is a request;
            // this is the thing itself.
            if (realSet) img.setAttribute('srcset', realSet);
            if (realSrc) img.setAttribute('src', realSrc);
            out.push(img.getBoundingClientRect().top + window.scrollY);
            continue;
          }
          if (current && !(img.complete && img.naturalWidth > 0)) {
            out.push(img.getBoundingClientRect().top + window.scrollY);
          }
        }
        return out;
      }, LAZY_ATTRS);
      if (!stragglers.length) break;

      for (const y of stragglers.slice(0, 20)) {
        await page.evaluate((top) => window.scrollTo(0, Math.max(0, top - 200)), y);
        await page.waitForLoadState('networkidle', { timeout: 1_500 }).catch(() => {});
      }
      await page.evaluate(() => window.scrollTo(0, 0));
    }

    // Wait until the page STOPS CHANGING, rather than until some condition
    // about images is satisfied.
    //
    // Two earlier attempts failed against these sites. Waiting for every image
    // to complete never settles -- images below the fold after scrolling back
    // to top stay incomplete forever, so every page burned the full timeout,
    // and the longer window let other dynamic content drift (noise got WORSE:
    // 10 of 20 pages self-diffed). Forcing loading="eager" fired every request
    // at once and, across concurrent pages, made loading less reliable still.
    //
    // Sampling a signature of (page height, image count, completed-image count)
    // and returning once it repeats sidesteps both: images that will never load
    // stop mattering, and the wait ends as soon as things are actually stable.
    //
    // NOTE: no NAMED function may be declared inside page.evaluate. esbuild
    // (used by tsx) rewrites `const f = () => {}` with its keepNames helper
    // `__name`, which does not exist in the browser context and throws
    // "ReferenceError: __name is not defined". Keep callbacks anonymous.
    await page.evaluate(async (cfg) => {
      const deadline = Date.now() + cfg.maxMs;
      let previous = '';
      let repeats = 0;
      while (Date.now() < deadline) {
        const imgs = Array.from(document.images);
        const signature = [
          document.documentElement.scrollHeight,
          imgs.length,
          imgs.filter((i) => i.complete && i.naturalWidth > 0).length,
          // Counted separately because a placeholder reports complete=true with
          // a real naturalWidth -- the count above cannot see that the picture
          // on screen is a 1x1 grey rectangle rather than the photograph.
          imgs.filter((i) => {
            const current = i.currentSrc || i.src || '';
            return (
              (!current || current.startsWith('data:')) &&
              cfg.lazyAttrs.some((a) => i.getAttribute(a))
            );
          }).length,
        ].join(':');
        // Require sustained quiet, not two adjacent samples. With several pages
        // loading concurrently a brief bandwidth stall looks identical to a
        // settled page, and exiting on it captures a half-loaded grid.
        if (signature === previous) {
          repeats++;
          if (repeats >= cfg.repeatsRequired) return;
        } else {
          repeats = 0;
          previous = signature;
        }
        await new Promise((r) => setTimeout(r, cfg.intervalMs));
      }
    }, {
      maxMs: 15_000,
      intervalMs: 400,
      repeatsRequired: 3,
      lazyAttrs: [...LAZY_ATTRS.src, ...LAZY_ATTRS.srcset],
    });

    // Fonts settle after lazy content lands; a page screenshotted mid-swap
    // shows fallback metrics and diffs against itself.
    await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});

    // Stop JS-driven motion that CSS overrides cannot reach.
    await page.evaluate(() => {
      document.querySelectorAll('video, audio').forEach((m: any) => {
        try {
          m.pause?.();
          m.autoplay = false;
          m.currentTime = 0;
        } catch {
          /* cross-origin media */
        }
      });
      document.querySelectorAll('.swiper, .swiper-container').forEach((el: any) => {
        try {
          el.swiper?.autoplay?.stop();
        } catch {
          /* not a swiper */
        }
      });
    });

    // Settle any layout shift caused by the freeze itself.
    await page.waitForTimeout(300);

    const height = await page.evaluate(() => document.documentElement.scrollHeight);

    // Collected at every breakpoint and unioned by the caller: a hamburger nav
    // can expose links at 390px that are absent from the desktop DOM.
    // The anchor's TEXT is collected with it, because a URL alone is not enough
    // to find the link on the page. On campotx, seven pages linked to a
    // malformed address whose clickable text was a single full stop at the end
    // of a sentence -- the report named the URL, and nobody could find it.
    const anchors = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]'))
        .map((a) => ({
          href: (a as HTMLAnchorElement).href,
          text: ((a as HTMLElement).innerText || a.getAttribute('aria-label') || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80),
        }))
        .filter((a) => a.href),
    );
    // Theme and plugin versions, read from the version number WordPress puts on
    // every stylesheet and script it loads. Collected here because the page is
    // already open; see assets.ts for what it is for.
    const assetUrls = await page.evaluate(() => [
      ...Array.from(document.querySelectorAll('link[href]')).map((el) => (el as HTMLLinkElement).href),
      ...Array.from(document.querySelectorAll('script[src]')).map((el) => (el as HTMLScriptElement).src),
    ]);
    const assetVersions = collectAssetVersions(assetUrls);

    const links = anchors.map((a) => a.href);
    const linkTexts: Record<string, string> = {};
    for (const a of anchors) {
      // First non-empty wins; an empty one still records the href so the report
      // can say the anchor had no text at all, which is itself the explanation.
      if (linkTexts[a.href] === undefined || (!linkTexts[a.href] && a.text)) {
        linkTexts[a.href] = a.text;
      }
    }

    // Page copy, read from the RENDERED dom for the same reason links are: text
    // injected or rewritten by JS is text a visitor sees, and fetching the HTML
    // separately would miss it.
    //
    // Only the outermost matching element is kept -- a <li> wrapping a <p>
    // would otherwise report the same sentence twice, once nested inside the
    // other, and the reviewer would see a duplicate finding for a single typo.
    // Same anonymous-callback rule as everywhere else in this file.
    const textBlocks: TextBlock[] = extractText
      ? await page.evaluate((ignoreSelector) => {
          const SELECTOR =
            'p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,figcaption,dt,dd,summary,label,button,a';
          const seen = new Set<string>();
          const out: { tag: string; text: string }[] = [];

          for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
            if (el.parentElement && el.parentElement.closest(SELECTOR)) continue;
            // Cookie banners and consent modals are third-party boilerplate that
            // nobody will ever edit. Left in, they are the loudest copy findings
            // on the site -- present on every page, and not the site's words.
            if (ignoreSelector && el.closest(ignoreSelector)) continue;

            // innerText, not textContent: it reflects what is actually rendered,
            // so display:none blocks and the elements hidden by config return ''.
            const raw = (el as HTMLElement).innerText;
            if (!raw) continue;

            // Split on the LINE BREAKS innerText inserts, and keep them as block
            // boundaries.
            //
            // Collapsing them into spaces welds neighbouring UI text together and
            // invents defects that are not on the page: a nested nav rendered
            // "Ready Set Camp\nCamp Prep Guide" became "Ready Set Camp Camp Prep
            // Guide", reported as a repeated word on 516 pages, and a heading
            // followed by a paragraph became "ExperienceOur". Only spaces within
            // a line are safe to collapse.
            for (const line of raw.split('\n')) {
              const text = line.replace(/[^\S\n]+/g, ' ').trim();
              // Below this length a "block" is a nav label or a bare number, which
              // produces noise in every checker and signal in none.
              if (text.length < 12) continue;
              if (seen.has(text)) continue;

              seen.add(text);
              out.push({ tag: el.tagName.toLowerCase(), text });
            }

            if (out.length >= 800) break;
          }

          return out;
        }, textIgnoreSelector)
      : [];

    // No `path`: the buffer goes to content-addressed storage under the hash of
    // these bytes, so writing it to a per-run filename here would be a detour.
    // Final paint pass, immediately before the shutter.
    //
    // A full-page screenshot composites tiles the renderer has already drawn.
    // An image can be fully loaded -- real src, complete=true, correct natural
    // size -- and still be absent from the picture, because the region it lives
    // in was never rasterised while it was off screen. Measured on
    // onwardlx.com/about-ole/: the pricing panel was missing from 2 of 3
    // captures with the image reporting as loaded in every one.
    //
    // Walking the viewport down the page and waiting for two animation frames
    // at each stop forces the renderer to draw every band. Two frames, not one:
    // the first schedules the paint and the second lets it finish.
    {
      await page.evaluate(async () => {
        // decode() is the part that was missing. `complete` only promises the
        // bytes arrived; decoding to a paintable bitmap can still be pending,
        // and an undecoded image is drawn as nothing. Awaiting it is the
        // difference between an image the DOM calls loaded and an image the
        // renderer can actually put on screen.
        await Promise.all(
          Array.from(document.images).map((img) =>
            img.decode ? img.decode().catch(() => undefined) : undefined,
          ),
        );

        const step = Math.max(200, Math.floor(window.innerHeight / 2));
        for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        }
        window.scrollTo(0, 0);
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      });
      // One more beat for the compositor to commit the last frame.
      await page.waitForTimeout(150);
    }

    const buffer = await page.screenshot({
      fullPage: true,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      ...(mask.length ? { mask: mask.map((sel) => page.locator(sel)) } : {}),
    });

    return {
      url,
      ok: status >= 200 && status < 400,
      status,
      blocked,
      height,
      links,
      linkTexts,
      assetVersions,
      textBlocks,
      buffer,
    };
  } catch (err) {
    return {
      url,
      ok: false,
      status: 0,
      blocked: false,
      height: 0,
      links: [],
      linkTexts: {},
      assetVersions: {},
      textBlocks: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await page.close().catch(() => {});
  }
}
