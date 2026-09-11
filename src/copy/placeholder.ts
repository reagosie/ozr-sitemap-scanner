import { findingId, type Corpus, type CorpusBlock } from './extract.js';
import type { CopyFinding } from './types.js';

/**
 * Latin words that only ever appear in Lorem Ipsum filler.
 *
 * Every one is absent from an English dictionary and absent from real English
 * copy, which is what makes them safe to match on. Common Latin that does turn
 * up in English -- "et", "ad", "sed", "in", "id", "eu", "sit", "dolor" -- is
 * left out, so a page is never accused of being filler because it says "ad hoc".
 */
const LOREM_MARKERS = new Set([
  'lorem', 'ipsum', 'consectetur', 'adipiscing', 'eiusmod', 'tempor',
  'incididunt', 'labore', 'aliqua', 'enim', 'veniam', 'nostrud',
  'exercitation', 'ullamco', 'laboris', 'aliquip', 'commodo', 'consequat',
  'aute', 'irure', 'reprehenderit', 'voluptate', 'velit', 'cillum',
  'fugiat', 'pariatur', 'excepteur', 'occaecat', 'cupidatat', 'proident',
  'culpa', 'officia', 'deserunt', 'mollit', 'laborum', 'quis', 'nulla',
  'dolore', 'magna', 'minim', 'esse', 'sint', 'anim',
]);

/**
 * How many DISTINCT marker words make a block filler rather than a coincidence.
 *
 * Three, because two can happen by accident -- a page about a rock band called
 * Nulla, a staff member named Magna. Real Lorem Ipsum carries a dozen or more,
 * so this is never a close call in practice.
 */
const MARKER_THRESHOLD = 3;

/**
 * English filler, matched as whole phrases.
 *
 * Kept deliberately literal. "Coming soon" and "More information to follow" are
 * NOT here: those are real things a real page says on purpose.
 */
const FILLER_PHRASES = [
  'insert your text here',
  'insert text here',
  'your text goes here',
  'your text here',
  'add your text here',
  'this is placeholder text',
  'placeholder text',
  'sample text here',
  'replace this text',
  'edit this text',
];

export function isPlaceholderText(text: string): boolean {
  const lower = text.toLowerCase();
  if (FILLER_PHRASES.some((p) => lower.includes(p))) return true;

  const found = new Set<string>();
  for (const w of lower.match(/[a-z]+/g) ?? []) {
    if (LOREM_MARKERS.has(w)) found.add(w);
    if (found.size >= MARKER_THRESHOLD) return true;
  }
  return false;
}

export interface PlaceholderResult {
  findings: CopyFinding[];
  /** Hashes of blocks that are filler, so the other checks can skip them. */
  placeholderHashes: Set<string>;
}

/**
 * Find pages still carrying unfinished placeholder text.
 *
 * This is one finding, not twenty-six.
 *
 * campozark.com/safety/leadership-staff/ has a full paragraph of Lorem Ipsum
 * live on the site. The spellchecker did notice -- as twenty-six separate
 * "ipsum is not a known word" rows, which is 45% of the site's entire spelling
 * section and tells the reader nothing. Reported once, with the page named, it
 * is arguably the most actionable thing in the whole report: a page that was
 * never finished, published, and sitting in the SAFETY section.
 *
 * The blocks are also handed back so spelling and grammar can skip them. There
 * is nothing useful to say about the grammar of filler Latin.
 */
export function checkPlaceholder(corpus: Corpus): PlaceholderResult {
  const findings: CopyFinding[] = [];
  const placeholderHashes = new Set<string>();
  /** One finding per page-set, so a filler block repeated site-wide is one row. */
  const byPages = new Map<string, CorpusBlock[]>();

  for (const block of corpus.blocks) {
    if (!isPlaceholderText(block.text)) continue;
    placeholderHashes.add(block.hash);
    const key = [...block.pages].sort().join('\n');
    const bucket = byPages.get(key);
    if (bucket) bucket.push(block);
    else byPages.set(key, [block]);
  }

  for (const blocks of byPages.values()) {
    const first = blocks[0]!;
    const words = blocks.reduce((n, b) => n + (b.text.match(/\S+/g)?.length ?? 0), 0);
    findings.push({
      id: findingId('placeholder', first.text.slice(0, 60), 'placeholder'),
      category: 'placeholder',
      message:
        blocks.length === 1
          ? `Unfinished placeholder text is published here (${words} words).`
          : `Unfinished placeholder text is published here, in ${blocks.length} places (${words} words in total).`,
      match: first.text.slice(0, 60).trim(),
      excerpt: first.text.slice(0, 200).trim() + (first.text.length > 200 ? '…' : ''),
      suggestions: [],
      confidence: 'high',
      pages: [...first.pages],
    });
  }

  return { findings, placeholderHashes };
}
