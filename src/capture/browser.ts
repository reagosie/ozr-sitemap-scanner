import { chromium, type Browser, type BrowserContext } from 'playwright';
import { UA_DESKTOP } from '../crawl/fetcher.js';

export interface BreakpointSpec {
  name: string;
  width: number;
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ args: ['--disable-dev-shm-usage'] });
}

/**
 * One context per breakpoint.
 *
 * The desktop UA is used at EVERY width, deliberately. Verified against
 * campozark.com and ozarkleadershipinstitute.com: both return byte-identical
 * HTML for desktop and iPhone user agents, and neither varies on User-Agent,
 * so these are responsive-CSS sites with no separate mobile render. Sending one
 * consistent UA keeps runs comparable and avoids tripping Cloudflare, which was
 * observed rejecting unusual/short user agents with 403.
 */
export async function makeContext(
  browser: Browser,
  bp: BreakpointSpec,
  blockUrls: string[] = [],
): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    viewport: { width: bp.width, height: 900 },
    userAgent: UA_DESKTOP,
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    ignoreHTTPSErrors: true,
    locale: 'en-US',
    timezoneId: 'America/Chicago',
  });

  // Third-party widgets (chat bubbles, ad/analytics beacons) are the main
  // remaining source of run-to-run pixel noise and of networkidle never firing.
  if (blockUrls.length) {
    await ctx.route('**/*', (route) => {
      const url = route.request().url();
      if (blockUrls.some((frag) => url.includes(frag))) return route.abort();
      return route.continue();
    });
  }

  return ctx;
}
