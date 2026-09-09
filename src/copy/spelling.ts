import nspell from 'nspell';
import dictionary from 'dictionary-en';
import {
  excerptAround,
  findingId,
  maskNonProse,
  normalizeWord,
  words,
  type Corpus,
} from './extract.js';
import type { CopyFinding } from './types.js';

export interface SpellOptions {
  /** A word on at least this many distinct pages is site vocabulary. */
  siteWordMinPages: number;
  /** Extra allowlist entries from config. */
  glossary: string[];
}

/**
 * Running `suggest` is expensive -- it generates and scores edit candidates --
 * so it is reserved for the words most likely to be real typos (the rarest),
 * and capped. Beyond this the finding is still reported, just without
 * suggestions.
 */
const SUGGEST_BUDGET = 500;

/** Below this length, "typos" are overwhelmingly abbreviations and initials. */
const MIN_WORD_LENGTH = 3;

/**
 * Spellcheck against the dictionary AND the site's own vocabulary.
 *
 * A stock dictionary is unusable here: it does not know "Ozark", "Mena", "Gaga",
 * or any staff name, and a report that flags those 500 times is a report nobody
 * opens again. The fix is to treat the corpus as evidence -- a word that appears
 * on many distinct pages was written deliberately, whatever the dictionary
 * thinks, while a word appearing once and nowhere else is what a typo looks
 * like.
 *
 * This is the same principle as classifying 403 as `blocked` rather than
 * `broken`: prefer under-reporting to crying wolf, because a checker is only
 * worth having if its output gets read.
 */
export interface Speller {
  correct(word: string): boolean;
  suggest(word: string): string[];
}

/**
 * Load the Hunspell dictionary once.
 *
 * Both the spelling and consistency checks need it, and parsing the affix and
 * dictionary files is the slowest part of either.
 */
export async function loadSpeller(): Promise<Speller> {
  return nspell({
    aff: Buffer.from(dictionary.aff),
    dic: Buffer.from(dictionary.dic),
  });
}

export async function checkSpelling(
  corpus: Corpus,
  opts: SpellOptions,
  spell: Speller,
): Promise<CopyFinding[]> {
  // Scale the threshold to the corpus.
  //
  // "On at least 5 pages" is the right bar for campozark's 524, but on a 6-page
  // site it means "on most of the site", so almost nothing qualifies and the
  // corpus stops acting as a dictionary at all. Five percent of the site, floored
  // at two pages, keeps the rule meaning the same thing at both scales: appeared
  // deliberately, more than once.
  const minPages = Math.max(
    2,
    Math.min(opts.siteWordMinPages, Math.ceil(corpus.totalPages * 0.05)),
  );

  const allowed = new Set<string>();
  for (const [word, pages] of corpus.wordPages) {
    if (pages >= minPages) allowed.add(word);
  }
  // Glossary entries may be phrases ("Camp Ozark"); every word in them counts.
  for (const entry of opts.glossary) {
    for (const w of words(entry)) allowed.add(normalizeWord(w).toLowerCase());
  }

  interface Candidate {
    word: string;
    display: string;
    pages: Set<string>;
    excerpt: string;
  }
  const candidates = new Map<string, Candidate>();

  for (const block of corpus.blocks) {
    // Offsets are preserved by the mask, so excerpts still come from the real
    // text while email local parts and URLs are invisible to the scanner.
    const scannable = maskNonProse(block.text);

    for (const match of scannable.matchAll(/[A-Za-z][A-Za-z'’-]*/g)) {
      const raw = match[0];
      const display = normalizeWord(raw);
      const lower = display.toLowerCase();
      const at = match.index ?? 0;

      if (display.length < MIN_WORD_LENGTH) continue;
      if (allowed.has(lower)) continue;
      // ALLCAPS is an acronym -- or a heading the CSS uppercased, since
      // innerText reflects text-transform. Internal capitals are a brand or a
      // code ("WordPress", "McDonald"). Neither is a spelling error.
      if (display === display.toUpperCase()) continue;
      if (/[A-Z]/.test(display.slice(1))) continue;

      // A capitalized word in the MIDDLE of a sentence is a name, not a typo.
      //
      // Measured on campozarkfoundation staff bios: without this, twelve of
      // seventeen "high confidence" findings were surnames -- Hoercher, Baggett,
      // Weatherford -- each helpfully offered a real word one edit away. The
      // corpus-frequency rule cannot save these, because a name that appears on
      // one bio page appears on exactly one page no matter how large the site
      // is. Capitalization is the signal that actually separates them.
      const capitalized = display[0] === display[0]?.toUpperCase();
      if (capitalized && !isSentenceInitial(block.text, at)) continue;

      // Capitalized every single time it appears anywhere on the site.
      //
      // The mid-sentence rule above misses names that only ever occur at the
      // start of a block -- list items, headings, a column of university names --
      // where every occurrence looks sentence-initial. Corpus-wide casing
      // settles it: prose would have used "ouachita" somewhere; a name never does.
      if (capitalized && !corpus.lowercaseSeen.has(lower)) continue;

      if (spell.correct(display) || spell.correct(lower)) continue;
      // "non-profit", "life-changing", "two-year": the dictionary has no entry
      // for the compound but knows every part, so checking the parts is what a
      // reader would do.
      if (compoundIsSpelled(display, spell, allowed)) continue;

      const existing = candidates.get(lower);
      if (existing) {
        for (const p of block.pages) existing.pages.add(p);
      } else {
        candidates.set(lower, {
          word: lower,
          display,
          pages: new Set(block.pages),
          excerpt: excerptAround(block.text, match.index ?? 0, raw.length),
        });
      }
    }
  }

  // Rarest first: a word on one page is a far better typo candidate than one on
  // twenty, and this is also the order the suggestion budget should be spent in.
  const ordered = [...candidates.values()].sort(
    (a, b) => a.pages.size - b.pages.size || a.word.localeCompare(b.word),
  );

  const findings: CopyFinding[] = [];
  let suggestsUsed = 0;

  for (const c of ordered) {
    let suggestions: string[] = [];
    if (suggestsUsed < SUGGEST_BUDGET) {
      suggestions = spell.suggest(c.display).slice(0, 3);
      suggestsUsed++;
    }

    const nearest = suggestions[0];
    const distance = nearest ? editDistance(c.word, nearest.toLowerCase()) : Infinity;

    // One or two keystrokes away from a real word, on a single page, is as close
    // to certain as this check gets without understanding the sentence.
    const confidence =
      c.pages.size <= 2 && distance <= 2 ? 'high' : suggestions.length ? 'medium' : 'low';

    findings.push({
      id: findingId('spelling', c.word, ''),
      category: 'spelling',
      message: suggestions.length
        ? `"${c.display}" is not a known word - did you mean ${suggestions.map((s) => `"${s}"`).join(', ')}?`
        : `"${c.display}" is not a known word and has no close match. Likely a name or term - add it to the site glossary if so.`,
      match: c.display,
      excerpt: c.excerpt,
      suggestions,
      confidence,
      pages: [...c.pages],
    });
  }

  return findings;
}

/**
 * True when nothing but sentence-ending punctuation precedes this position.
 *
 * Also treats a bullet or dash as sentence-initial: list items and headings are
 * capitalized the same way sentences are.
 */
function isSentenceInitial(text: string, index: number): boolean {
  const before = text.slice(0, index).trimEnd();
  return before === '' || /[.!?:;•\-–—"'“‘(]$/.test(before);
}

/**
 * Treat a hyphenated compound as spelled when every part is.
 *
 * Requires at least two real parts so a stray hyphen does not launder a typo,
 * and accepts site vocabulary as a part so "Ozark-wide" passes once "Ozark" has
 * earned its place in the corpus.
 */
function compoundIsSpelled(
  word: string,
  spell: { correct(w: string): boolean },
  allowed: Set<string>,
): boolean {
  if (!word.includes('-')) return false;
  const parts = word.split('-').filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every(
    (p) => p.length < 2 || spell.correct(p) || spell.correct(p.toLowerCase()) || allowed.has(p.toLowerCase()),
  );
}

/**
 * Levenshtein distance, bounded by a two-row buffer.
 *
 * Only used to rank a candidate against its best suggestion, so the full matrix
 * would be wasted allocation across thousands of calls.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length] ?? 0;
}
