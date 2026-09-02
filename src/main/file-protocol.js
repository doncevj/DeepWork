/* ---------------------------------------------------------------------------
   The lockdown:// protocol.

   Two hostnames:
     lockdown://app/<path>   application assets, plus pdf.js under /vendor/
     lockdown://file/<id>    a file from the current session, by opaque id

   Serving the window over a real scheme rather than file:// matters for more
   than tidiness: Chromium refuses to start Web Workers on a file:// page, and
   pdf.js wants one. It also gives CSP a real origin for 'self' to mean.

   Nothing here resolves a path the renderer supplied. The renderer only ever
   knows ids; the id-to-path map is set by the main process when a session
   starts, so an id that isn't in this session's list cannot be read.
   ------------------------------------------------------------------------ */

const { protocol, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const SCHEME = 'lockdown';

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

// pdfjs-dist has no "exports" map, so a direct subpath resolve works.
let VENDOR_DIR = null;
try {
  VENDOR_DIR = path.dirname(require.resolve('pdfjs-dist/build/pdf.mjs'));
} catch {
  console.error('[DeepWork] pdfjs-dist not found — run `npm install pdfjs-dist`');
}

const ASSET_TYPES = new Map([
  ['.html', 'text/html'],
  ['.css', 'text/css'],
  ['.js', 'text/javascript'],
  ['.mjs', 'text/javascript'],
  ['.map', 'application/json'],
  ['.json', 'application/json'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.woff2', 'font/woff2']
]);

const FILE_TYPES = new Map([
  ['.pdf', 'application/pdf'],
  ['.mp4', 'video/mp4']
]);

// id -> absolute path. Replaced wholesale at the start of each session.
let allowlist = new Map();

function setAllowlist(files) {
  allowlist = new Map(files.map((file) => [file.id, file.path]));
}

function clearAllowlist() {
  allowlist = new Map();
}

// Must run before app.whenReady().
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true, // range requests, which video seeking depends on
        corsEnabled: true
      }
    }
  ]);
}

function notFound() {
  return new Response('Not found', { status: 404 });
}

/**
 * Resolve a URL path inside a directory, refusing anything that climbs out.
 */
function safeJoin(baseDir, urlPath) {
  const decoded = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const resolved = path.resolve(baseDir, decoded);

  const withSep = baseDir.endsWith(path.sep) ? baseDir : baseDir + path.sep;
  if (!resolved.startsWith(withSep)) return null;

  return resolved;
}

function serveAsset(urlPath) {
  const isVendor = urlPath.startsWith('/vendor/');
  const baseDir = isVendor ? VENDOR_DIR : RENDERER_DIR;
  if (!baseDir) return notFound();

  const relative = isVendor ? urlPath.slice('/vendor'.length) : urlPath;
  const filePath = safeJoin(baseDir, relative);
  if (!filePath || !fs.existsSync(filePath)) return notFound();

  const type = ASSET_TYPES.get(path.extname(filePath).toLowerCase())
    ?? 'application/octet-stream';

  return new Response(fs.readFileSync(filePath), {
    headers: { 'Content-Type': type }
  });
}

/**
 * Stream a session file, honouring Range so video seeking works and large PDFs
 * load progressively instead of arriving in one lump.
 */
function serveSessionFile(id, rangeHeader) {
  const filePath = allowlist.get(id);
  if (!filePath) return notFound();

  const type = FILE_TYPES.get(path.extname(filePath).toLowerCase());
  if (!type) return notFound(); // belt and braces; only pdf and mp4 get ids

  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return notFound();
  }

  const match = rangeHeader && /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());

  if (match) {
    const hasStart = match[1] !== '';
    const hasEnd = match[2] !== '';

    // "bytes=-500" means the last 500 bytes.
    let start = hasStart ? Number(match[1]) : size - Number(match[2]);
    let end = hasEnd && hasStart ? Number(match[2]) : size - 1;

    start = Math.max(0, Math.min(start, size - 1));
    end = Math.max(start, Math.min(end, size - 1));

    const stream = fs.createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes'
      }
    });
  }

  const stream = fs.createReadStream(filePath);
  return new Response(Readable.toWeb(stream), {
    headers: {
      'Content-Type': type,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes'
    }
  });
}

// Must run after app.whenReady().
function registerHandler() {
  protocol.handle(SCHEME, (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }

    if (url.hostname === 'app') return serveAsset(url.pathname);

    if (url.hostname === 'file') {
      const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      return serveSessionFile(id, request.headers.get('range'));
    }

    return notFound();
  });
}

module.exports = {
  SCHEME,
  registerScheme,
  registerHandler,
  setAllowlist,
  clearAllowlist,
  vendorAvailable: () => VENDOR_DIR !== null
};
