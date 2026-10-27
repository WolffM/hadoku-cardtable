#!/usr/bin/env node
/*
 * One signed request to the §A test agent (agent.mjs has the scheme).
 *
 *   AGENT_KEY=<private pem> node call.mjs <node> <METHOD> <path> [<json> | @<file>]
 *
 * A file body is streamed, and its sha256 is the path's (PUT /blob/<sha>).
 */
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { request } from 'node:http';

const [node, method, path, body = ''] = process.argv.slice(2);
if (!node || !method || !path) {
  console.error('usage: call.mjs <node> <METHOD> <path> [<json> | @<file>]');
  process.exit(2);
}
const key = createPrivateKey(readFileSync(process.env.AGENT_KEY ?? '', 'utf8'));
const file = body.startsWith('@') ? body.slice(1) : null;
const bytes = file ? null : Buffer.from(body);
const sha = file
  ? await new Promise((resolve, reject) => {
      const h = createHash('sha256');
      createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    })
  : createHash('sha256').update(bytes).digest('hex');
const ts = Date.now();
const sig = sign(null, Buffer.from(`${method}\n${path}\n${ts}\n${sha}`), key).toString('base64');
const req = request({ host: node, port: Number(process.env.AGENT_PORT ?? 7621), method, path, headers: { 'x-agent-ts': ts, 'x-agent-body': sha, 'x-agent-sig': sig } }, (res) => {
  let out = '';
  res.on('data', (c) => (out += c));
  res.on('end', () => {
    process.stdout.write(out);
    process.exitCode = res.statusCode === 200 ? 0 : 1;
  });
});
req.on('error', (e) => {
  console.error(`call: ${e.message}`);
  process.exitCode = 1;
});
if (file) createReadStream(file).pipe(req);
else req.end(bytes);
