'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

const APP_ORIGIN = 'studio://app';
const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.wasm':'application/wasm','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf'};
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https:; media-src 'self' blob: data: https:; font-src 'self' data:; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'";
function isTrustedAppUrl(value) {
  try {const url = new URL(value);return url.protocol === 'studio:' && url.hostname === 'app' && !url.port && !url.username && !url.password && ['/', '/index.html'].includes(url.pathname);} catch {return false;}
}
function isSafeExternalUrl(value) {
  try {const url = new URL(value);return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !/[\u0000-\u0020\u007f]/u.test(value) && value.length <= 4096;} catch {return false;}
}
function resolveAsset(root, value) {
  const url = new URL(value);
  if (url.protocol !== 'studio:' || url.hostname !== 'app' || url.port || url.username || url.password) return null;
  let pathname;try {pathname = decodeURIComponent(url.pathname);} catch {return null;}
  if (pathname.includes('\\') || /[\u0000-\u001f\u007f]/u.test(pathname) || pathname.split('/').some(part => part === '..' || part.startsWith('.'))) return null;
  const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  return target.startsWith(path.resolve(root) + path.sep) && Object.hasOwn(MIME, path.extname(target).toLowerCase()) ? target : null;
}
function createProtocolHandler({root, fetchFile} = {}) {
  const absolute = path.resolve(root);
  return async request => {
    if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed', {status:405});
    let target;try {target = resolveAsset(absolute, request.url);} catch {}
    if (!target) return new Response('Not found', {status:404});
    try {
      const realRoot = await fs.realpath(absolute), real = await fs.realpath(target), stat = await fs.stat(real);
      if (!real.startsWith(realRoot + path.sep) || !stat.isFile()) return new Response('Not found', {status:404});
      const response = await fetchFile(pathToFileURL(real).href), headers = new Headers(response.headers);
      headers.set('Content-Type', MIME[path.extname(real).toLowerCase()]);headers.set('Content-Security-Policy', CSP);headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');
      return new Response(request.method === 'HEAD' ? null : response.body, {status:response.status, headers});
    } catch {return new Response('Not found', {status:404});}
  };
}
module.exports = {APP_ORIGIN,CSP,MIME,isTrustedAppUrl,isSafeExternalUrl,resolveAsset,createProtocolHandler};
