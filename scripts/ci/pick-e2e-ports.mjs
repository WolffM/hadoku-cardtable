// Free loopback ports for one job's e2e stacks, printed as CARDTABLE_E2E_*_PORT lines.
// With no arguments, all four, for `$GITHUB_ENV` (ci.yml's `e2e` and forge.yml's
// `forge-e2e` and `e2e-nightly`). With names as arguments, just those: `e2e/ports.ts`
// runs it that way for whichever of the four a process was not handed, so a local run,
// the monkey and the promo rig get ports of their own too.
//
// Chosen fresh per job instead of a fixed range: several jobs can run on one claw at
// once, maybe for different refs, so a fixed range collides (CI run 40121609776: the
// draft e2e's 19108 was already bound). Each is a random port BELOW the kernel's
// ephemeral range, checked free by binding it once. Not port 0: that hands out an
// ephemeral port, and once released any outbound connection on the claw can take it as
// its source port. The harness binds a port only when a spec starts a stack, so the gap
// is minutes, not milliseconds: run 39861790052's play edge, 44821, sat unbound through
// twelve draft tests and was taken by the thirteenth (EADDRINUSE). Below the range only
// another job's listener can collide, and that shows up as a loud bind failure, never a
// silent wrong port. A port one of the four already holds in this environment is never
// picked again, bound yet or not.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';

const ALL = ['CARDTABLE_E2E_SERVER_PORT', 'CARDTABLE_E2E_PLAY_SERVER_PORT', 'CARDTABLE_E2E_EDGE_PORT', 'CARDTABLE_E2E_PLAY_EDGE_PORT'];
const names = process.argv.length > 2 ? process.argv.slice(2) : ALL;
const unknown = names.filter((n) => !ALL.includes(n));
if (unknown.length > 0) {
  console.error(`pick-e2e-ports: not an e2e port: ${unknown.join(', ')}`);
  process.exit(2);
}
const low = Number(readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0]);
const taken = new Set(ALL.filter((n) => !names.includes(n)).map((n) => Number(process.env[n])).filter((p) => p > 0));

function free(port) {
  return new Promise((done) => {
    const s = createServer();
    s.once('error', () => done(false));
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)));
  });
}

const ports = [];
while (ports.length < names.length) {
  const port = 20000 + Math.floor(Math.random() * (low - 20000));
  if (!taken.has(port) && !ports.includes(port) && (await free(port))) ports.push(port);
}
for (const [i, name] of names.entries()) console.log(`${name}=${ports[i]}`);
