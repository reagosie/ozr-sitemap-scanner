import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import type { Config } from '../config.js';
import type { Backends } from './factory.js';
import { blobKey, hostDir, runKeys, setBaseline, RUN_ID_RE } from './runs.js';
import { silentReporter, type Reporter } from '../progress.js';

export interface MigrateOptions {
  /** Migrate every local run, not just the one the baseline points at. */
  all: boolean;
  reporter?: Reporter;
}

export interface MigrateResult {
  /** Runs now present in the central store. */
  migrated: string[];
  /** The run the baseline pointer was set to. */
  baselineId: string;
  uploaded: number;
  reused: number;
  bytes: number;
}

/**
 * The old on-disk shape, before content addressing.
 *
 * Runs written by earlier versions store a per-run `shots/<slug>__<bp>.png`
 * and record only the filename. Migration is therefore not a copy: every image
 * has to be read, hashed, and re-keyed by its content.
 */
interface LegacyShot {
  file: string;
  height: number;
  ok: boolean;
  status: number;
  blocked: boolean;
  sha256?: string;
  error?: string;
}

interface LegacyCapture {
  loc: string;
  slug: string;
  breakpoints: Record<string, LegacyShot>;
  [k: string]: unknown;
}

interface LegacyDiff {
  loc: string;
  breakpoints: Record<string, { diffFile?: string; diffSha256?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Lift runs off the laptop into the central store.
 *
 * The point of migrating at all is the BASELINE. Starting fresh in S3 is
 * cheaper, but then the next scan of campozark reports all 524 pages as new and
 * produces no change signal -- one wasted review cycle, which is more expensive
 * than the upload.
 */
export async function migrateLocalRuns(
  config: Config,
  backends: Backends,
  origin: string,
  opts: MigrateOptions,
): Promise<MigrateResult> {
  const { reporter = silentReporter } = opts;
  const host = hostDir(origin);
  const localHostDir = path.resolve(config.storage.localRoot, host);

  if (!(await exists(localHostDir))) {
    throw new Error(`no local runs at ${localHostDir}`);
  }

  const entries = await readdir(localHostDir, { withFileTypes: true });
  const localRuns = entries
    .filter((d) => d.isDirectory() && RUN_ID_RE.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();

  const newest = localRuns[0];
  if (!newest) throw new Error(`no runs found under ${localHostDir}`);

  // Some hosts have runs but no baseline.json (campwareagle, for one), so the
  // newest run stands in -- migrating with no baseline at all would leave the
  // next scan with nothing to diff against, which is the thing this avoids.
  const localBaseline = await readJsonFile<{ runId: string }>(
    path.join(localHostDir, 'baseline.json'),
  );
  const baselineId = localBaseline?.runId ?? newest;

  const toMigrate = opts.all ? localRuns : localRuns.filter((r) => r === baselineId);
  if (!toMigrate.length) {
    throw new Error(`baseline ${baselineId} is not present locally; re-run with --all`);
  }

  reporter.log(`\n  migrating ${toMigrate.length} run(s) from ${localHostDir}`);
  reporter.log(`  to ${backends.data.describe}\n`);

  let uploaded = 0;
  let reused = 0;
  let bytes = 0;

  for (const runId of toMigrate) {
    const runDir = path.join(localHostDir, runId);
    const keys = runKeys(origin, runId);
    reporter.log(`  ${runId}`);

    // Metadata first: it is small, and it makes a partially-migrated run
    // recognisable rather than a directory of orphaned blobs.
    for (const [name, key] of [
      ['inventory.json', keys.inventory],
      ['manifest.json', keys.manifest],
      ['links.json', keys.links],
      ['copy.json', keys.copy],
    ] as const) {
      const data = await readJsonFile<unknown>(path.join(runDir, name));
      if (data) await backends.data.putJson(key, data);
    }

    const captures = await readJsonFile<LegacyCapture[]>(path.join(runDir, 'captures.json'));
    if (captures) {
      const limiter = pLimit(6);
      reporter.phase(`upload ${runId}`, captures.length);

      await Promise.all(
        captures.map((cap) =>
          limiter(async () => {
            for (const [bpName, shot] of Object.entries(cap.breakpoints ?? {})) {
              if (!shot?.file || shot.sha256) continue;
              const file = path.join(runDir, 'shots', shot.file);
              let buf: Buffer;
              try {
                buf = await readFile(file);
              } catch {
                continue; // A missing screenshot is not a reason to abort a migration.
              }
              const sha = createHash('sha256').update(buf).digest('hex');
              const key = blobKey(origin, sha);
              if (await backends.data.exists(key)) {
                reused++;
              } else {
                await backends.data.putBuffer(key, buf, 'image/png');
                uploaded++;
                bytes += buf.length;
              }
              cap.breakpoints[bpName] = { ...shot, sha256: sha };
            }
            reporter.tick();
          }),
        ),
      );
      reporter.endPhase();

      await backends.data.putJson(keys.captures, captures);
    }

    const diffs = await readJsonFile<LegacyDiff[]>(path.join(runDir, 'diffs.json'));
    if (diffs) {
      for (const d of diffs) {
        for (const [bpName, bp] of Object.entries(d.breakpoints ?? {})) {
          if (!bp?.diffFile || bp.diffSha256) continue;
          // The legacy field held a full path; only the basename is portable.
          const file = path.join(runDir, 'diffs', path.basename(String(bp.diffFile)));
          let buf: Buffer;
          try {
            buf = await readFile(file);
          } catch {
            continue;
          }
          const sha = createHash('sha256').update(buf).digest('hex');
          const key = blobKey(origin, sha);
          if (await backends.data.exists(key)) reused++;
          else {
            await backends.data.putBuffer(key, buf, 'image/png');
            uploaded++;
            bytes += buf.length;
          }
          const { diffFile: _dropped, ...rest } = bp;
          d.breakpoints[bpName] = { ...rest, diffSha256: sha };
        }
      }
      await backends.data.putJson(keys.diffs, diffs);
    }
  }

  const result = await setBaseline(backends.data, origin, baselineId);
  reporter.log('');
  reporter.log(
    `  uploaded ${uploaded} blob(s) (${(bytes / 1_048_576).toFixed(1)} MB), reused ${reused}`,
  );
  reporter.log(
    result.ok
      ? `  baseline set to ${baselineId}`
      : `  WARNING: baseline not moved - it already points at ${result.conflictedWith ?? 'another run'}`,
  );

  return { migrated: toMigrate, baselineId, uploaded, reused, bytes };
}

async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
