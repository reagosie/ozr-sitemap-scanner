import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

export type DiffStatus = 'unchanged' | 'changed' | 'new' | 'error';

export interface DiffResult {
  status: DiffStatus;
  changedPixels: number;
  totalPixels: number;
  /** changedPixels / totalPixels. Compared against the configured threshold. */
  ratio: number;
  baselineHeight: number;
  currentHeight: number;
  heightDelta: number;
  /** Blob hash of the overlay, written only for flagged pairs. */
  diffSha256?: string;
  /**
   * Blob hash of the image this was compared against.
   *
   * Carried here so the report can render a before/after pair without also
   * loading the baseline run's captures.json -- the diff already knew both
   * addresses, and nothing else in the pipeline does.
   */
  baselineSha256?: string;
  error?: string;
}

/**
 * Per-pixel colour tolerance handed to pixelmatch (NOT the flagging threshold).
 * Anti-aliasing is excluded separately via includeAA:false; together these keep
 * sub-pixel text rendering from registering as change.
 */
const PIXEL_TOLERANCE = 0.1;

/** Copy an image onto a white canvas of the given size. */
function padTo(img: PNG, width: number, height: number): PNG {
  if (img.width === width && img.height === height) return img;
  const out = new PNG({ width, height });
  out.data.fill(255);
  PNG.bitblt(img, out, 0, 0, img.width, Math.min(img.height, height), 0, 0);
  return out;
}

export interface CompareOutcome {
  result: DiffResult;
  /** Overlay bytes, present only when the pair was flagged. */
  diffBuffer?: Buffer;
}

/**
 * Result for a pair proven identical by their content hashes.
 *
 * Byte-equal images cannot differ, so this is exact rather than an
 * approximation -- and it is what makes a remote baseline affordable: no
 * download, no decode, no pixelmatch for the ~95% of pages that did not change.
 */
export function unchangedByHash(height: number, sha256: string): CompareOutcome {
  return {
    result: {
      status: 'unchanged',
      changedPixels: 0,
      totalPixels: 0,
      ratio: 0,
      baselineHeight: height,
      currentHeight: height,
      heightDelta: 0,
      baselineSha256: sha256,
    },
  };
}

/**
 * Result for a page the baseline has no image for.
 *
 * Deciding this needs no pixels -- only the knowledge that there is nothing to
 * compare against. Fetching the current image to reach the same conclusion would
 * mean downloading screenshots this run just uploaded, which on a run whose
 * baseline metadata is missing is the entire capture set: 4.4 GB to learn that
 * every page is new.
 */
export function newByHeight(height: number): CompareOutcome {
  return {
    result: {
      status: 'new',
      changedPixels: 0,
      totalPixels: 0,
      ratio: 0,
      baselineHeight: 0,
      currentHeight: height,
      heightDelta: height,
    },
  };
}

/**
 * Compare one screenshot against its baseline.
 *
 * Full-page screenshots routinely differ in HEIGHT between runs, and pixelmatch
 * requires identical dimensions. Both images are padded onto a common white
 * canvas, and the height change is reported as a signal in its own right --
 * "page grew 3200 -> 3480" is often more informative than the pixel count,
 * because a height change means content was added or removed, not restyled.
 *
 * Takes buffers rather than paths: the images may live in S3, and the caller is
 * the only layer that knows how to fetch them.
 */
export function compareShots(
  baseline: Buffer | null,
  current: Buffer | null,
  flagThreshold: number,
): CompareOutcome {
  let basePng: PNG;
  let currPng: PNG;

  if (!current) {
    return {
      result: {
        status: 'error',
        changedPixels: 0,
        totalPixels: 0,
        ratio: 0,
        baselineHeight: 0,
        currentHeight: 0,
        heightDelta: 0,
        error: 'current screenshot missing',
      },
    };
  }

  try {
    currPng = PNG.sync.read(current);
  } catch (err) {
    return {
      result: {
        status: 'error',
        changedPixels: 0,
        totalPixels: 0,
        ratio: 0,
        baselineHeight: 0,
        currentHeight: 0,
        heightDelta: 0,
        error: `current screenshot unreadable: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  if (!baseline) {
    // No baseline for this URL/breakpoint: it is NEW, not changed. Reporting it
    // as changed would imply a regression where there is simply no history.
    return {
      result: {
        status: 'new',
        changedPixels: 0,
        totalPixels: currPng.width * currPng.height,
        ratio: 0,
        baselineHeight: 0,
        currentHeight: currPng.height,
        heightDelta: currPng.height,
      },
    };
  }

  try {
    basePng = PNG.sync.read(baseline);
  } catch (err) {
    return {
      result: {
        status: 'error',
        changedPixels: 0,
        totalPixels: 0,
        ratio: 0,
        baselineHeight: 0,
        currentHeight: currPng.height,
        heightDelta: 0,
        error: `baseline screenshot unreadable: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  const width = Math.max(basePng.width, currPng.width);
  const height = Math.max(basePng.height, currPng.height);
  const a = padTo(basePng, width, height);
  const b = padTo(currPng, width, height);

  const diff = new PNG({ width, height });
  const changedPixels = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold: PIXEL_TOLERANCE,
    includeAA: false,
  });

  const totalPixels = width * height;
  const ratio = totalPixels === 0 ? 0 : changedPixels / totalPixels;
  const changed = ratio > flagThreshold;

  return {
    result: {
      status: changed ? 'changed' : 'unchanged',
      changedPixels,
      totalPixels,
      ratio,
      baselineHeight: basePng.height,
      currentHeight: currPng.height,
      heightDelta: currPng.height - basePng.height,
    },
    // Only flagged pairs get an overlay -- at ~1,500 captures per run, storing an
    // overlay for every unchanged pair would inflate the run for images nobody opens.
    ...(changed ? { diffBuffer: PNG.sync.write(diff) } : {}),
  };
}
