import { spawn, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handoverFromEnv } from './server.ts';

/**
 * The kernel's half of the deploy handover (server.ts, "A socket handed over"), with real
 * processes. The test plays the supervisor (hadoku_site `services/pm2/lib/handover.py`): it holds
 * a listening socket, starts generations of a minimal game on it, and retires them with SIGTERM
 * while a poller hits the port. What a caller sees is the assertion: nothing refused, and a
 * request a generation took is answered by it.
 *
 * The socket is bound by a Python helper, not Node: a Node listener accepts on its own handle,
 * and would steal the connections the test means the generations to take.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'handover.fixture.ts');
const procs: ChildProcess[] = [];

afterEach(() => {
	for (const p of procs.splice(0)) if (p.exitCode === null) p.kill('SIGKILL');
});

/**
 * A miniature supervisor: a Python process that holds one listening socket and, told over stdin,
 * starts (`start <gen>`) or retires (`term <gen>`) generations of the fixture on it, reporting
 * `port <n>`, `ready <gen>` and `exit <gen> <code>` on stdout. Python, because a Node listener
 * accepts on its own handle and would steal the connections meant for the generations, and
 * because a socket cannot be reopened through /proc.
 */
const SUPERVISOR = `
import os, select, signal, socket, subprocess, sys, threading
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', 0)); s.listen(1024); s.set_inheritable(True)
print('port', s.getsockname()[1], flush=True)
gens = {}
def watch(gen, proc, r):
    if select.select([r], [], [], 60)[0] and os.read(r, 1):
        print('ready', gen, flush=True)
    os.close(r)
    print('exit', gen, proc.wait(), flush=True)
for line in sys.stdin:
    op, gen = line.split()
    if op == 'start':
        r, w = os.pipe()
        env = dict(os.environ, GEN=gen, HADOKU_LISTEN_FD=str(s.fileno()), HADOKU_READY_FD=str(w))
        proc = subprocess.Popen([sys.argv[1], sys.argv[2]], pass_fds=(s.fileno(), w), env=env)
        os.close(w)
        gens[gen] = proc
        threading.Thread(target=watch, args=(gen, proc, r), daemon=True).start()
    elif op == 'term':
        gens[gen].send_signal(signal.SIGTERM)
`;

interface Supervisor {
	port: number;
	start(gen: string): Promise<void>;
	/** SIGTERM, resolving with the exit code. */
	term(gen: string): Promise<number>;
	/** The exit code once the generation ends. */
	exitOf(gen: string): Promise<number>;
	/** Resolves once the generation has taken a `/slow` request (the fixture says `taken <gen>`). */
	taken(gen: string): Promise<void>;
}

async function supervisor(): Promise<Supervisor> {
	const proc = spawn('python3', ['-c', SUPERVISOR, process.execPath, FIXTURE], {
		stdio: ['pipe', 'pipe', 'inherit'],
	});
	procs.push(proc);
	const seen: string[] = [];
	const waiters: Array<{ re: RegExp; resolve: (m: RegExpMatchArray) => void }> = [];
	let buf = '';
	proc.stdout!.on('data', (d) => {
		buf += String(d);
		let i: number;
		while ((i = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			if (!/^(port|ready|exit|taken) /.test(line)) continue;
			seen.push(line);
			for (const w of [...waiters]) {
				const m = line.match(w.re);
				if (m) {
					waiters.splice(waiters.indexOf(w), 1);
					w.resolve(m);
				}
			}
		}
	});
	const next = (re: RegExp) =>
		new Promise<RegExpMatchArray>((resolve) => {
			for (const line of seen) {
				const m = line.match(re);
				if (m) return resolve(m);
			}
			waiters.push({ re, resolve });
		});
	const port = Number((await next(/^port (\d+)$/))[1]);
	const exitOf = async (gen: string) => Number((await next(new RegExp(`^exit ${gen} (-?\\d+)$`)))[1]);
	return {
		port,
		exitOf,
		taken: async (gen) => void (await next(new RegExp(`^taken ${gen}$`))),
		start: async (gen) => {
			proc.stdin!.write(`start ${gen}\n`);
			const outcome = await Promise.race([next(new RegExp(`^ready ${gen}$`)), exitOf(gen).then((c) => c)]);
			if (typeof outcome === 'number') throw new Error(`gen ${gen} exited ${outcome} before it was ready`);
		},
		term: (gen) => {
			proc.stdin!.write(`term ${gen}\n`);
			return exitOf(gen);
		},
	};
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: '127.0.0.1',
				port,
				path,
				agent: false,
				headers: { 'x-edge-auth': 'seal' },
			},
			(res) => {
				let body = '';
				res.on('data', (d) => (body += d));
				res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
			},
		);
		req.setTimeout(15_000, () => req.destroy(new Error('timeout')));
		req.on('error', reject);
		req.end();
	});
}

function poll(port: number): {
	errors: string[];
	ok: () => number;
	stop: () => Promise<void>;
} {
	const errors: string[] = [];
	let ok = 0;
	let running = true;
	const loop = (async () => {
		while (running) {
			try {
				const r = await get(port, '/health');
				if (r.status === 200) ok += 1;
				else errors.push(`HTTP ${r.status}`);
			} catch (err) {
				errors.push((err as Error).message);
			}
		}
	})();
	return {
		errors,
		ok: () => ok,
		stop: async () => void ((running = false), await loop),
	};
}

describe('createGameServer under a deploy handover', () => {
	it('reads the descriptors from the environment, and binds its own port without them', () => {
		expect(handoverFromEnv({})).toBeNull();
		expect(handoverFromEnv({ HADOKU_LISTEN_FD: '7', HADOKU_READY_FD: '8' })).toEqual({ listenFd: 7, readyFd: 8 });
		expect(handoverFromEnv({ HADOKU_LISTEN_FD: '7' })).toEqual({
			listenFd: 7,
			readyFd: null,
		});
		expect(() => handoverFromEnv({ HADOKU_LISTEN_FD: 'x' })).toThrow(/not a descriptor/);
	});

	it('serves the inherited socket, and a sequential handover refuses nobody', async () => {
		const sup = await supervisor();
		await sup.start('1');
		expect(await get(sup.port, '/health')).toMatchObject({ status: 200 });
		const p = poll(sup.port);
		await vi.waitFor(() => expect(p.ok()).toBeGreaterThan(5));
		// A request gen 1 has taken, still running when it is retired.
		const slow = get(sup.port, '/slow');
		await sup.taken('1');
		// Sequential, as cardtable runs it: retire, wait for the exit, then start the next.
		expect(await sup.term('1')).toBe(0);
		const before = p.ok();
		await sup.start('2');
		expect(await slow).toEqual({ status: 200, body: 'slow 1' });
		// Gen 2 is answering the poller too, before it stops.
		await vi.waitFor(() => expect(p.ok()).toBeGreaterThan(before + 5));
		await p.stop();
		expect(p.errors).toEqual([]);
		expect(p.ok()).toBeGreaterThan(10);
		expect(await sup.term('2')).toBe(0);
	}, 60_000);

	it('closes only its own copy: with no generation left, callers wait rather than being refused', async () => {
		const sup = await supervisor();
		await sup.start('1');
		expect(await sup.term('1')).toBe(0);
		// Made while nobody accepts; gen 2's whole boot happens while it waits.
		const waiting = get(sup.port, '/health');
		await sup.start('2');
		expect(await waiting).toMatchObject({ status: 200 });
		expect(await sup.term('2')).toBe(0);
	}, 60_000);
});
