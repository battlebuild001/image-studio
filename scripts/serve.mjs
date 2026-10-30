import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { createScriptApi } from './script-api.mjs';
import { createImageApi } from './image-api.mjs';
import { createImagePlanApi } from './image-plan-api.mjs';
import { createTranscriptApi } from './transcript-api.mjs';
import { createVoiceApi } from './voice-api.mjs';
import { createBackendAccess } from './backend-access.mjs';

const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: process.env.PORT || '4173' },
  },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('--port must be an integer between 1 and 65535.');
}
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const rootPath = resolve(root);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
};
const handleScriptApi = createScriptApi();
const handleImageApi = createImageApi();
const handleImagePlanApi = createImagePlanApi();
const handleTranscriptApi = createTranscriptApi();
const handleVoiceApi = createVoiceApi();
const handleAccess = createBackendAccess({publicMode: !['127.0.0.1', 'localhost', '::1'].includes(values.host)});

const server = http.createServer(async (req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (handleAccess(req, res, pathname)) return;
  if (await handleScriptApi(req, res, pathname)) return;
  if (await handleImagePlanApi(req, res, pathname)) return;
  if (await handleImageApi(req, res, pathname)) return;
  if (await handleTranscriptApi(req, res, pathname)) return;
  if (await handleVoiceApi(req, res, pathname)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  const path = resolve(rootPath, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!path.startsWith(rootPath + sep) || pathname.includes('\0')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': types[extname(path)] || 'application/octet-stream',
      'Content-Length': body.byteLength,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch (error) {
    const missing = ['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code);
    res.writeHead(missing ? 404 : 500).end(missing ? 'Not found' : 'Server error');
  }
});

server.on('error', error => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, values.host, () => {
  console.log(`BTH BLKOUT Image Studio: http://${values.host}:${port}/`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close());
}
