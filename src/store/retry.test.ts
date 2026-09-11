/**
 * Tests for deciding which S3 failures are worth another try.
 *
 * The rule that matters: ENOTFOUND must be retryable. The AWS SDK does not
 * retry it, and one of them killed a two-hour campozark baseline at 317 of 525
 * pages when the network blinked for a few seconds.
 *
 * Run: npx tsx src/store/retry.test.ts
 */
import { isRetryableAwsError } from './s3.js';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}`);
  if (!ok) failures++;
}

const withCode = (code: string): Error => Object.assign(new Error(code), { code });
const withStatus = (httpStatusCode: number): Error =>
  Object.assign(new Error('http ' + httpStatusCode), { $metadata: { httpStatusCode } });

// --- the failure that caused this ------------------------------------------
check('ENOTFOUND is retried', isRetryableAwsError(withCode('ENOTFOUND')));
check(
  'ENOTFOUND is retried when the SDK has wrapped it',
  isRetryableAwsError(Object.assign(new Error('connection failure'), { cause: withCode('ENOTFOUND') })),
);
check(
  'ENOTFOUND is retried when wrapped two deep',
  isRetryableAwsError({ cause: { cause: withCode('ENOTFOUND') } }),
);

// --- other transient network faults ----------------------------------------
for (const code of ['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH']) {
  check(`${code} is retried`, isRetryableAwsError(withCode(code)));
}
check('a TimeoutError by name is retried', isRetryableAwsError(Object.assign(new Error('slow'), { name: 'TimeoutError' })));

// --- server-side faults ------------------------------------------------------
check('500 is retried', isRetryableAwsError(withStatus(500)));
check('503 is retried', isRetryableAwsError(withStatus(503)));
check('429 (throttled) is retried', isRetryableAwsError(withStatus(429)));

// --- and the ones that must NOT be retried ----------------------------------
// Repeating these wastes half a minute and then fails anyway, and the delay
// hides a real configuration problem behind what looks like a hang.
check('404 is NOT retried', !isRetryableAwsError(withStatus(404)));
check('403 (no permission) is NOT retried', !isRetryableAwsError(withStatus(403)));
check('412 (precondition failed) is NOT retried', !isRetryableAwsError(withStatus(412)));
check('400 is NOT retried', !isRetryableAwsError(withStatus(400)));
check('a plain error is NOT retried', !isRetryableAwsError(new Error('something else')));
check('null is NOT retried', !isRetryableAwsError(null));
check('a string is NOT retried', !isRetryableAwsError('nope'));

// A 412 is how a lost lock race is reported. If that were retried, taking a
// lock during a network wobble would look like somebody else holding it.
check(
  '412 with a NoSuchKey-style name is still NOT retried',
  !isRetryableAwsError(Object.assign(new Error('PreconditionFailed'), {
    name: 'PreconditionFailed',
    $metadata: { httpStatusCode: 412 },
  })),
);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exitCode = failures ? 1 : 0;
