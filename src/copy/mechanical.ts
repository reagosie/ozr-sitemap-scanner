import { retext } from 'retext';
import retextRepeatedWords from 'retext-repeated-words';
import retextIndefiniteArticle from 'retext-indefinite-article';
import retextQuotes from 'retext-quotes';
import retextSentenceSpacing from 'retext-sentence-spacing';
import { excerptAround, findingId, type Corpus } from './extract.js';
import type { Confidence, CopyFinding } from './types.js';

/**
 * How much to trust each rule.
 *
 * The first two are mechanical facts -- "the the" is wrong in every register.
 * The last two are house style, and on a site edited by several people over
 * years they fire constantly without anything being broken, so they are ranked
 * below the real defects rather than left out (a reviewer may still want them).
 */
const CONFIDENCE_BY_SOURCE: Record<string, Confidence> = {
  'retext-repeated-words': 'high',
  'retext-indefinite-article': 'high',
  'retext-sentence-spacing': 'low',
  'retext-quotes': 'low',
};

/**
 * Match the site's own quote style rather than imposing one.
 *
 * retext-quotes defaults to preferring typographic quotes, which on a site that
 * consistently uses straight ones would flag every apostrophe on every page.
 * Counting first turns the rule from "you disagree with the default" into
 * "this page disagrees with the rest of your site", which is the only version
 * worth reporting.
 */
export function dominantQuoteStyle(corpus: Corpus): 'smart' | 'straight' {
  let smart = 0;
  let straight = 0;
  for (const block of corpus.blocks) {
    for (const ch of block.text) {
      if (ch === '\u2018' || ch === '\u2019' || ch === '\u201C' || ch === '\u201D') smart++;
      else if (ch === "'" || ch === '"') straight++;
    }
  }
  return smart > straight ? 'smart' : 'straight';
}

/**
 * Rules whose findings become meaningless once they are everywhere.
 *
 * A straight apostrophe on all 45 pages is not 45 defects, it is the site's
 * punctuation. Reporting it puts four unfixable rows at the top of a section
 * that has to stay worth reading. The genuinely mechanical rules -- repeated
 * words, wrong article -- are never suppressed, however widespread: those are
 * wrong at any scale.
 */
const STYLISTIC_SOURCES = new Set(['retext-quotes', 'retext-sentence-spacing']);

/** Above this share of pages, a stylistic rule describes the house style. */
const HOUSE_STYLE_SHARE = 0.25;

export async function checkMechanical(corpus: Corpus): Promise<CopyFinding[]> {
  const preferred = dominantQuoteStyle(corpus);

  const processor = retext()
    .use(retextRepeatedWords)
    .use(retextIndefiniteArticle)
    .use(retextQuotes, { preferred })
    .use(retextSentenceSpacing);

  // Keyed so an identical defect in two different blocks (a repeated heading,
  // say) reports once with both blocks' pages rather than twice.
  const byKey = new Map<string, CopyFinding>();
  /** Which retext rule produced each finding, for the house-style filter below. */
  const sourceOf = new Map<string, string>();

  for (const block of corpus.blocks) {
    const file = await processor.process(block.text);

    for (const msg of file.messages) {
      const actual = msg.actual ?? '';
      const source = msg.source ?? 'retext';
      const offset = msg.place && 'start' in msg.place ? msg.place.start.offset ?? 0 : 0;

      const key = `${source}|${actual}|${msg.reason}`;
      const existing = byKey.get(key);
      if (existing) {
        for (const p of block.pages) {
          if (!existing.pages.includes(p)) existing.pages.push(p);
        }
        continue;
      }

      const id = findingId('mechanical', actual, `${source}|${msg.reason}`);
      sourceOf.set(id, source);
      byKey.set(key, {
        id,
        category: 'mechanical',
        message: msg.reason,
        match: actual,
        excerpt: excerptAround(block.text, offset, actual.length),
        suggestions: (msg.expected ?? []).filter((s): s is string => typeof s === 'string').slice(0, 3),
        confidence: CONFIDENCE_BY_SOURCE[source] ?? 'medium',
        pages: [...block.pages],
      });
    }
  }

  const houseStyleCutoff = Math.max(3, corpus.totalPages * HOUSE_STYLE_SHARE);
  return [...byKey.values()].filter((f) => {
    const stylistic = STYLISTIC_SOURCES.has(sourceOf.get(f.id) ?? '');
    return !(stylistic && f.pages.length >= houseStyleCutoff);
  });
}
