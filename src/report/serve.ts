import http from 'node:http';
import { joinKey, type StorageBackend } from '../store/backend.js';
import { hostDir } from '../store/runs.js';

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  pdf: 'application/pdf',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
};

/**
 * Serve a run's report, streaming images out of the backend.
 *
 * Rooted at the HOST prefix, not the run: the report links to screenshots as
 * `../blobs/<sha>.png`, and those blobs are shared by every run of this site.
 * Serving the run alone would 404 every image.
 *
 * This is also how a private S3 bucket stays private. Rather than making
 * objects public or minting presigned URLs for 1,500 images, the reviewer's own
 * AWS credentials fetch them through this process, and nothing is exposed.
 */
export async function serveRun(
  backend: StorageBackend,
  origin: string,
  runId: string,
  port = 4173,
): Promise<string> {
  const root = hostDir(origin);

  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
      const segments = urlPath.split('/').filter(Boolean);

      // No `..` may survive into a key. Keys are backend-relative and the
      // backends resolve them literally, so this is the only place to stop it.
      if (segments.some((s) => s === '..' || s === '.')) {
        res.writeHead(400).end('bad path');
        return;
      }

      const key = segments.length ? joinKey(root, ...segments) : joinKey(root, runId, 'report.html');
      const buf = await backend.getBuffer(key);

      if (!buf) {
        res.writeHead(404).end(`not found: ${key}`);
        return;
      }

      const ext = key.split('.').pop()?.toLowerCase() ?? '';
      res.writeHead(200, {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
        'Content-Length': buf.length,
        // Blobs are immutable by construction -- the key IS the content hash --
        // so they can be cached hard. Everything else may be rebuilt in place.
        'Cache-Control': segments[0] === 'blobs' ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      res.end(buf);
    } catch (err) {
      res.writeHead(500).end(err instanceof Error ? err.message : 'error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });

  return `http://localhost:${port}/${runId}/report.html`;
}
