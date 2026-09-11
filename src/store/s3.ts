import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ObjectMeta, StorageBackend } from './backend.js';

/** AWS refuses a longer signature for IAM-user credentials. */
const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

/** DeleteObjects accepts at most 1,000 keys per request. */
const DELETE_BATCH = 1000;

export interface S3BackendOptions {
  bucket: string;
  region: string;
  /** Everything this backend reads and writes lives under here, e.g. `data`. */
  prefix?: string;
}

/**
 * Network faults worth another try.
 *
 * ENOTFOUND is the one that matters. It is a DNS lookup failure, and the AWS
 * SDK does NOT retry it: its own retry logic covers timeouts, throttling and
 * 5xx replies, but treats "the name did not resolve" as final. A campozark
 * baseline ran for two hours, reached 317 of 525 pages on its last pass, and
 * died on a single ENOTFOUND when the network blinked. Two hours of work thrown
 * away by an outage that lasted seconds.
 */
const RETRYABLE_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EPROTO',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

const RETRYABLE_NAMES = new Set([
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'NetworkingError',
]);

/** Six tries: 1s, 2s, 4s, 8s, 16s of waiting, about half a minute in total. */
const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 1_000;

export function isRetryableAwsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; name?: string; $metadata?: { httpStatusCode?: number }; cause?: unknown };
  if (e.code && RETRYABLE_NETWORK_CODES.has(e.code)) return true;
  if (e.name && (RETRYABLE_NAMES.has(e.name) || RETRYABLE_NETWORK_CODES.has(e.name))) return true;
  const status = e.$metadata?.httpStatusCode;
  if (status && (status === 429 || status >= 500)) return true;
  // The SDK wraps the socket error, so the real code is often one level down.
  return e.cause ? isRetryableAwsError(e.cause) : false;
}

export class S3Backend implements StorageBackend {
  readonly describe: string;
  readonly canPresign = true;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  /** Set by the CLI so a retry is visible in the run log rather than silent. */
  onRetry?: (msg: string) => void;

  constructor(opts: S3BackendOptions) {
    this.bucket = opts.bucket;
    this.prefix = (opts.prefix ?? '').replace(/^\/+|\/+$/g, '');
    this.client = new S3Client({ region: opts.region });
    this.describe = `s3://${this.bucket}${this.prefix ? '/' + this.prefix : ''}`;
  }

  /**
   * Run one S3 call, retrying a network fault with growing pauses.
   *
   * Deliberately NOT used for putJsonConditional. A conditional write whose
   * reply is lost may already have landed, and retrying it would come back
   * 412 Precondition Failed -- so a lock we ourselves just took would be
   * reported as held by somebody else. Failing there is honest; retrying is a
   * lie. Every other call here is safe to repeat.
   */
  private async retrying<T>(what: string, run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || !isRetryableAwsError(err)) throw err;
        const wait = BASE_DELAY_MS * 2 ** (attempt - 1);
        const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
        this.onRetry?.(`  s3 ${what}: ${why} -- retrying in ${wait / 1000}s (${attempt}/${MAX_ATTEMPTS - 1})`);
        await new Promise((done) => setTimeout(done, wait));
      }
    }
  }

  private full(key: string): string {
    const clean = key.replace(/^\/+/, '');
    return this.prefix ? `${this.prefix}/${clean}` : clean;
  }

  private strip(fullKey: string): string {
    return this.prefix && fullKey.startsWith(this.prefix + '/')
      ? fullKey.slice(this.prefix.length + 1)
      : fullKey;
  }

  async putBuffer(key: string, body: Buffer, contentType?: string): Promise<void> {
    await this.retrying(`put ${key}`, () =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.full(key),
          Body: body,
          ...(contentType ? { ContentType: contentType } : {}),
        }),
      ),
    );
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    try {
      const res = await this.retrying(`get ${key}`, () =>
        this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.full(key) })),
      );
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async putJson(key: string, data: unknown): Promise<void> {
    await this.putBuffer(
      key,
      Buffer.from(JSON.stringify(data, null, 2), 'utf8'),
      'application/json; charset=utf-8',
    );
  }

  async getJson<T>(key: string): Promise<T | null> {
    const buf = await this.getBuffer(key);
    if (!buf) return null;
    try {
      return JSON.parse(buf.toString('utf8')) as T;
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.head(key)) !== null;
  }

  async head(key: string): Promise<ObjectMeta | null> {
    try {
      const res = await this.retrying(`head ${key}`, () =>
        this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.full(key) })),
      );
      return {
        key,
        size: res.ContentLength ?? 0,
        lastModified: res.LastModified ?? new Date(0),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async listPrefixes(prefix: string): Promise<string[]> {
    const base = this.full(prefix).replace(/\/*$/, '/');
    const out: string[] = [];
    let token: string | undefined;

    do {
      const res = await this.retrying(`list ${prefix}`, () =>
        this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: base,
            Delimiter: '/',
            ContinuationToken: token,
          }),
        ),
      );
      for (const cp of res.CommonPrefixes ?? []) {
        if (!cp.Prefix) continue;
        out.push(cp.Prefix.slice(base.length).replace(/\/$/, ''));
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    return out.filter(Boolean);
  }

  async listObjects(prefix: string): Promise<ObjectMeta[]> {
    const base = this.full(prefix);
    const out: ObjectMeta[] = [];
    let token: string | undefined;

    do {
      const res = await this.retrying(`list ${prefix}`, () =>
        this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: base,
            ContinuationToken: token,
          }),
        ),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        out.push({
          key: this.strip(obj.Key),
          size: obj.Size ?? 0,
          lastModified: obj.LastModified ?? new Date(0),
        });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    return out;
  }

  async remove(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      await this.retrying(`delete ${batch.length} object(s)`, () =>
        this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: batch.map((k) => ({ Key: this.full(k) })), Quiet: true },
          }),
        ),
      );
    }
  }

  async readTagged<T>(key: string): Promise<{ data: T; tag: string } | null> {
    try {
      const res = await this.retrying(`get ${key}`, () =>
        this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.full(key) })),
      );
      if (!res.Body || !res.ETag) return null;
      const buf = Buffer.from(await res.Body.transformToByteArray());
      return { data: JSON.parse(buf.toString('utf8')) as T, tag: res.ETag };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Conditional put via S3's own preconditions.
   *
   * `IfNoneMatch: '*'` creates only when absent; `IfMatch: <etag>` updates only
   * when unchanged. Both answer 412 when the precondition fails, which is the
   * signal that another scanner got there first -- returned as false rather than
   * thrown, because a lost baseline race is a reportable outcome, not a crash.
   */
  async putJsonConditional(key: string, data: unknown, expectedTag: string | null): Promise<boolean> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.full(key),
          Body: Buffer.from(JSON.stringify(data, null, 2), 'utf8'),
          ContentType: 'application/json; charset=utf-8',
          ...(expectedTag === null ? { IfNoneMatch: '*' } : { IfMatch: expectedTag }),
        }),
      );
      return true;
    } catch (err) {
      if (isPreconditionFailed(err)) return false;
      throw err;
    }
  }

  async presign(key: string, expiresSeconds: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: this.full(key) }),
      { expiresIn: Math.min(expiresSeconds, MAX_PRESIGN_SECONDS) },
    );
  }
}

function statusOf(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function nameOf(err: unknown): string {
  return (err as { name?: string })?.name ?? '';
}

function isNotFound(err: unknown): boolean {
  return statusOf(err) === 404 || nameOf(err) === 'NoSuchKey' || nameOf(err) === 'NotFound';
}

function isPreconditionFailed(err: unknown): boolean {
  const status = statusOf(err);
  // 409 shows up when two conditional creates race each other rather than
  // racing an existing object; both mean "someone else won".
  return status === 412 || status === 409 || nameOf(err) === 'PreconditionFailed';
}
