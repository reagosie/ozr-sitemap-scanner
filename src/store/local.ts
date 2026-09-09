import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ObjectMeta, StorageBackend } from './backend.js';

/**
 * Filesystem backend -- the original behavior, behind the interface.
 *
 * Kept after the move to S3 rather than deleted: it is what makes the tool
 * runnable with nothing but Node, which is a stated requirement, and it is what
 * the tests and the fast edit-test loop run against.
 */
export class LocalBackend implements StorageBackend {
  readonly describe: string;
  readonly canPresign = false;

  constructor(private readonly root: string) {
    this.describe = root;
  }

  private resolve(key: string): string {
    const target = path.resolve(this.root, ...key.split('/').filter(Boolean));
    // A key is never allowed to escape the root. Keys are internally generated,
    // but they embed hostnames and URL-derived slugs, so this is cheap insurance.
    const root = path.resolve(this.root);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`key escapes storage root: ${key}`);
    }
    return target;
  }

  async putBuffer(key: string, body: Buffer): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(key));
    } catch {
      return null;
    }
  }

  async putJson(key: string, data: unknown): Promise<void> {
    await this.putBuffer(key, Buffer.from(JSON.stringify(data, null, 2), 'utf8'));
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
      const info = await stat(this.resolve(key));
      if (!info.isFile()) return null;
      return { key, size: info.size, lastModified: info.mtime };
    } catch {
      return null;
    }
  }

  async listPrefixes(prefix: string): Promise<string[]> {
    try {
      const items = await readdir(this.resolve(prefix), { withFileTypes: true });
      return items.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  }

  async listObjects(prefix: string): Promise<ObjectMeta[]> {
    const base = this.resolve(prefix);
    const out: ObjectMeta[] = [];

    const walk = async (dir: string): Promise<void> => {
      let items;
      try {
        items = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
          await walk(full);
        } else if (item.isFile()) {
          const info = await stat(full);
          const rel = path.relative(this.root, full).split(path.sep).join('/');
          out.push({ key: rel, size: info.size, lastModified: info.mtime });
        }
      }
    };

    await walk(base);
    return out;
  }

  async remove(keys: string[]): Promise<void> {
    for (const key of keys) {
      await rm(this.resolve(key), { force: true, recursive: true });
    }
  }

  /**
   * Tag is a content hash rather than an mtime.
   *
   * On one machine the race this guards against cannot really happen, but the
   * semantics have to match S3's or the S3 path would be the only one ever
   * exercised and its conflict handling would go untested.
   */
  async readTagged<T>(key: string): Promise<{ data: T; tag: string } | null> {
    const buf = await this.getBuffer(key);
    if (!buf) return null;
    try {
      return {
        data: JSON.parse(buf.toString('utf8')) as T,
        tag: createHash('sha256').update(buf).digest('hex'),
      };
    } catch {
      return null;
    }
  }

  async putJsonConditional(key: string, data: unknown, expectedTag: string | null): Promise<boolean> {
    const current = await this.getBuffer(key);
    if (expectedTag === null) {
      if (current) return false;
    } else {
      if (!current) return false;
      if (createHash('sha256').update(current).digest('hex') !== expectedTag) return false;
    }
    await this.putJson(key, data);
    return true;
  }

  /**
   * A file:// URL. Works in a browser on THIS machine only, which is why
   * `canPresign` is false -- the emailable report must not embed these and
   * pretend a recipient can open them.
   */
  async presign(key: string): Promise<string> {
    return pathToFileURL(this.resolve(key)).href;
  }
}
