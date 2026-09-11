/**
 * Tests for deciding which capture failures deserve another attempt.
 *
 * The rule that matters: a 504 must be retried. campwareagle's baseline lost 52
 * of its 330 pages to HTTP 504 while six scans ran at once, and the same pages
 * succeeded at another breakpoint minutes later. The server was busy, not
 * broken, and each of those holes means the next run cannot check whether the
 * page still renders.
 *
 * Run: npx tsx src/capture/retry.test.ts
 */
import { worthRetrying } from './run.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
}

const at = (status: number, extra: Partial<{ ok: boolean; blocked: boolean; error: string }> = {}) => ({
  ok: status >= 200 && status < 400,
  blocked: status === 403 || status === 429,
  status,
  ...extra,
});

// --- the failures that cost us a baseline ----------------------------------
check('504 gateway timeout is retried', worthRetrying(at(504)));
check('502 bad gateway is retried', worthRetrying(at(502)));
check('503 unavailable is retried', worthRetrying(at(503)));
check('500 is retried', worthRetrying(at(500)));
check(
  'a navigation that produced no response at all is retried',
  worthRetrying({ ok: false, blocked: false, status: 0, error: 'net::ERR_ABORTED' }),
);
check(
  'a Playwright timeout is retried',
  worthRetrying({ ok: false, blocked: false, status: 0, error: 'Timeout 45000ms exceeded' }),
);

// --- settled answers: retrying only wastes time -----------------------------
check('404 is NOT retried', !worthRetrying(at(404)));
check('410 gone is NOT retried', !worthRetrying(at(410)));
check('400 is NOT retried', !worthRetrying(at(400)));
check('401 is NOT retried', !worthRetrying(at(401)));

// --- bot protection: trying again is the exact wrong move -------------------
check('403 (bot protection) is NOT retried', !worthRetrying(at(403)));
check('429 (rate limited) is NOT retried', !worthRetrying(at(429)));
check(
  'a 503 already marked blocked is NOT retried',
  !worthRetrying({ ok: false, blocked: true, status: 503 }),
);

// --- success is not a failure ------------------------------------------------
check('200 is NOT retried', !worthRetrying(at(200)));
check('301 is NOT retried', !worthRetrying(at(301)));

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exitCode = failures ? 1 : 0;
