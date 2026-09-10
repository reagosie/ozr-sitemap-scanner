/**
 * Terminal progress.
 *
 * A full campozark scan is ninety minutes across eight stages. Before this the
 * terminal printed a line every twenty-five pages and nothing else, so the only
 * way to answer "how much longer?" -- or to tell a slow stage from a hung one --
 * was to wait and find out.
 *
 * Two rendering modes, because the tool is genuinely run both ways. Interactive:
 * one line repainted in place with a bar and an ETA. Captured to a log -- a
 * background task, CI, a pipe -- where carriage returns produce garbage: an
 * occasional plain line instead. Same information, and the same transcript once
 * a phase closes, so a log and a live terminal read alike afterwards.
 *
 * Everything the CLI prints goes through `log()` rather than `console.log`. That
 * is the whole reason the repainted line survives: a bare write to stdout while
 * a bar is live lands in the middle of it and corrupts the display.
 */

export interface Reporter {
  /** A permanent line. Never overwritten, safe to call mid-phase. */
  log(msg?: string): void;

  /**
   * Open a counted phase. Closes any phase still open.
   * `total` of 0 is allowed -- an empty batch still deserves a line saying so.
   */
  phase(label: string, total: number): void;

  /** Advance the open phase. No-op when there is none. */
  tick(delta?: number): void;

  /** Close the open phase, leaving a permanent line with its wall time. */
  endPhase(): void;

  /** Wall time since this reporter was created, as `m:ss` or `h:mm:ss`. */
  elapsed(): string;
}

const BAR_WIDTH = 22;

/** ~8 repaints a second: smooth to read, invisible next to any real work. */
const TTY_REPAINT_MS = 120;

/** A captured log wants a heartbeat, not a transcript of every item. */
const PLAIN_INTERVAL_MS = 20_000;

/**
 * The first plain heartbeat comes early, so a long phase announces itself
 * rather than going quiet for twenty seconds. A phase that finishes inside this
 * says nothing until its closing line -- which is the whole point: short phases
 * get one line, long ones get a running commentary.
 */
const PLAIN_FIRST_MS = 5_000;

/** How often the clock checks whether the phase has gone quiet. */
const STALL_CHECK_MS = 5_000;

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

class TerminalReporter implements Reporter {
  private readonly startedAt = Date.now();
  private open = false;
  private label = '';
  private total = 0;
  private done = 0;
  private phaseStart = 0;
  private lastEmit = 0;
  /** Width of the live line, so the next paint can erase what it does not cover. */
  private painted = 0;
  /** Keeps the line moving when nothing is completing. See `phase`. */
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** `done` as of the last line printed, so a stall can be named as one. */
  private lastEmitDone = 0;

  constructor(private readonly tty: boolean) {}

  elapsed(): string {
    return formatDuration(Date.now() - this.startedAt);
  }

  log(msg = ''): void {
    this.erase();
    console.log(msg);
    if (this.open && this.tty) this.paint(true);
  }

  phase(label: string, total: number): void {
    this.endPhase();
    // Nothing to count is worth one line, not an opening line and a 0/0 closing
    // one. Empty batches are routine -- a site with no external links, a diff
    // with nothing to compare.
    if (total <= 0) {
      this.log(`  ${label}: none`);
      return;
    }
    this.open = true;
    this.label = label;
    this.total = Math.max(0, total);
    this.done = 0;
    this.phaseStart = Date.now();
    this.lastEmitDone = 0;
    this.lastEmit = Date.now() - (PLAIN_INTERVAL_MS - PLAIN_FIRST_MS);
    if (this.tty) {
      this.lastEmit = Date.now();
      this.paint(true);
    }

    // A clock, not just a counter.
    //
    // Progress was previously driven only by tick(), so a phase that stalled
    // went completely silent -- which is the moment you most want to hear from
    // it. A campozarkfoundation scan sat on 17 of 19 pages for eleven minutes
    // and printed nothing at all, so there was no way to tell a slow page from
    // a hung one. This keeps the line alive on a timer and says outright when
    // nothing has moved.
    this.ticker = setInterval(() => {
      if (!this.open) return;
      if (this.tty) {
        this.paint(true);
        return;
      }
      if (Date.now() - this.lastEmit < PLAIN_INTERVAL_MS) return;
      const stalled = this.done === this.lastEmitDone;
      this.lastEmit = Date.now();
      this.lastEmitDone = this.done;
      console.log(this.render() + (stalled ? '   [nothing finished since the last line]' : ''));
    }, STALL_CHECK_MS);
    this.ticker.unref?.();
  }

  tick(delta = 1): void {
    if (!this.open) return;
    this.done += delta;
    if (this.tty) this.paint(false);
    else if (Date.now() - this.lastEmit >= PLAIN_INTERVAL_MS) {
      this.lastEmit = Date.now();
      this.lastEmitDone = this.done;
      console.log(this.render());
    }
  }

  endPhase(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    if (!this.open) return;
    const took = formatDuration(Date.now() - this.phaseStart);
    this.erase();
    console.log(`  ${this.label}: ${this.done}/${this.total} in ${took}`);
    this.open = false;
    this.total = 0;
    this.done = 0;
  }

  /** The live line, identical in both modes so transcripts match. */
  private render(): string {
    const frac = this.total > 0 ? Math.min(1, this.done / this.total) : 1;
    const sinceStart = Date.now() - this.phaseStart;

    // Rate over the whole phase rather than a recent window: these phases are
    // long and roughly uniform, and an average that only firms up is easier to
    // trust than one that swings with every slow page.
    const perItem = this.done > 0 ? sinceStart / this.done : 0;
    const remaining = Math.max(0, this.total - this.done);
    const eta = remaining === 0 ? '0:00' : perItem > 0 ? formatDuration(perItem * remaining) : '--:--';

    const filled = Math.round(frac * BAR_WIDTH);
    const bar = '#'.repeat(filled) + '.'.repeat(BAR_WIDTH - filled);
    const pct = String(Math.floor(frac * 100)).padStart(3);

    return (
      `  ${this.label}  [${bar}] ${pct}%  ${this.done}/${this.total}  ` +
      `eta ${eta}  (${this.elapsed()} elapsed)`
    );
  }

  private paint(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastEmit < TTY_REPAINT_MS) return;
    this.lastEmit = now;

    // Truncate rather than wrap: a wrapped line makes the next \r return to the
    // wrong row and the bar starts walking down the screen.
    const width = Math.max(20, (process.stdout.columns ?? 80) - 1);
    const line = this.render().slice(0, width);
    const pad = Math.max(0, this.painted - line.length);
    process.stdout.write(`\r${line}${' '.repeat(pad)}`);
    this.painted = line.length;
  }

  private erase(): void {
    if (!this.painted) return;
    process.stdout.write(`\r${' '.repeat(this.painted)}\r`);
    this.painted = 0;
  }
}

/** Swallows everything. The default for library callers with no terminal. */
export const silentReporter: Reporter = {
  log: () => {},
  phase: () => {},
  tick: () => {},
  endPhase: () => {},
  elapsed: () => '0:00',
};

export function createReporter(): Reporter {
  // SITEMAP_SCANNER_PLAIN forces the log-friendly mode: useful when stdout is a
  // TTY but something downstream is recording it verbatim.
  const tty = Boolean(process.stdout.isTTY) && process.env.SITEMAP_SCANNER_PLAIN !== '1';
  return new TerminalReporter(tty);
}

/** One terminal, one reporter. Passed down explicitly; never imported by leaves. */
export const reporter: Reporter = createReporter();
