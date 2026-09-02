import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Inventory } from '../types.js';

export const RUNS_ROOT = 'runs';

/** Filesystem-safe host segment. */
export function hostDir(origin: string): string {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    host = origin;
  }
  return host.replace(/[^a-z0-9.-]+/gi, '_').toLowerCase();
}

/** Run ids are sortable timestamps with colons stripped for Windows. */
export function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export interface RunPaths {
  root: string;
  shots: string;
  diffs: string;
  report: string;
  inventory: string;
  manifest: string;
  links: string;
}

export function runPaths(origin: string, runId: string): RunPaths {
  const root = path.join(RUNS_ROOT, hostDir(origin), runId);
  return {
    root,
    shots: path.join(root, 'shots'),
    diffs: path.join(root, 'diffs'),
    report: path.join(root, 'report'),
    inventory: path.join(root, 'inventory.json'),
    manifest: path.join(root, 'manifest.json'),
    links: path.join(root, 'links.json'),
  };
}

export async function initRun(origin: string, runId: string): Promise<RunPaths> {
  const p = runPaths(origin, runId);
  await mkdir(p.shots, { recursive: true });
  await mkdir(p.diffs, { recursive: true });
  await mkdir(p.report, { recursive: true });
  return p;
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function saveInventory(p: RunPaths, inv: Inventory): Promise<void> {
  await writeJson(p.inventory, inv);
}

/** Completed runs for a host, newest first. */
export async function listRuns(origin: string): Promise<string[]> {
  const dir = path.join(RUNS_ROOT, hostDir(origin));
  if (!existsSync(dir)) return [];
  const items = await readdir(dir, { withFileTypes: true });
  return items
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();
}

const baselineFile = (origin: string) => path.join(RUNS_ROOT, hostDir(origin), 'baseline.json');

export async function getBaseline(origin: string): Promise<string | null> {
  const data = await readJson<{ runId: string }>(baselineFile(origin));
  return data?.runId ?? null;
}

export async function setBaseline(origin: string, runId: string): Promise<void> {
  await writeJson(baselineFile(origin), { runId, updatedAt: new Date().toISOString() });
}

/** Prune oldest runs beyond the retention limit. Never touches the baseline. */
export async function pruneRuns(origin: string, keep: number, protectRunId?: string): Promise<string[]> {
  const runs = await listRuns(origin);
  const baseline = await getBaseline(origin);
  const removed: string[] = [];
  for (const r of runs.slice(keep)) {
    if (r === baseline || r === protectRunId) continue;
    await rm(path.join(RUNS_ROOT, hostDir(origin), r), { recursive: true, force: true });
    removed.push(r);
  }
  return removed;
}
