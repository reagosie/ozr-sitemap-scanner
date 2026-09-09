import type { Config } from '../config.js';
import type { StorageBackend } from './backend.js';

export interface Backends {
  /** Runs, screenshots, metadata. */
  data: StorageBackend;
  /** Emailable HTML and PDF. Separate prefix so it can outlive the raw data. */
  reports: StorageBackend;
  /** True when runs are shared rather than laptop-local. */
  central: boolean;
}

/**
 * Resolve the bucket from the environment first, then config.
 *
 * The env var exists so a teammate can point at the bucket without editing a
 * committed config file, and so CI can override it.
 */
export function resolveBucket(config: Config): string | undefined {
  return process.env.SITEMAP_SCANNER_BUCKET || config.storage.bucket || undefined;
}

/**
 * Build the backends for this run.
 *
 * The S3 SDK is imported lazily: it pulls in a large dependency tree, and
 * `scan --discover-only` on a local backend should not pay for it.
 */
export async function createBackends(config: Config): Promise<Backends> {
  const bucket = resolveBucket(config);
  const mode = config.storage.backend;

  const wantS3 = mode === 's3' || (mode === 'auto' && Boolean(bucket));

  if (wantS3) {
    if (!bucket) {
      throw new Error(
        'storage.backend is "s3" but no bucket is configured. ' +
          'Set storage.bucket in scanner.config.json or SITEMAP_SCANNER_BUCKET.',
      );
    }
    const { S3Backend } = await import('./s3.js');
    return {
      data: new S3Backend({ bucket, region: config.storage.region, prefix: config.storage.dataPrefix }),
      reports: new S3Backend({
        bucket,
        region: config.storage.region,
        prefix: config.storage.reportsPrefix,
      }),
      central: true,
    };
  }

  const { LocalBackend } = await import('./local.js');
  const root = config.storage.localRoot;
  return {
    data: new LocalBackend(root),
    reports: new LocalBackend(`${root}/_reports`),
    central: false,
  };
}
