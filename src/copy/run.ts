import { buildCorpus, type Corpus, type PageText } from './extract.js';
import { checkMechanical } from './mechanical.js';
import { checkPlaceholder } from './placeholder.js';
import { checkSpelling, loadSpeller } from './spelling.js';
import { checkConsistency } from './consistency.js';
import { checkDates } from './dates.js';
import { checkGrammar } from './languagetool.js';
import type { CopyCategory, CopyFinding, CopyReport, Confidence } from './types.js';
import { silentReporter, type Reporter } from '../progress.js';

export interface ProofreadOptions {
  siteWordMinPages: number;
  glossary: string[];
  canonicalNames: string[];
  languageTool: boolean;
  languageToolPort: number;
  /** Finding ids the reviewer has already dismissed. */
  accepted: string[];
  reporter?: Reporter;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

const EMPTY_COUNTS: Record<CopyCategory, number> = {
  placeholder: 0,
  spelling: 0,
  grammar: 0,
  mechanical: 0,
  consistency: 0,
  date: 0,
};

/**
 * Run every copy check over the pages captured in this run.
 *
 * Order matters only for the progress output; the checks are independent. The
 * local ones run first and unconditionally, so a machine with no Docker still
 * produces a useful report -- LanguageTool is an upgrade, never a requirement.
 */
export async function proofread(pages: PageText[], opts: ProofreadOptions): Promise<CopyReport> {
  const { reporter = silentReporter } = opts;
  const skipped: { check: string; reason: string }[] = [];

  const corpus = buildCorpus(pages);

  if (!corpus.blocks.length) {
    return {
      findings: [],
      blocksChecked: 0,
      pagesChecked: 0,
      wordsChecked: 0,
      dismissed: 0,
      skipped: [{ check: 'all', reason: 'no page text was captured' }],
      counts: { ...EMPTY_COUNTS },
    };
  }

  reporter.log(
    `    ${corpus.blocks.length} distinct text blocks from ${corpus.totalPages} pages ` +
      `(${corpus.totalWords.toLocaleString()} words)`,
  );

  const findings: CopyFinding[] = [];

  // Placeholder text is found FIRST, and its blocks are then withheld from
  // every other check.
  //
  // campozark.com/safety/leadership-staff/ carries a live paragraph of Lorem
  // Ipsum. Checked as prose it produced twenty-six "ipsum is not a known word"
  // rows -- 45% of that site's whole spelling section -- plus grammar
  // complaints about the Latin. One finding naming the page is worth more than
  // all of it, and there is nothing useful to say about filler's grammar.
  reporter.log('    placeholder text');
  const placeholder = checkPlaceholder(corpus);
  findings.push(...placeholder.findings);

  const prose: Corpus = placeholder.placeholderHashes.size
    ? { ...corpus, blocks: corpus.blocks.filter((b) => !placeholder.placeholderHashes.has(b.hash)) }
    : corpus;
  if (placeholder.placeholderHashes.size) {
    reporter.log(
      `      ${placeholder.placeholderHashes.size} block(s) of filler withheld from the other checks`,
    );
  }

  // One dictionary load, shared: spelling needs it to find errors and
  // consistency needs it to tell a brand name from an ordinary word.
  const spell = await loadSpeller();

  reporter.log('    mechanical');
  findings.push(...(await checkMechanical(prose)));

  reporter.log('    spelling');
  findings.push(
    ...(await checkSpelling(
      prose,
      { siteWordMinPages: opts.siteWordMinPages, glossary: opts.glossary },
      spell,
    )),
  );

  reporter.log('    consistency');
  findings.push(
    ...checkConsistency(prose, {
      canonicalNames: opts.canonicalNames,
      minPages: opts.siteWordMinPages,
      isDictionaryWord: (w) => spell.correct(w),
    }),
  );

  reporter.log('    dates');
  findings.push(...checkDates(prose));

  if (opts.languageTool) {
    reporter.log('    grammar (LanguageTool)');
    const grammar = await checkGrammar(prose, {
      port: opts.languageToolPort,
      autoStart: true,
      reporter,
    });
    findings.push(...grammar.findings);
    if (grammar.skipped) {
      skipped.push({ check: 'grammar', reason: grammar.skipped });
      reporter.log(`    grammar skipped: ${grammar.skipped}`);
    }
  } else {
    skipped.push({ check: 'grammar', reason: 'disabled in config' });
  }

  // Dismissals are permanent. Without this the same false positives resurface
  // every cycle and the section stops being read -- the failure this whole tool
  // is built to avoid.
  const accepted = new Set(opts.accepted);
  const kept = findings.filter((f) => !accepted.has(f.id));
  const dismissed = findings.length - kept.length;

  // Confidence first, then reach: a certain defect on 157 pages is the single
  // most valuable row in the report, and a guess on one page is the least.
  kept.sort(
    (a, b) =>
      CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] ||
      b.pages.length - a.pages.length ||
      a.category.localeCompare(b.category) ||
      a.match.localeCompare(b.match),
  );

  const counts = { ...EMPTY_COUNTS };
  for (const f of kept) counts[f.category]++;

  return {
    findings: kept,
    blocksChecked: corpus.blocks.length,
    pagesChecked: corpus.totalPages,
    wordsChecked: corpus.totalWords,
    dismissed,
    skipped,
    counts,
  };
}
