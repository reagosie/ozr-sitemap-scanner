import { readFile, writeFile } from 'node:fs/promises';
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
  diffFile?: string;
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

/**
 * Compare one screenshot against its baseline.
 *
 * Full-page screenshots routinely differ in HEIGHT between runs, and pixelmatch
 * requires identical dimensions. Both images are padded onto a common white
 * canvas, and the height change is reported as a signal in its own right --
 * "page grew 3200 -> 3480" is often more informative than the pixel count,
 * because a height change means content was added or removed, not restyled.
 */
export async function compareShots(
  baselinePath: string,
  currentPath: string,
  diffPath: string,
  flagThreshold: number,
): Promise<DiffResult> {
  let basePng: PNG;
  let currPng: PNG;

  try {
    currPng = PNG.sync.read(await readFile(currentPath));
  } catch (err) {
    return {
      status: 'error',
      changedPixels: 0,
      totalPixels: 0,
      ratio: 0,
      baselineHeight: 0,
      currentHeight: 0,
      heightDelta: 0,
      error: `current screenshot unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    basePng = PNG.sync.read(await readFile(baselinePath));
  } catch {
    // No baseline for this URL/breakpoint: it is NEW, not changed. Reporting it
    // as changed would imply a regression where there is simply no history.
    return {
      status: 'new',
      changedPixels: 0,
      totalPixels: currPng.width * currPng.height,
      ratio: 0,
      baselineHeight: 0,
      currentHeight: currPng.height,
      heightDelta: currPng.height,
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

  // Only write a diff overlay for flagged pairs -- at ~1,500 captures per run,
  // writing an overlay for every unchanged pair would triple the run's disk use
  // for images nobody opens.
  let diffFile: string | undefined;
  if (changed) {
    await writeFile(diffPath, PNG.sync.write(diff));
    diffFile = diffPath;
  }

  return {
    status: changed ? 'changed' : 'unchanged',
    changedPixels,
    totalPixels,
    ratio,
    baselineHeight: basePng.height,
    currentHeight: currPng.height,
    heightDelta: currPng.height - basePng.height,
    ...(diffFile ? { diffFile } : {}),
  };
}
