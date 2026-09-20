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
import crypto from 'node:crypto';
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

/*
 * A minimal RFC6455 echo endpoint at /echo, for the natives probe.
 *
 * Hand-rolled rather than `ws` from npm: this is a spike server that must not
 * add a dependency to the repo, and an echo that never fragments and never
 * needs extensions is about forty lines. It handles exactly what the probe
 * sends — one binary frame under 126 bytes — and closes on anything else
 * rather than pretending to be a real implementation.
 */
function wsAccept(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function attachEcho(server) {
  server.on('upgrade', (req, socket) => {
    if (new URL(req.url, 'http://x').pathname !== '/echo') { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
    );
    socket.on('data', (buf) => {
      // FIN + opcode in byte 0; MASK + length in byte 1. Client frames are
      // always masked, which is the half a hand-rolled server usually gets
      // wrong, so unmask explicitly rather than assuming text.
      const opcode = buf[0] & 0x0f;
      if (opcode === 0x8) { socket.end(); return; }          // close
      const masked = (buf[1] & 0x80) !== 0;
      const len = buf[1] & 0x7f;
      if (len > 125 || !masked) { socket.end(); return; }     // out of scope, on purpose
      const mask = buf.subarray(2, 6);
      const data = Buffer.from(buf.subarray(6, 6 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      // Echo it back as binary, unmasked (server frames must not be masked).
      const out = Buffer.alloc(2 + data.length);
      out[0] = 0x82;            // FIN + binary
      out[1] = data.length;     // no mask, short length
      data.copy(out, 2);
      socket.write(out);
    });
    socket.on('error', () => socket.destroy());
  });
}

const server = http.createServer((req, res) => {
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
});

attachEcho(server);

server.listen(port, '127.0.0.1', () => {
  console.error(`serving ${root} on http://127.0.0.1:${port} (Range supported, ws /echo)`);
});
