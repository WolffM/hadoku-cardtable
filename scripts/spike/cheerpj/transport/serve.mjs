// Wave 15, lane A -- the server end of the round trip.
//
// Two jobs:
//
//   1. Serve the staged site with Range support. CheerpJ refuses to start
//      without it ("HTTP server does not support the 'Range' header"), which is
//      why `python3 -m http.server` is not an option. Same reason as the shared
//      harness's serve.mjs; this lane carries its own copy because three lanes
//      drive that harness concurrently and it is owned by nobody.
//
//   2. Terminate a WebSocket at /bridge and drive ONE scripted exchange against
//      the Forge client running inside CheerpJ.
//
// ## Why this file imports the real @hadoku/forge-wire
//
// A spike server that checked frames by hand would prove only that the bridge
// agrees with this file. Every inbound frame is run through the package's own
// `parseClientFrame` and every outbound frame through `parseServerFrame`, so
// "the wire it speaks is @hadoku/forge-wire's" is a check and not a claim.
// Node 24 strips the TypeScript itself; nothing is built and no dependency is
// added. The package is READ, never written -- it belongs to no lane this wave.
//
//   node serve.mjs <dir> <port>
//
// GET /__verdict returns the transcript and the pass/fail, which is what
// measure.mjs reads. GET /__reset clears it between runs.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const wire = await import(path.join(REPO, 'packages/forge-wire/src/index.ts'));

const root = path.resolve(process.argv[2] || '.');
const port = Number(process.argv[3] || 8741);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.jar': 'application/java-archive',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/* ── The transcript ──────────────────────────────────────────────────────
 *
 * Everything the browser sent, everything this file sent, and every schema
 * verdict. measure.mjs reads it; nothing here decides its own pass.
 */
const NONCE = crypto.randomBytes(8).toString('hex');

/*
 * Negative controls. A harness that cannot be made to fail has not been shown
 * to measure anything, and this repo has shipped that shape six times. Each of
 * these breaks exactly one thing and is expected to turn exactly one of
 * measure.mjs's checks red:
 *
 *   W15A_MUTATE=nonce          send a nonce other than the one /__verdict
 *                              reports          -> `nonce` must fail
 *   W15A_MUTATE=same-defaults  ask twice with the same defaultYes
 *                              -> `distinctReplies` must fail
 *
 * (The third control needs no code: run measure.mjs with a BUILD_ID that is not
 * the one run.sh just wrote, and `build` must fail.)
 */
const MUTATE = process.env.W15A_MUTATE || '';
let transcript = [];
let failures = [];

const note = (o) => { transcript.push({ t: Date.now(), ...o }); };
const fail = (why, detail) => { failures.push({ why, detail }); note({ dir: 'FAIL', why, detail }); };

/* ── RFC6455, the part a spike actually needs ────────────────────────────
 *
 * Unfragmented frames, client masking, 7-bit and 16-bit lengths, close and
 * ping. Deliberately NOT a WebSocket implementation: a 64-bit length or a
 * continuation frame closes the socket loudly rather than being half-handled.
 * Hand-rolled because this spike must not add an npm dependency to the repo.
 */
function wsAccept(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}

function encodeFrame(payload, opcode = 0x2) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    throw new Error(`frame of ${len} B is out of this spike's scope`);
  }
  return Buffer.concat([head, payload]);
}

/** Pulls whole frames out of an accumulating buffer. Returns [frames, rest]. */
function decodeFrames(buf, onProtocolError) {
  const out = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      onProtocolError('64-bit frame length is out of this spike\'s scope');
      return [out, Buffer.alloc(0)];
    }
    if (!fin) {
      onProtocolError('fragmented frame is out of this spike\'s scope');
      return [out, Buffer.alloc(0)];
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length - p < maskLen + len) break;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    p += maskLen;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    p += len;
    off = p;
    out.push({ opcode, data });
  }
  return [out, buf.subarray(off)];
}

/* ── The scripted exchange ───────────────────────────────────────────────
 *
 * Every frame this file sends is validated against the package's own
 * ServerFrameSchema BEFORE it goes out, so the client is never asked to parse
 * something the contract would not allow.
 */
function bridge(socket) {
  const send = (frame) => {
    const parsed = wire.safeParseServerFrame(frame);
    if (!parsed.ok) {
      fail('server frame this file built is not a valid ServerFrame', { frame, errors: parsed.errors });
      return;
    }
    note({ dir: 'S2C', frame });
    socket.write(encodeFrame(Buffer.from(JSON.stringify(frame), 'utf8')));
  };

  const onClientFrame = (raw) => {
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      fail('client sent something that is not JSON', { raw: raw.slice(0, 400) });
      return;
    }
    const parsed = wire.safeParseClientFrame(json);
    if (!parsed.ok) {
      fail('client frame failed @hadoku/forge-wire validation', { json, errors: parsed.errors });
      note({ dir: 'C2S', frame: json, valid: false });
      return;
    }
    const f = parsed.value;
    note({ dir: 'C2S', frame: f, valid: true });
    step(f);
  };

  /*
   * The script. Each arrow is a real ProtocolMethod in a real envelope frame.
   *
   *   act selectButtonOk   ->   notify message (carrying a nonce this process minted)
   *   act useMana color=3  ->   ask showConfirmDialog x2, defaultYes true then false
   *   reply x2             ->   notify showPromptMessage (Tier B: must be REFUSED)
   *                             notify finishGame
   *   act concede          ->   done
   */
  const step = (f) => {
    if (f.kind === 'act' && f.method === 'selectButtonOk') {
      const nonce = MUTATE === 'nonce' ? crypto.randomBytes(8).toString('hex') : NONCE;
      send({ kind: 'notify', method: 'message', message: `w15a-nonce:${nonce}`, title: 'w15a' });
      return;
    }
    if (f.kind === 'act' && f.method === 'useMana') {
      if (f.color !== 3) fail('useMana carried the wrong byte', { got: f.color, want: 3 });
      send({
        kind: 'ask', callId: 'w15a-c1', method: 'showConfirmDialog',
        message: 'first ask', title: 'w15a', yesButtonText: 'Yes', noButtonText: 'No', defaultYes: true,
      });
      send({
        kind: 'ask', callId: 'w15a-c2', method: 'showConfirmDialog',
        message: 'second ask', title: 'w15a', yesButtonText: 'Yes', noButtonText: 'No',
        defaultYes: MUTATE === 'same-defaults',
      });
      return;
    }
    if (f.kind === 'reply' && f.callId === 'w15a-c1') {
      if (f.result !== true) fail('reply to the defaultYes=true ask was not true', { got: f.result });
      return;
    }
    if (f.kind === 'reply' && f.callId === 'w15a-c2') {
      if (f.result !== false) fail('reply to the defaultYes=false ask was not false', { got: f.result });
      // A LEGAL Tier B frame the bridge does not model. It must be refused by
      // name on the Java side, not silently eaten -- measure.mjs checks the log.
      send({
        kind: 'notify', method: 'showPromptMessage',
        player: { kind: 'player', id: 1 }, message: 'tier B, deliberately', card: null,
      });
      send({ kind: 'notify', method: 'finishGame' });
      return;
    }
    if (f.kind === 'act' && f.method === 'requestResync') {
      // The latency loop: the cheapest legal act, answered by the cheapest
      // legal notify, so what is measured is the transport and not a codec.
      send({ kind: 'notify', method: 'clearSelectables' });
      return;
    }
    if (f.kind === 'act' && f.method === 'concede') {
      note({ dir: 'DONE' });
      return;
    }
    fail('unexpected client frame at this point in the script', { frame: f });
  };

  let pending = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const [frames, rest] = decodeFrames(pending, (why) => { fail(why); socket.destroy(); });
    pending = rest;
    for (const { opcode, data } of frames) {
      if (opcode === 0x8) { socket.end(); return; }            // close
      if (opcode === 0x9) { socket.write(encodeFrame(data, 0xa)); continue; } // ping -> pong
      if (opcode === 0x1 || opcode === 0x2) onClientFrame(data.toString('utf8'));
    }
  });
  socket.on('error', () => socket.destroy());
}

/* ── HTTP ────────────────────────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');

  if (url.pathname === '/__verdict') {
    const sawDone = transcript.some((e) => e.dir === 'DONE');
    const body = JSON.stringify({
      nonce: NONCE,
      mutation: MUTATE || null,
      ok: failures.length === 0 && sawDone,
      sawDone,
      failures,
      counts: {
        c2s: transcript.filter((e) => e.dir === 'C2S').length,
        s2c: transcript.filter((e) => e.dir === 'S2C').length,
      },
      transcript,
    }, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }).end(body);
    return;
  }
  if (url.pathname === '/__reset') {
    transcript = [];
    failures = [];
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('reset\n');
    return;
  }

  const file = path.resolve(root, rel || 'index.html');
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }

  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404).end('not found'); return; }
  if (st.isDirectory()) { res.writeHead(404).end('not found'); return; }

  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };

  const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim());
  if (m) {
    const start = m[1] === '' ? st.size - Number(m[2]) : Number(m[1]);
    const end = m[1] === '' ? st.size - 1 : (m[2] === '' ? st.size - 1 : Number(m[2]));
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= st.size) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${st.size}` }).end();
      return;
    }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...base, 'Content-Length': st.size });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
});

server.on('upgrade', (req, socket) => {
  if (new URL(req.url, 'http://x').pathname !== '/bridge') { socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string') { socket.destroy(); return; }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`,
  );
  note({ dir: 'OPEN' });
  bridge(socket);
});

server.listen(port, '127.0.0.1', () => {
  console.error(`w15a bridge: ${root} on http://127.0.0.1:${port} (Range, ws /bridge), nonce=${NONCE}`
    + (MUTATE ? ` MUTATION=${MUTATE}` : ''));
  console.error(`forge-wire: ${wire.REQUIRED_METHODS.length} methods, ${wire.BLOCKING_METHODS.length} blocking`);
});
