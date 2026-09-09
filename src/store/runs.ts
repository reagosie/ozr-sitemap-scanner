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

export interface PruneResult {
  removedRuns: string[];
  removedBlobs: number;
  bytesFreed: number;
}

/**
 * Drop runs beyond the retention limit, then collect blobs nothing references.
 *
 * Content addressing means deleting a run's metadata does not free its images --
 * they may still belong to a surviving run. So pruning is two phases: remove the
 * run prefixes, then diff the set of blobs on disk against the set referenced by
 * everything that is left.
 */
export async function pruneRuns(
  backend: StorageBackend,
  origin: string,
  keep: number,
  protectRunId?: string,
): Promise<PruneResult> {
  const runs = await listRuns(backend, origin);
  const baseline = await getBaseline(backend, origin);

  const removedRuns: string[] = [];
  for (const r of runs.slice(keep)) {
    if (r === baseline || r === protectRunId) continue;
    const objects = await backend.listObjects(runKeys(origin, r).root);
    await backend.remove(objects.map((o) => o.key));
    removedRuns.push(r);
  }

  // Screenshots are referenced from captures.json and diff overlays from
  // diffs.json, so both have to be read -- collecting only one would delete
  // every overlay the surviving reports still link to.
  const survivors = runs.filter((r) => !removedRuns.includes(r));
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

  const cutoff = Date.now() - BLOB_GRACE_MS;
  const blobs = await backend.listObjects(joinKey(hostDir(origin), 'blobs'));
  const doomed = blobs.filter((b) => {
    const sha = b.key.split('/').pop()?.replace(/\.png$/, '') ?? '';
    return !referenced.has(sha) && b.lastModified.getTime() < cutoff;
  });

  if (doomed.length) await backend.remove(doomed.map((b) => b.key));

  return {
    removedRuns,
    removedBlobs: doomed.length,
    bytesFreed: doomed.reduce((n, b) => n + b.size, 0),
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
