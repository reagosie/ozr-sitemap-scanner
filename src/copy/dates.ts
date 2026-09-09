import { excerptAround, findingId, type Corpus } from './extract.js';
import type { Confidence, CopyFinding } from './types.js';

/**
 * Phrases that make a date a PROMISE rather than a record.
 *
 * "Founded in 1985" is correct forever; "Register by March 1, 2024" rots. Only
 * the second kind is worth a reviewer's attention, and the difference is
 * entirely in the surrounding words.
 */
const FORWARD_LOOKING =
  /\b(register|registration|sign\s?up|signup|enroll|apply|application|deadline|upcoming|don'?t\s+miss|save\s+the\s+date|join\s+us|reserve|book|early\s+bird|space[s]?\s+available|openings?|schedule|dates?\s+for|will\s+be|starts?|begins?|coming\s+soon)\b/i;

/**
 * Phrases that make a past year correct on purpose.
 *
 * The biography verbs matter as much as the institutional ones. Staff pages are
 * dense with "graduated in 2010" and "joined the team in 2012", and every one of
 * those is a permanently correct sentence -- on a first pass against
 * campozarkfoundation they were four of the four date findings.
 */
const HISTORICAL =
  /\b(since|founded|established|began\s+in|started\s+in|history|anniversar|celebrat|in\s+memor|alumni|legacy|tradition|originally|first\s+opened|graduat|earned|received|attended|joined|born|married|retired|served|worked|degree|bachelor|master|doctorate|ph\.?d|award|B\.?A\.?|B\.?S\.?|M\.?A\.?|M\.?S\.?)\b/i;

/**
 * How far back a season/month mention can be before it reads as history.
 *
 * "Summer 2024" on a page in 2026 is worth a glance; "Summer 2011" is a
 * reminiscence. Without this bound, every bio and every archived event becomes a
 * finding.
 */
const SEASONAL_LOOKBACK_YEARS = 3;

/** Years plausible for a camp website; avoids matching prices and zip codes. */
const YEAR_RE = /\b(19[5-9]\d|20[0-4]\d)\b/g;

const COPYRIGHT_RE = /(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–—]\s*)?(\d{4})/gi;

const SEASON_OR_MONTH =
  /\b(spring|summer|fall|autumn|winter|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

export interface DateOptions {
  /** Anything before this is potentially stale. Defaults to the current year. */
  currentYear?: number;
  /** Cap on findings, since a large site mentions years constantly. */
  limit?: number;
}

/**
 * Surface past-dated copy that reads as if it were still upcoming.
 *
 * This check deliberately reports CANDIDATES, not defects. Deciding whether
 * "Summer 2024" on a page is stale or an accurate historical reference needs to
 * know what the page is for, which no rule can. So the output is a short list
 * ranked by how forward-looking the surrounding sentence sounds, and a human
 * spends a minute on it -- which is still infinitely better than the current
 * situation, where nobody looks at all.
 */
export function checkDates(corpus: Corpus, opts: DateOptions = {}): CopyFinding[] {
  const currentYear = opts.currentYear ?? new Date().getFullYear();
  const limit = opts.limit ?? 60;

  const byKey = new Map<string, CopyFinding>();

  const record = (
    match: string,
    excerpt: string,
    message: string,
    confidence: Confidence,
    pages: string[],
    detail: string,
  ): void => {
    const key = `${match}|${detail}`;
    const existing = byKey.get(key);
    if (existing) {
      for (const p of pages) if (!existing.pages.includes(p)) existing.pages.push(p);
      return;
    }
    byKey.set(key, {
      id: findingId('date', match, detail),
      category: 'date',
      message,
      match,
      excerpt,
      suggestions: [],
      confidence,
      pages: [...pages],
    });
  };

  for (const block of corpus.blocks) {
    const text = block.text;

    // A stale copyright year is its own thing: unambiguous, always in the
    // footer, and therefore on every page at once.
    for (const m of text.matchAll(COPYRIGHT_RE)) {
      const year = Number(m[1]);
      if (!Number.isFinite(year) || year >= currentYear) continue;
      record(
        m[0],
        excerptAround(text, m.index ?? 0, m[0].length),
        `Copyright year is ${year}, but it is ${currentYear}`,
        'high',
        block.pages,
        'copyright',
      );
    }

    for (const m of text.matchAll(YEAR_RE)) {
      const year = Number(m[1]);
      if (!Number.isFinite(year) || year >= currentYear) continue;

      const index = m.index ?? 0;
      // A window, not the whole block: a forward-looking verb forty lines away
      // says nothing about this particular date.
      const context = text.slice(Math.max(0, index - 90), Math.min(text.length, index + 90));

      if (HISTORICAL.test(context)) continue;

      const forward = FORWARD_LOOKING.test(context);
      const dated = SEASON_OR_MONTH.test(context) && year >= currentYear - SEASONAL_LOOKBACK_YEARS;
      if (!forward && !dated) continue;

      record(
        String(year),
        excerptAround(text, index, m[0].length),
        forward
          ? `Reads as upcoming but is dated ${year} — check whether this is out of date`
          : `Mentions ${year} alongside a season or month — check whether this should be ${currentYear}`,
        forward ? 'medium' : 'low',
        block.pages,
        forward ? 'forward' : 'seasonal',
      );
    }
  }

  const rank: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };
  return [...byKey.values()]
    .sort((a, b) => rank[a.confidence] - rank[b.confidence] || b.pages.length - a.pages.length)
    .slice(0, limit);
}
