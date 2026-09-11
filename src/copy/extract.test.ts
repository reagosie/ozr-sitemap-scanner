/**
 * Tests for text extraction, and above all for stripMarkup.
 *
 * Run: npx tsx src/copy/extract.test.ts
 */
import { buildCorpus, maskNonProse, stripMarkup } from './extract.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
}
function eq(name: string, got: string, want: string): void {
  check(name, got === want, got === want ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// --- the case that caused this: a <noscript> image tag read as prose ---------
const NOSCRIPT_IMG =
  '<img width="800" height="800" src="https://ozarkleadershipinstitute.com/wp-content/uploads/' +
  '2020/10/Primary-Logo-1024x1024.png" class="attachment-large" alt="" decoding="async" ' +
  'sizes="(max-width: 800px) 100vw, 800px" />';

eq('a bare image tag leaves nothing behind', stripMarkup(NOSCRIPT_IMG), '');
check('"async" no longer survives extraction', !stripMarkup(NOSCRIPT_IMG).includes('async'));
check('the image URL no longer survives', !stripMarkup(NOSCRIPT_IMG).includes('ozarkleadershipinstitute'));

// --- markup mixed with real copy keeps the copy ------------------------------
eq(
  'real words around a tag are kept',
  stripMarkup('Register today <img src="a.png"> for summer camp'),
  'Register today for summer camp',
);
eq(
  'a closing tag goes too',
  stripMarkup('Sign up</a> now'),
  'Sign up now',
);
eq(
  'a tag cut off at the end of a block goes',
  stripMarkup('Read more <a href="https://example.com/very/long'),
  'Read more',
);
eq('an HTML comment goes', stripMarkup('Before <!-- a note --> after'), 'Before after');

// --- prose that merely LOOKS like markup must survive untouched --------------
// The rule is a letter, ! or / straight after the bracket. Comparisons have a
// space or a digit there, so they are never mistaken for a tag.
eq('a less-than comparison survives', stripMarkup('ages 8 < 12 are welcome'), 'ages 8 < 12 are welcome');
eq('a greater-than comparison survives', stripMarkup('a > b and b > c'), 'a > b and b > c');
eq('an arrow survives', stripMarkup('Camp -> Home'), 'Camp -> Home');
eq('ordinary copy is returned unchanged', stripMarkup('Summer camp in the Ouachitas.'), 'Summer camp in the Ouachitas.');

// --- line breaks are block boundaries and must not be collapsed --------------
// screenshot.ts splits on the line breaks innerText inserts, and welding them
// together invents defects: "Ready Set Camp\nCamp Prep Guide" became a repeated
// word on 516 pages.
eq('newlines are preserved', stripMarkup('Ready Set Camp\nCamp Prep Guide'), 'Ready Set Camp\nCamp Prep Guide');
eq('runs of spaces collapse', stripMarkup('too    many   spaces'), 'too many spaces');

// --- maskNonProse: web addresses are not prose -------------------------------
// Masking keeps the string's LENGTH, so offsets into the original still line up.
function gone(name: string, text: string, needle: string): void {
  const out = maskNonProse(text);
  check(
    name,
    !out.toLowerCase().includes(needle.toLowerCase()) && out.length === text.length,
    JSON.stringify(out),
  );
}
function kept(name: string, text: string): void {
  eq(name, maskNonProse(text), text);
}

gone('a full URL is masked', 'See https://campozark.com/apply now', 'campozark');
gone('a www address is masked', 'See www.campozark.com now', 'campozark');
gone('an email is masked', 'Write to staff@campotx.com today', 'campotx');
gone('a BARE domain is masked', 'campozark.com', 'campozark');
gone('a bare domain inside a sentence is masked', 'Visit campozark.com for details', 'campozark');
gone('a subdomain is masked', 'go to shop.campwareagle.org today', 'campwareagle');

kept('ordinary prose is untouched', 'Camp Ozark is in Mount Ida, Arkansas.');
kept('a sentence ending in a known word is untouched', 'We love camp. Organized fun.');
kept('an image file name is not a domain', 'the file logo.png is fine');
kept('a decimal number is untouched', 'it costs 1.50 per day');

// --- and the corpus actually applies it --------------------------------------
const corpus = buildCorpus([
  { loc: 'https://example.com/a', textBlocks: [{ tag: 'a', text: NOSCRIPT_IMG }, { tag: 'p', text: 'Real copy here.' }] },
  { loc: 'https://example.com/b', textBlocks: [{ tag: 'a', text: NOSCRIPT_IMG }] },
]);
check(
  'a block that is nothing but markup is dropped from the corpus',
  corpus.blocks.length === 1 && corpus.blocks[0]!.text === 'Real copy here.',
  corpus.blocks.map((b) => b.text).join(' | '),
);
check('"async" never reaches the word census', !corpus.wordPages.has('async'));
check('the page with only markup still counts as a page', corpus.totalPages === 2, String(corpus.totalPages));

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exitCode = failures ? 1 : 0;
