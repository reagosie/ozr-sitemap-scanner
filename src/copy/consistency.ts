import { excerptAround, findingId, type Corpus } from './extract.js';
import type { CopyFinding } from './types.js';

export interface ConsistencyOptions {
  /** Forms the site has declared correct; any other spelling is the variant. */
  canonicalNames: string[];
  /** A name must appear on at least this many pages to be worth policing. */
  minPages: number;
  /**
   * Dictionary lookup, used to tell names from ordinary words.
   *
   * Without it this check reports "Learn More" against "LEARN MORE" and "these"
   * against "These" -- capitalization noise from buttons and sentence starts,
   * which was 19 of 21 findings on a first pass against campozark. A phrase is
   * only a NAME if some part of it is not a word the dictionary knows.
   */
  isDictionaryWord: (word: string) => boolean;
}

/** Longest name phrase considered, in words. */
const MAX_NGRAM = 3;

/**
 * A variant must be this much rarer than the dominant form to be reported.
 *
 * Two spellings in genuine parallel use (a rename mid-flight, two real product
 * names) are a decision for a human to make deliberately, not a defect. What
 * this check is for is the single stray "camp ozark" among four hundred correct
 * ones.
 */
const VARIANT_RATIO = 0.25;

interface Surface {
  pages: Set<string>;
  excerpt: string;
}

const keyOf = (phrase: string): string => phrase.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Find brand and proper-noun spellings that disagree across the site.
 *
 * This check exists because it is the one a human reviewer structurally cannot
 * do: catching that "Camp Ozark" is written four hundred times and "camp ozark"
 * twice requires seeing every page at once. Reading pages one at a time, both
 * look fine.
 *
 * It is also why frequency beats a rule list -- nobody has to write down what
 * the site's proper nouns are. The corpus says.
 */
export function checkConsistency(corpus: Corpus, opts: ConsistencyOptions): CopyFinding[] {
  // Pass 1: which phrases are names at all?
  //
  // Capitalization alone is not enough -- every sentence starts with a capital
  // and every button is title-cased. A phrase qualifies only if at least one of
  // its words is absent from the dictionary, which is what "Camp Ozark" has and
  // "Contact Us" does not.
  const nameKeys = new Set<string>();
  for (const block of corpus.blocks) {
    for (const m of block.text.matchAll(
      /\b[A-Z][A-Za-z'’]*(?:[ \-][A-Z][A-Za-z'’]*){0,2}\b/g,
    )) {
      const phrase = m[0];
      const key = keyOf(phrase);
      if (key.length < 4) continue;

      const parts = phrase.split(/[ \-]+/).filter(Boolean);
      const hasProperNoun = parts.some(
        (p) => p.length > 2 && !opts.isDictionaryWord(p.toLowerCase()),
      );
      if (hasProperNoun) nameKeys.add(key);
    }
  }
  for (const name of opts.canonicalNames) nameKeys.add(keyOf(name));

  // Pass 2: every surface form of those names, however it was written.
  // Bounded by nameKeys, so this stays cheap no matter how large the corpus is.
  const forms = new Map<string, Map<string, Surface>>();

  for (const block of corpus.blocks) {
    const tokens = [...block.text.matchAll(/[A-Za-z0-9'’]+/g)];

    for (let i = 0; i < tokens.length; i++) {
      for (let n = 1; n <= MAX_NGRAM && i + n <= tokens.length; n++) {
        const first = tokens[i];
        const last = tokens[i + n - 1];
        if (!first || !last) continue;

        const start = first.index ?? 0;
        const end = (last.index ?? 0) + last[0].length;
        const phrase = block.text.slice(start, end);
        // Reject spans that ran across punctuation, which are not one name.
        if (/[.,;:!?()"]/.test(phrase)) continue;

        const key = keyOf(phrase);
        if (key.length < 4 || !nameKeys.has(key)) continue;

        let bucket = forms.get(key);
        if (!bucket) forms.set(key, (bucket = new Map()));

        const seen = bucket.get(phrase);
        if (seen) {
          for (const p of block.pages) seen.pages.add(p);
        } else {
          bucket.set(phrase, {
            pages: new Set(block.pages),
            excerpt: excerptAround(block.text, start, phrase.length),
          });
        }
      }
    }
  }

  const canonicalByKey = new Map(opts.canonicalNames.map((n) => [keyOf(n), n]));
  const findings: CopyFinding[] = [];

  for (const [key, bucket] of forms) {
    if (bucket.size < 2) continue;

    const ranked = [...bucket.entries()].sort((a, b) => b[1].pages.size - a[1].pages.size);
    const configured = canonicalByKey.get(key);
    const dominantEntry = configured
      ? (ranked.find(([form]) => form === configured) ?? ranked[0])
      : ranked[0];
    if (!dominantEntry) continue;

    const [dominant, dominantInfo] = dominantEntry;
    if (!configured && dominantInfo.pages.size < opts.minPages) continue;

    for (const [form, info] of ranked) {
      if (form === dominant) continue;
      if (!configured && info.pages.size > dominantInfo.pages.size * VARIANT_RATIO) continue;

      // The FIRST letter's case is never a naming decision.
      //
      // It is set by sentence position and by title casing: "the incomparable
      // Camp Ozark" mid-paragraph and "The Incomparable Camp Ozark" as a heading
      // are both correct, and neither is evidence about the other. Only casing
      // from the second character on says anything about how the site spells a
      // name, so a pair differing solely in that first letter is not a finding
      // in either direction.
      const onlyFirstLetterDiffers =
        form.length === dominant.length &&
        form.slice(1) === dominant.slice(1) &&
        form[0]?.toLowerCase() === dominant[0]?.toLowerCase();
      if (onlyFirstLetterDiffers) continue;

      // ALL CAPS is styling, not spelling. `innerText` reflects CSS
      // text-transform, so an uppercase heading reaches this check looking like
      // someone typed "OZARK" -- reporting it would send a reviewer hunting for
      // a text change that lives in a stylesheet.
      // ALL CAPS on either side is styling, not spelling. `innerText` reflects
      // CSS text-transform, so an uppercased button reaches this check looking
      // like someone typed "LEARN MORE" -- and it is just as wrong to report the
      // uppercase form as the variant as it is to report the normal one.
      // Reporting either sends a reviewer hunting for a text change that lives
      // in a stylesheet.
      const shouts = (s: string): boolean => s === s.toUpperCase() && /[A-Z]{2}/.test(s);
      if (shouts(form) !== shouts(dominant)) continue;

      findings.push({
        id: findingId('consistency', form, dominant),
        category: 'consistency',
        message:
          `"${form}" appears on ${info.pages.size} page(s), but this site writes it ` +
          `"${dominant}" on ${dominantInfo.pages.size}` +
          (configured ? ' (the configured spelling)' : ''),
        match: form,
        excerpt: info.excerpt,
        suggestions: [dominant],
        confidence: configured || info.pages.size === 1 ? 'high' : 'medium',
        pages: [...info.pages],
      });
    }
  }

  return findings;
}
