// Wave 14, lane B -- a static file server that honours the Range header.
//
// This exists because `python3 -m http.server` does NOT, and CheerpJ refuses to
// start without it. Measured, not assumed:
//
//   Network error for http://127.0.0.1:8731/probe.jar: HTTP server does not
//   support the 'Range' header. CheerpJ cannot run.
//
// CheerpJ reads jars by seeking to the central directory rather than downloading
// the whole archive, which is what makes a 39 MB Forge jar tolerable -- and is
// also a hard requirement on whatever serves it. See docs/spikes/cheerpj.md.
//
//   node serve.mjs <dir> <port>
//
// SPIKE_LOG_REQUESTS=1 logs every request and its Range header to stderr, which
// is how docs/spikes/cheerpj.md's claim about CheerpJ seeking to a jar's central
// directory was obtained.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8731);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.jar': 'application/java-archive',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};

http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = path.resolve(root, rel || 'index.html');
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }

  if (process.env.SPIKE_LOG_REQUESTS === '1') {
    console.error(`REQ ${req.method} ${req.url} range=${req.headers.range || '-'}`);
  }

  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404).end('not found'); return; }
  if (st.isDirectory()) { res.writeHead(404).end('not found'); return; }

  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };

  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    let start = m[1] === '' ? st.size - Number(m[2]) : Number(m[1]);
    let end = m[1] === '' ? st.size - 1 : (m[2] === '' ? st.size - 1 : Number(m[2]));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= st.size) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${st.size}` }).end();
      return;
    }
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Content-Length': end - start + 1,
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...base, 'Content-Length': st.size });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.error(`serving ${root} on http://127.0.0.1:${port} (Range supported)`);
});
