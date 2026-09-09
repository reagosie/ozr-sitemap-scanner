export type CopyCategory = 'spelling' | 'grammar' | 'mechanical' | 'consistency' | 'date';

/**
 * How sure the checker is, which drives sort order in the report.
 *
 * `high` means a rule fired with no judgement involved (a doubled word). `low`
 * means the finding is a candidate for a human to rule on, not a defect --
 * the stale-date check produces these by design. Mixing the two without a label
 * is how a findings list stops being read.
 */
export type Confidence = 'high' | 'medium' | 'low';

export interface CopyFinding {
  /**
   * Stable across runs, so a dismissal in copy-accepted.json keeps working.
   * Derived from category + the offending text, never from page URLs or
   * position -- both of which move for reasons that have nothing to do with the
   * finding.
   */
  id: string;
  category: CopyCategory;
  /** What is wrong, in a reviewer's words. */
  message: string;
  /** The offending fragment itself. */
  match: string;
  /** Surrounding sentence, so the reviewer can judge without opening the page. */
  excerpt: string;
  suggestions: string[];
  confidence: Confidence;
  /** Every page carrying this text. A footer typo is one finding, not 157. */
  pages: string[];
}

export interface CopyReport {
  findings: CopyFinding[];
  /** Distinct text blocks checked. */
  blocksChecked: number;
  /** Pages contributing text. */
  pagesChecked: number;
  wordsChecked: number;
  /** Findings suppressed by copy-accepted.json. */
  dismissed: number;
  /** Checks that did not run, with the reason -- surfaced in the report. */
  skipped: { check: string; reason: string }[];
  counts: Record<CopyCategory, number>;
}
