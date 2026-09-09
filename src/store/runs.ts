import type { StorageBackend } from './backend.js';
import { joinKey } from './backend.js';

/**
 * Run ids are sortable timestamps with colons and dots stripped -- colons are
 * illegal in Windows paths, and the id is a path segment on the local backend.
 */
export function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Exactly the shape `newRunId` produces.
 *
 * This is load-bearing, not decoration: a host prefix holds run directories
 * alongside `blobs/`, and `listRuns` tells them apart by matching this. A looser
 * pattern would report `blobs` as a run and then fail to read its manifest.
 */
export const RUN_ID_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** Reserved child names under a host prefix that are not runs. */
const NON_RUN_PREFIXES = new Set(['blobs']);

/**
 * The instant a run started, recovered from its id.
 *
 * The id IS the timestamp, so age costs no request and no stored field -- which
 * matters for expiry, because reading a manifest for every run of every host
 * would turn a cheap listing into a round trip per run.
 */
export function runStartedAt(runId: string): Date | null {
  if (!RUN_ID_RE.test(runId)) return null;
  const iso = runId.replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1:$2:$3.$4Z',
  );
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/** Storage-safe host segment. */
export function hostDir(origin: string): string {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    host = origin;
  }
  return host.replace(/[^a-z0-9.-]+/gi, '_').toLowerCase();
}

export interface RunKeys {
  root: string;
  inventory: string;
  manifest: string;
  links: string;
  captures: string;
  diffs: string;
  copy: string;
  report: string;
}

export function runKeys(origin: string, runId: string): RunKeys {
  const root = joinKey(hostDir(origin), runId);
  return {
    root,
    inventory: joinKey(root, 'inventory.json'),
    manifest: joinKey(root, 'manifest.json'),
    links: joinKey(root, 'links.json'),
    captures: joinKey(root, 'captures.json'),
    diffs: joinKey(root, 'diffs.json'),
    copy: joinKey(root, 'copy.json'),
    report: joinKey(root, 'report.html'),
  };
}

/**
 * Screenshots are addressed by the SHA-256 of their bytes, not by run.
 *
 * An unchanged page produces the same hash every run, so it is stored once and
 * uploaded once no matter how many runs reference it -- and a diff can be
 * decided by comparing two hashes without transferring either image.
 */
export function blobKey(origin: string, sha256: string): string {
  return joinKey(hostDir(origin), 'blobs', `${sha256}.png`);
}

export const baselineKey = (origin: string) => joinKey(hostDir(origin), 'baseline.json');
export const acceptedKey = (origin: string) => joinKey(hostDir(origin), 'copy-accepted.json');
export const lockKey = (origin: string) => joinKey(hostDir(origin), 'lock.json');

/** Completed runs for a host, newest first. */
export async function listRuns(backend: StorageBackend, origin: string): Promise<string[]> {
  const children = await backend.listPrefixes(hostDir(origin));
  return children
    .filter((name) => !NON_RUN_PREFIXES.has(name) && RUN_ID_RE.test(name))
    .sort()
    .reverse();
}

export async function getBaseline(backend: StorageBackend, origin: string): Promise<string | null> {
  const data = await backend.getJson<{ runId: string }>(baselineKey(origin));
  return data?.runId ?? null;
}

export interface BaselineResult {
  ok: boolean;
  /** Set when another run moved the pointer first. */
  conflictedWith?: string;
}

/**
 * Move the baseline pointer, refusing to clobber a concurrent scan.
 *
 * Two people scanning the same host would otherwise silently overwrite each
 * other's pointer and leave the next run diffing against something neither of
 * them produced. A lost race is reported so the operator can re-run, not thrown.
 */
export async function setBaseline(
  backend: StorageBackend,
  origin: string,
  runId: string,
): Promise<BaselineResult> {
  const key = baselineKey(origin);
  const current = await backend.readTagged<{ runId: string }>(key);
  const payload = { runId, updatedAt: new Date().toISOString() };

  const ok = await backend.putJsonConditional(key, payload, current?.tag ?? null);
  if (ok) return { ok: true };

  const now = await backend.getJson<{ runId: string }>(key);
  return { ok: false, ...(now?.runId ? { conflictedWith: now.runId } : {}) };
}

/**
 * A blob must be this old before garbage collection may take it.
 *
 * Blobs are uploaded during the capture pass but only become *referenced* when
 * captures.json is written at the end. A concurrent scan is therefore holding
 * live blobs that nothing points at yet; without this grace period a prune
 * running alongside it would delete the other run's screenshots out from under
 * it.
 */
const BLOB_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface PruneOptions {
  /** Runs retained per host, newest first. */
  keep: number;
  /**
   * Runs older than this go regardless of the keep count.
   *
   * Omit to disable age expiry entirely. Age comes from the run id, so a run
   * whose id predates the current format is never expired -- unparseable is
   * treated as "leave it alone", never as "infinitely old".
   */
  maxAgeMs?: number;
  /** The run in progress. Never removed, whatever the other rules say. */
  protectRunId?: string;
  /**
   * Reports backend, so a run's emailable files go with the run.
   *
   * The reports prefix was originally meant to outlive the data. That is the
   * wrong default for a store nobody is watching: nothing would ever have
   * removed those files, and "5 runs per site" has to mean five runs' worth of
   * everything, or the bucket grows without limit in a place nobody looks.
   */
  reports?: StorageBackend;
  /** List what would go without removing any of it. */
  dryRun?: boolean;
}

export interface PruneResult {
  /** Removed for falling outside the retention count. */
  removedRuns: string[];
  /** Removed for being older than `maxAgeMs`. */
  expiredRuns: string[];
  removedBlobs: number;
  /** Everything freed: run metadata, reports, and collected blobs. */
  bytesFreed: number;
  /**
   * A run that met a removal rule but was kept because it is the baseline.
   *
   * Deleting the baseline is the single most expensive mistake available here:
   * the next scan would find no comparison point, call all ~525 pages new, and
   * hand back a report with no change signal at all.
   */
  keptBaseline?: string;
  dryRun: boolean;
}

/**
 * Enforce retention, then collect blobs nothing references.
 *
 * This is the whole lifecycle policy: it lives in the program rather than in an
 * S3 lifecycle rule so that the rules travel with the code and apply to any
 * bucket the tool is pointed at, including a local `runs/` directory that AWS
 * could never manage.
 *
 * Content addressing means deleting a run's metadata does not free its images --
 * they may still belong to a surviving run. So pruning is two phases: remove the
 * doomed runs, then diff the blobs in the store against the set still referenced
 * by everything left standing.
 *
 * Note what age expiry deliberately does NOT do: it never deletes a blob for
 * being old. A screenshot uploaded two years ago is still the current image of
 * any page that has not changed since, and deleting it by date would corrupt
 * every surviving run that points at it. Blobs leave only by becoming
 * unreferenced.
 */
export async function pruneRuns(
  backend: StorageBackend,
  origin: string,
  opts: PruneOptions,
): Promise<PruneResult> {
  const { keep, maxAgeMs, protectRunId, reports, dryRun = false } = opts;

  const runs = await listRuns(backend, origin);
  const baseline = await getBaseline(backend, origin);
  const now = Date.now();

  const removedRuns: string[] = [];
  const expiredRuns: string[] = [];
  let keptBaseline: string | undefined;
  let bytesFreed = 0;

  for (const [index, runId] of runs.entries()) {
    const startedAt = runStartedAt(runId);
    const tooOld =
      maxAgeMs !== undefined && startedAt !== null && now - startedAt.getTime() > maxAgeMs;
    const beyondKeep = index >= keep;
    if (!tooOld && !beyondKeep) continue;

    if (runId === protectRunId) continue;
    if (runId === baseline) {
      keptBaseline = runId;
      continue;
    }
    (tooOld ? expiredRuns : removedRuns).push(runId);
  }

  for (const runId of [...removedRuns, ...expiredRuns]) {
    const objects = await backend.listObjects(runKeys(origin, runId).root);
    bytesFreed += objects.reduce((n, o) => n + o.size, 0);
    if (!dryRun) await backend.remove(objects.map((o) => o.key));

    if (reports) {
      const published = await reports.listObjects(joinKey(hostDir(origin), runId));
      bytesFreed += published.reduce((n, o) => n + o.size, 0);
      if (!dryRun) await reports.remove(published.map((o) => o.key));
    }
  }

  // Screenshots are referenced from captures.json and diff overlays from
  // diffs.json, so both have to be read -- collecting only one would delete
  // every overlay the surviving reports still link to.
  const doomed = new Set([...removedRuns, ...expiredRuns]);
  const survivors = runs.filter((r) => !doomed.has(r));
  const referenced = new Set<string>();
  for (const r of survivors) {
    const keys = runKeys(origin, r);

    const captures = await backend.getJson<BlobRefs[]>(keys.captures);
    for (const cap of captures ?? []) {
      for (const shot of Object.values(cap?.breakpoints ?? {})) {
        if (shot?.sha256) referenced.add(shot.sha256);
      }
    }

    const diffs = await backend.getJson<BlobRefs[]>(keys.diffs);
    for (const d of diffs ?? []) {
      for (const bp of Object.values(d?.breakpoints ?? {})) {
        if (bp?.diffSha256) referenced.add(bp.diffSha256);
      }
    }
  }

  const cutoff = now - BLOB_GRACE_MS;
  const blobs = await backend.listObjects(joinKey(hostDir(origin), 'blobs'));
  const orphans = blobs.filter((b) => {
    const sha = b.key.split('/').pop()?.replace(/\.png$/, '') ?? '';
    return !referenced.has(sha) && b.lastModified.getTime() < cutoff;
  });

  if (orphans.length && !dryRun) await backend.remove(orphans.map((b) => b.key));
  bytesFreed += orphans.reduce((n, b) => n + b.size, 0);

  return {
    removedRuns,
    expiredRuns,
    removedBlobs: orphans.length,
    bytesFreed,
    ...(keptBaseline ? { keptBaseline } : {}),
    dryRun,
  };
}

/**
 * Just enough of a capture or diff record for garbage collection to read.
 *
 * Deliberately structural rather than importing PageCapture/PageDiff: GC reads
 * whatever an older run happened to write, and a stricter type would make a
 * schema change look like a parse failure and silently free live blobs.
 */
interface BlobRefs {
  breakpoints?: Record<string, { sha256?: string; diffSha256?: string } | undefined>;
}
