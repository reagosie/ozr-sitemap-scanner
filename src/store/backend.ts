/**
 * The storage seam.
 *
 * Everything a run produces -- screenshots, JSON, reports -- goes through this
 * interface, so the pipeline never knows whether it is writing to a laptop or to
 * S3. Two implementations: `local.ts` (development, offline, and the fallback
 * when no bucket is configured) and `s3.ts` (the shared central store).
 *
 * KEYS ARE ALWAYS FORWARD-SLASHED and relative to the backend's root. The local
 * backend translates them to platform paths; nothing above this layer may build
 * a path with `path.join` or it will produce keys that work on one backend only.
 */

export interface ObjectMeta {
  key: string;
  size: number;
  lastModified: Date;
}

export interface StorageBackend {
  /** For log lines and manifests: `runs/` or `s3://bucket/data`. */
  readonly describe: string;

  /** True when `presign` produces a URL usable off this machine. */
  readonly canPresign: boolean;

  putBuffer(key: string, body: Buffer, contentType?: string): Promise<void>;
  getBuffer(key: string): Promise<Buffer | null>;

  putJson(key: string, data: unknown): Promise<void>;
  getJson<T>(key: string): Promise<T | null>;

  exists(key: string): Promise<boolean>;
  head(key: string): Promise<ObjectMeta | null>;

  /**
   * Immediate child "directories" of a prefix, without their trailing slash.
   *
   * Kept distinct from `listObjects` because listing every run of a host means
   * listing ~3,000 blob keys otherwise -- on S3 that is real latency and real
   * request cost for a `runs` command that wants six names.
   */
  listPrefixes(prefix: string): Promise<string[]>;

  /** Every object at or under a prefix, recursively. */
  listObjects(prefix: string): Promise<ObjectMeta[]>;

  remove(keys: string[]): Promise<void>;

  /**
   * Conditional JSON write, for state two scanners can race on.
   *
   * `expectedTag` is a tag from a previous `readTagged`, or null meaning "only
   * if this key does not exist yet". Returns false when the precondition failed
   * -- the caller reports the conflict rather than clobbering the other run.
   */
  putJsonConditional(key: string, data: unknown, expectedTag: string | null): Promise<boolean>;

  /** JSON plus the tag to pass back to `putJsonConditional`. */
  readTagged<T>(key: string): Promise<{ data: T; tag: string } | null>;

  /**
   * Time-limited URL for a key.
   *
   * Used by the emailable report so a recipient without AWS credentials can
   * still open a full-size screenshot. AWS caps IAM-user signatures at 7 days;
   * `expiresSeconds` above that is clamped, not rejected.
   */
  presign(key: string, expiresSeconds: number): Promise<string>;
}

/** Join key segments without ever producing `//` or a leading slash. */
export function joinKey(...parts: (string | number)[]): string {
  return parts
    .map((p) => String(p).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}
