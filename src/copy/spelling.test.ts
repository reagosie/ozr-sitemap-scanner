/**
 * Regression battery for the spellchecker's acceptance rules.
 *
 * Every rule that accepts a word without the dictionary's say-so -- inflection,
 * hyphenation, closed compounds, prefixes, particles -- is a rule that could
 * also accept a typo. This pins both directions: the words a real run wrongly
 * flagged must pass, and a battery of ordinary misspellings must still fail.
 *
 * Run: npx tsx src/copy/spelling.test.ts
 */
import { buildCorpus } from './extract.js';
import { checkSpelling, loadSpeller } from './spelling.js';

/** Reported as misspellings on the campotx run. All are real words. */
const MUST_ACCEPT = [
  'cancelled', 'amongst', 'organise', 'colour', 'favourite', 'traveller', 'learnt',
  'trainings', 'verifications', 'wearables',
  'whole-heartedly', 'pre-order', 'check-in', 'all-inclusive', 'non-refundable',
  'woodshop', 'bunkhouse', 'wristband', 'handcrafted', 'drinkware', 'sunscreen',
  'checkin', 'checkout', 'signup', 'dropoff',
  'untethered', 'rebooked', 'injectable', 'transformative', 'cheerleading',
  'uploaded', 'emailed', 'texted',
];

/** Ordinary misspellings. Every one must survive every acceptance rule. */
const MUST_FLAG = [
  'teh', 'adn', 'recieve', 'seperate', 'occurence', 'definately', 'accomodate',
  'wich', 'thier', 'becuase', 'tommorow', 'embarass', 'maintainance',
  'independant', 'neccessary', 'arguement', 'goverment', 'enviroment', 'rythm',
  'calender', 'swiming', 'runing', 'begining', 'writting', 'sucessful',
  'commited', 'stoping', 'refered', 'occured', 'existance',
];

async function main() {
  // One word per page: a word on two or more pages is treated as deliberate
  // site vocabulary, which would allowlist the typos and prove nothing.
  const pages = [...MUST_ACCEPT, ...MUST_FLAG].map((w, i) => ({
    loc: `https://example.com/p${i}`,
    textBlocks: [{ tag: 'p', text: `the campers said ${w} during the afternoon activity period` }],
  }));

  const corpus = buildCorpus(pages);
  const spell = await loadSpeller();
  const findings = await checkSpelling(corpus, { siteWordMinPages: 5, glossary: [] }, spell);
  const flagged = new Set(findings.map((f) => f.match.toLowerCase()));

  const wronglyFlagged = MUST_ACCEPT.filter((w) => flagged.has(w.toLowerCase()));
  const missed = MUST_FLAG.filter((w) => !flagged.has(w.toLowerCase()));

  console.log(`accepted ${MUST_ACCEPT.length - wronglyFlagged.length}/${MUST_ACCEPT.length} real words`);
  console.log(`caught   ${MUST_FLAG.length - missed.length}/${MUST_FLAG.length} misspellings`);
  if (wronglyFlagged.length) console.log(`\nFALSE POSITIVES: ${wronglyFlagged.join(', ')}`);
  if (missed.length) console.log(`MISSED TYPOS:    ${missed.join(', ')}`);

  const ok = !wronglyFlagged.length && !missed.length;
  console.log(`\n${ok ? 'PASS' : 'FAIL'}`);
  process.exitCode = ok ? 0 : 1;
}
main();
