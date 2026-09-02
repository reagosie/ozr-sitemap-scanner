import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/**
 * Static server rooted at the HOST directory (runs/<host>), not the run.
 *
 * The report links to its baseline's screenshots via ../../<baselineId>/shots/,
 * so serving the run directory alone would 404 every "before" image. Serving
 * full-size PNGs over HTTP is also why the report references images by path
 * instead of inlining them -- a run holds well over a gigabyte of them, and the
 * browser only fetches the handful the reviewer actually expands.
 */
export async function serveRun(hostRoot: string, runId: string, port = 4173): Promise<string> {
  const root = path.resolve(hostRoot);

  const server = http.createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
      const target = path.resolve(root, '.' + urlPath);

      // Never serve outside the host directory.
      if (target !== root && !target.startsWith(root + path.sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }

      const info = await stat(target).catch(() => null);
      if (!info) {
        res.writeHead(404).end('not found');
        return;
      }

      const file = info.isDirectory() ? path.join(target, 'index.html') : target;
      const fileInfo = info.isDirectory() ? await stat(file).catch(() => null) : info;
      if (!fileInfo || !fileInfo.isFile()) {
        res.writeHead(404).end('not found');
        return;
      }

      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': fileInfo.size,
        'Cache-Control': 'no-cache',
      });
      createReadStream(file).pipe(res);
    } catch (err) {
      res.writeHead(500).end(err instanceof Error ? err.message : 'error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });

  return `http://localhost:${port}/${runId}/report/index.html`;
}
