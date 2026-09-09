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

export class S3Backend implements StorageBackend {
  readonly describe: string;
  readonly canPresign = true;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;

  constructor(opts: S3BackendOptions) {
    this.bucket = opts.bucket;
    this.prefix = (opts.prefix ?? '').replace(/^\/+|\/+$/g, '');
    this.client = new S3Client({ region: opts.region });
    this.describe = `s3://${this.bucket}${this.prefix ? '/' + this.prefix : ''}`;
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
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.full(key),
        Body: body,
        ...(contentType ? { ContentType: contentType } : {}),
      }),
    );
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.full(key) }),
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
      const res = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.full(key) }),
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
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: base,
          Delimiter: '/',
          ContinuationToken: token,
        }),
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
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: base,
          ContinuationToken: token,
        }),
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
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((k) => ({ Key: this.full(k) })), Quiet: true },
        }),
      );
    }
  }

  async readTagged<T>(key: string): Promise<{ data: T; tag: string } | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.full(key) }),
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
