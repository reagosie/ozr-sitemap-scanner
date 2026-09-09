import { spawn } from 'node:child_process';
import { excerptAround, findingId, type Corpus, type CorpusBlock } from './extract.js';
import type { Confidence, CopyFinding } from './types.js';
import { silentReporter, type Reporter } from '../progress.js';

const CONTAINER = 'sitemap-scanner-languagetool';
const IMAGE = 'erikvl87/languagetool';

/** Text sent per request. Well under LanguageTool's default request ceiling. */
const CHUNK_CHARS = 10_000;

/**
 * LanguageTool ships its own spellchecker, and it does not know this site.
 *
 * Leaving it on would reproduce exactly the "Ozark is not a word" noise that
 * spelling.ts exists to prevent, and would double-report every genuine typo.
 * Grammar is what LanguageTool is here for.
 */
const DISABLED_RULES = 'MORFOLOGIK_RULE_EN_US';

/** Rule categories that duplicate checks retext already does better. */
const DUPLICATE_CATEGORIES = new Set(['TYPOGRAPHY', 'TYPOS']);

/**
 * Confidence from LanguageTool's OWN classification of the rule.
 *
 * The previous rule -- "one replacement offered means high confidence" -- ranked
 * a British/American spelling preference level with a genuine doubled word. On
 * campozark that promoted `analyse` vs `analyze` to the top of the report,
 * reported against all 524 pages, above every real defect. What a rule IS
 * matters; how many fixes it can suggest does not.
 */
const CONFIDENCE_BY_ISSUE_TYPE: Record<string, Confidence> = {
  grammar: 'high',
  duplication: 'high',
  misspelling: 'high',
  typographical: 'medium',
  inconsistency: 'medium',
  'non-conformance': 'medium',
  style: 'low',
  register: 'low',
  'locale-violation': 'low',
  whitespace: 'low',
  uncategorized: 'low',
};

export interface LanguageToolOptions {
  port: number;
  /** Start the container if nothing is listening. */
  autoStart: boolean;
  reporter?: Reporter;
}

export interface LanguageToolOutcome {
  findings: CopyFinding[];
  /** Set when the check did not run. Surfaced in the report, never thrown. */
  skipped?: string;
}

async function ping(port: number, timeoutMs = 2_000): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v2/languages`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, { shell: process.platform === 'win32' });
    const timer = setTimeout(() => child.kill(), timeoutMs);

    child.stdout?.on('data', (d) => (out += String(d)));
    child.stderr?.on('data', (d) => (out += String(d)));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, out });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out });
    });
  });
}

/**
 * Get a LanguageTool server, or explain why not.
 *
 * Never throws and never blocks the scan. The tool is required to run with
 * nothing but Node, so every failure here -- no Docker, no image, slow pull,
 * port in use -- degrades to "grammar check skipped" with the reason recorded
 * in the report rather than taking the run down with it.
 */
export async function ensureLanguageTool(opts: LanguageToolOptions): Promise<string | null> {
  const { port, autoStart, reporter = silentReporter } = opts;

  if (await ping(port)) return null;
  if (!autoStart) return `nothing listening on port ${port} and auto-start is disabled`;

  const version = await run('docker', ['--version'], 10_000);
  if (version.code !== 0) return 'Docker is not available on this machine';

  reporter.log(`    starting LanguageTool (${IMAGE}); the first run pulls ~1 GB`);
  await run('docker', ['rm', '-f', CONTAINER], 15_000);

  const started = await run(
    'docker',
    ['run', '-d', '--rm', '--name', CONTAINER, '-p', `${port}:8010`, IMAGE],
    240_000,
  );
  if (started.code !== 0) {
    const detail = started.out.trim().split('\n').pop() ?? 'unknown error';
    return `could not start the LanguageTool container: ${detail}`;
  }

  // Java service: the container exists well before the API answers.
  for (let i = 0; i < 60; i++) {
    if (await ping(port)) {
      reporter.log('    LanguageTool ready');
      return null;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }

  return 'LanguageTool container started but never became ready';
}

export async function stopLanguageTool(): Promise<void> {
  await run('docker', ['rm', '-f', CONTAINER], 20_000);
}

interface ChunkEntry {
  block: CorpusBlock;
  start: number;
  end: number;
}

interface Chunk {
  text: string;
  entries: ChunkEntry[];
}

/**
 * Pack blocks into few large requests instead of one request per block.
 *
 * A campozark corpus is tens of thousands of distinct blocks; a round trip each
 * would take hours. Blocks are joined with a blank line -- which LanguageTool
 * reads as a paragraph break, so no rule fires across the seam -- and each
 * block's span is recorded so matches can be mapped back.
 */
export function buildChunks(blocks: CorpusBlock[], chunkChars = CHUNK_CHARS): Chunk[] {
  const chunks: Chunk[] = [];
  let text = '';
  let entries: ChunkEntry[] = [];

  for (const block of blocks) {
    if (text.length && text.length + block.text.length > chunkChars) {
      chunks.push({ text, entries });
      text = '';
      entries = [];
    }
    const start = text.length;
    text += block.text;
    entries.push({ block, start, end: text.length });
    text += '\n\n';
  }

  if (entries.length) chunks.push({ text, entries });
  return chunks;
}

interface LtMatch {
  message: string;
  offset: number;
  length: number;
  replacements?: { value: string }[];
  rule?: { id?: string; issueType?: string; category?: { id?: string } };
}

export async function checkGrammar(
  corpus: Corpus,
  opts: LanguageToolOptions,
): Promise<LanguageToolOutcome> {
  const { port, reporter = silentReporter } = opts;

  const skipped = await ensureLanguageTool(opts);
  if (skipped) return { findings: [], skipped };

  const chunks = buildChunks(corpus.blocks);
  const byKey = new Map<string, CopyFinding>();
  reporter.phase('grammar', chunks.length);

  for (const chunk of chunks) {
    let matches: LtMatch[];
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v2/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          text: chunk.text,
          language: 'en-US',
          disabledRules: DISABLED_RULES,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) continue;
      matches = ((await res.json()) as { matches?: LtMatch[] }).matches ?? [];
    } catch {
      // One bad chunk must not lose the other several hundred.
      continue;
    }

    for (const m of matches) {
      if (DUPLICATE_CATEGORIES.has(m.rule?.category?.id ?? '')) continue;

      const entry = chunk.entries.find((e) => m.offset >= e.start && m.offset < e.end);
      if (!entry) continue;

      const localOffset = m.offset - entry.start;
      const match = entry.block.text.slice(localOffset, localOffset + m.length);
      if (!match.trim()) continue;

      const ruleId = m.rule?.id ?? 'grammar';
      const key = `${ruleId}|${match}|${m.message}`;
      const existing = byKey.get(key);
      if (existing) {
        for (const p of entry.block.pages) {
          if (!existing.pages.includes(p)) existing.pages.push(p);
        }
        continue;
      }

      const replacements = (m.replacements ?? []).map((r) => r.value).slice(0, 3);
      // Unknown issue types stay at medium: new rules should not arrive at the
      // top of the report unannounced, nor be buried where nobody sees them.
      const confidence: Confidence = CONFIDENCE_BY_ISSUE_TYPE[m.rule?.issueType ?? ''] ?? 'medium';

      byKey.set(key, {
        id: findingId('grammar', match, `${ruleId}|${m.message}`),
        category: 'grammar',
        message: m.message,
        match,
        excerpt: excerptAround(entry.block.text, localOffset, m.length),
        suggestions: replacements,
        confidence,
        pages: [...entry.block.pages],
      });
    }

    reporter.tick();
  }
  reporter.endPhase();

  return { findings: [...byKey.values()] };
}
