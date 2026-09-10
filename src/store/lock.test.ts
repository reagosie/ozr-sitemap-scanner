/**
 * Tests for the per-site run lock.
 *
 * Run: npx tsx src/store/lock.test.ts
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalBackend } from './local.js';
import { acquireLock, lockKey } from './runs.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
}

const info = (runId: string) => ({
  runId,
  startedAt: new Date().toISOString(),
  machine: 'test-machine',
  pid: 1234,
});

async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'lock-'));
  const backend = new LocalBackend(root);
  const A = 'https://campozark.com';
  const B = 'https://campotx.com';

  // --- one scan per site ------------------------------------------------
  const first = await acquireLock(backend, A, info('run-1'));
  check('the first scan of a site gets the lock', first.ok);

  const second = await acquireLock(backend, A, info('run-2'));
  check('a second scan of the SAME site is refused', !second.ok);
  check('the refusal names the run holding it', second.heldBy?.runId === 'run-1', String(second.heldBy?.runId));
  check('the refusal names the machine', second.heldBy?.machine === 'test-machine');

  // --- the whole point: other sites are unaffected -----------------------
  const other = await acquireLock(backend, B, info('run-3'));
  check('a scan of a DIFFERENT site is allowed at the same time', other.ok);
  await other.handle?.release();

  // --- releasing frees it -----------------------------------------------
  await first.handle?.release();
  const third = await acquireLock(backend, A, info('run-4'));
  check('the site is free once the first scan releases', third.ok);

  // --- a crashed scan must not block the site forever -------------------
  const key = lockKey(A);
  const stored = (await backend.getJson<Record<string, unknown>>(key))!;
  await backend.putJson(key, {
    ...stored,
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });

  const afterStale = await acquireLock(backend, A, info('run-5'));
  check('an hour-old lock is treated as abandoned and taken over', afterStale.ok);

  // --- force -------------------------------------------------------------
  const blocked = await acquireLock(backend, A, info('run-6'));
  check('a fresh lock still blocks without --force', !blocked.ok);

  const forced = await acquireLock(backend, A, info('run-7'), { force: true });
  check('--force takes the lock anyway', forced.ok);
  await forced.handle?.release();

  // --- a corrupt timestamp must not block forever either -----------------
  await backend.putJson(key, { runId: 'x', startedAt: 'not-a-date', machine: 'm', pid: 1 });
  const afterCorrupt = await acquireLock(backend, A, info('run-8'));
  check('a lock with an unreadable date is treated as expired', afterCorrupt.ok);
  await afterCorrupt.handle?.release();

  // --- release is not allowed to steal someone else's lock ---------------
  const mine = await acquireLock(backend, A, info('run-9'));
  await backend.putJson(key, info('someone-else'));
  await mine.handle?.release();
  const stillHeld = await backend.getJson<{ runId: string }>(key);
  check("releasing does not delete another run's lock", stillHeld?.runId === 'someone-else', String(stillHeld?.runId));

  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
  process.exitCode = failures ? 1 : 0;
}
main();
