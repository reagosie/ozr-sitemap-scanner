/**
 * Tests for finding unfinished placeholder text.
 *
 * The case that caused this: campozark.com/safety/leadership-staff/ has a live
 * paragraph of Lorem Ipsum. The spellchecker reported it as twenty-six separate
 * misspellings, which is 45% of that site's whole spelling section and tells
 * the reader nothing about the actual problem.
 *
 * Run: npx tsx src/copy/placeholder.test.ts
 */
import { buildCorpus } from './extract.js';
import { checkPlaceholder, isPlaceholderText } from './placeholder.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
}

const LOREM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud ' +
  'exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.';

// --- it must fire on real filler --------------------------------------------
check('the classic Lorem Ipsum paragraph is caught', isPlaceholderText(LOREM));
check('a short fragment is still caught', isPlaceholderText('Lorem ipsum dolor sit amet, consectetur.'));
check('filler with different capitalisation is caught', isPlaceholderText('LOREM IPSUM DOLOR SIT AMET CONSECTETUR ADIPISCING'));
check('an English filler phrase is caught', isPlaceholderText('Insert your text here'));
check('another English filler phrase is caught', isPlaceholderText('Replace this text with your own content.'));

// --- and stay quiet on everything a camp website actually says ---------------
// These are the ones that would destroy trust in the check. Latin that turns up
// in ordinary English is deliberately not in the marker list.
const REAL = [
  'Camp Ozark is one of the largest single-site Christian sports and adventure camps.',
  'Sessions run ad hoc through the summer, and per se there is no minimum stay.',
  'Our staff are vetted in situ and de facto supervised at all times.',
  'The Magna Carta unit meets at the dining hall.',
  'Registration opens January 5. More information to follow.',
  'This page is coming soon.',
  'A sample text message will be sent to the number on file.',
  'Please add your child to the waiting list.',
];
for (const text of REAL) {
  check(`real copy is not called filler: "${text.slice(0, 42)}..."`, !isPlaceholderText(text));
}

// Two markers is a coincidence; three is filler. This is the boundary.
check('two marker words alone are NOT filler', !isPlaceholderText('The band Nulla played at Magna Hall.'));
check('three marker words ARE filler', isPlaceholderText('nulla magna veniam'));

// --- one finding per page, not one per Latin word ----------------------------
const corpus = buildCorpus([
  {
    loc: 'https://campozark.com/safety/leadership-staff/',
    textBlocks: [
      { tag: 'p', text: LOREM },
      { tag: 'h1', text: 'Leadership Staff' },
    ],
  },
]);
const { findings, placeholderHashes } = checkPlaceholder(corpus);

check('exactly one finding for one filler paragraph', findings.length === 1, String(findings.length));
check('it is filed under placeholder', findings[0]?.category === 'placeholder');
check('it is high confidence', findings[0]?.confidence === 'high');
check('it names the page', findings[0]?.pages[0] === 'https://campozark.com/safety/leadership-staff/');
check('it counts the words', /\d+ words/.test(findings[0]?.message ?? ''), findings[0]?.message);
check('one block is withheld from the other checks', placeholderHashes.size === 1, String(placeholderHashes.size));
check(
  'the real heading on the same page is NOT withheld',
  corpus.blocks.filter((b) => !placeholderHashes.has(b.hash)).some((b) => b.text === 'Leadership Staff'),
);

// A footer's worth of filler repeated site-wide is still one row.
const sitewide = buildCorpus(
  ['a', 'b', 'c'].map((n) => ({
    loc: `https://example.com/${n}`,
    textBlocks: [{ tag: 'p', text: LOREM }],
  })),
);
const many = checkPlaceholder(sitewide);
check('filler on three pages is one finding', many.findings.length === 1, String(many.findings.length));
check('and it lists all three pages', many.findings[0]?.pages.length === 3, String(many.findings[0]?.pages.length));

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exitCode = failures ? 1 : 0;
