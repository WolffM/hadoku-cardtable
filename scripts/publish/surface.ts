// Refuses a patch release whose types would break a consumer that built on the version before it:
//
//   node scripts/publish/surface.ts packages/<name>
//   node scripts/publish/surface.ts --before <unpacked package> --after <unpacked package>
//
// CI only (.github/workflows/publish-kernel.yml), after the version step and the build. The fleet's
// consumers take these packages on a caret and update on their own, so a patch is a promise that
// what compiled against the last version still compiles. @hadoku/service-kernel 0.1.137 broke it:
// `EraseStep` gained a REQUIRED `merge`, published as a patch, and hadoku-watchparty failed its
// typecheck and crash-looped at boot for 70 minutes (cardtable#100).
//
// Every export of every entry the newest npmjs version's package.json names is compared, with the
// TypeScript checker, against the same export of the fresh dist/:
//   - an export that is gone breaks;
//   - a type breaks when the old one is not assignable to the new one: a consumer's own object
//     literal or implementation of it no longer type-checks (a field became required, a member's
//     type narrowed);
//   - a value (function, class, const) breaks when the new one is not assignable to the old one: a
//     consumer's call or read of it no longer type-checks (a parameter became required, a return
//     lost a field).
// A type is checked in its consumer-builds-it direction only, so a type the package hands out and
// gains a required field reads as a break too. That errs towards a minor bump, never towards a
// crash loop.
//
// A break passes when this release is a minor or major bump over npmjs's newest (pre-1.0, the minor
// is the breaking digit), which a caret does not take: commit the bumped `version` in the package's
// package.json (next-version keeps a committed version above the registry's) and update the
// consumers. Imports a probe cannot resolve (a sibling, by its @wolffm/* name) read as `any` on both
// sides, so a change inside a sibling is the sibling's own gate to catch.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import ts from 'typescript';

const NPMJS = 'https://registry.npmjs.org';

export interface Break {
	entry: string;
	name: string;
	why: string;
}

interface PackageJson {
	version: string;
	exports?: Record<string, string | { types?: string }>;
}

/** Every `.d.ts` the package's exports name, relative to the package root (`dist/erase/index.d.ts`). */
export function entries(pkgRoot: string): string[] {
	const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as PackageJson;
	const out = new Set<string>();
	for (const target of Object.values(pkg.exports ?? {})) {
		const types = typeof target === 'string' ? target : target.types;
		if (types === undefined || !types.endsWith('.d.ts')) continue;
		const rel = types.replace(/^\.\//, '');
		if (!rel.includes('*')) {
			out.add(rel);
			continue;
		}
		// A pattern export (`./dist/*.d.ts`): every declaration file under its fixed prefix.
		const [prefix] = rel.split('*') as [string];
		const base = join(pkgRoot, dirname(`${prefix}x`));
		if (!existsSync(base)) continue;
		for (const e of readdirSync(base, { recursive: true, withFileTypes: true })) {
			if (!e.isFile() || !e.name.endsWith('.d.ts')) continue;
			const path = relative(pkgRoot, join(e.parentPath, e.name));
			if (path.startsWith(prefix)) out.add(path);
		}
	}
	return [...out].sort();
}

const asJs = (path: string): string => path.replace(/\.d\.ts$/, '.js');
/**
 * A copy of `root`'s package.json and declarations with every private member's line taken out and
 * every `protected` made plain. A consumer cannot touch a private member, and a protected one keeps
 * its type, but TypeScript compares a class with either nominally (a `#private` brand, `private x;`
 * or `protected x` from two declarations never match), so without this every class reads as a break
 * between any two versions.
 */
export function publicCopy(root: string, dest: string): string {
	mkdirSync(dest, { recursive: true });
	copyFileSync(join(root, 'package.json'), join(dest, 'package.json'));
	for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (!e.isFile() || !e.name.endsWith('.d.ts')) continue;
		const path = relative(root, join(e.parentPath, e.name));
		if (path.split('/').includes('node_modules')) continue;
		mkdirSync(dirname(join(dest, path)), { recursive: true });
		writeFileSync(join(dest, path), readFileSync(join(root, path), 'utf8').replace(PRIVATE, '').replace(PROTECTED, ''));
	}
	return dest;
}
// A declaration file writes a private member with no type (`private store;`, `private constructor();`).
const PRIVATE = /#private;|\b(?:static\s+)?private\s+(?:readonly\s+)?(?:[\w$]+\??|constructor\([^)]*\));/g;
const PROTECTED = /\bprotected\s+/g;

/** A symbol's declarations as written, for telling an unchanged export from a changed one. */
const declText = (sym: ts.Symbol): string => (sym.declarations ?? []).map((d) => d.getText()).join('\n');

/** `<any, any>` for a generic type, so the probe can name it without its arguments. */
function anyArgs(checker: ts.TypeChecker, sym: ts.Symbol): string {
	const target = sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
	const n = Math.max(0, ...(target.declarations ?? []).map((d) => (d as ts.InterfaceDeclaration).typeParameters?.length ?? 0));
	return n === 0 ? '' : `<${Array(n).fill('any').join(', ')}>`;
}

/**
 * The breaks between two unpacked packages (`before` and `after` each hold a package.json and the
 * files its exports name). `resolveFrom` is the directory the probe sits in, so the declarations'
 * own imports (express, socket.io, a peer) resolve through its node_modules.
 */
export function breaks(beforeRoot: string, afterRoot: string, resolveFrom: string = afterRoot): Break[] {
	const found: Break[] = [];
	const probeDir = mkdtempSync(join(resolveFrom, '.surface-probe-'));
	try {
		const files = entries(beforeRoot);
		const before = publicCopy(beforeRoot, join(probeDir, 'old'));
		const after = publicCopy(afterRoot, join(probeDir, 'new'));
		const options: ts.CompilerOptions = {
			strict: true,
			noEmit: true,
			skipLibCheck: true,
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			jsx: ts.JsxEmit.ReactJSX,
			lib: ['lib.es2023.d.ts', 'lib.dom.d.ts'],
			types: [],
		};
		// First pass: what each side exports, by entry.
		const listing = (root: string): { checker: ts.TypeChecker; byEntry: Map<string, Map<string, ts.Symbol>> } => {
			const program = ts.createProgram(
				files.map((f) => join(root, f)).filter(existsSync),
				options,
			);
			const checker = program.getTypeChecker();
			const out = new Map<string, Map<string, ts.Symbol>>();
			for (const f of files) {
				const sf = program.getSourceFile(join(root, f));
				const mod = sf === undefined ? undefined : checker.getSymbolAtLocation(sf);
				out.set(f, new Map((mod === undefined ? [] : checker.getExportsOfModule(mod)).map((s) => [s.name, s])));
			}
			return { checker, byEntry: out };
		};
		const old = listing(before);
		const now = listing(after);

		// Second pass: one probe file of assignments, a line per check, read back by line.
		const lines: string[] = ['declare function take<T>(): T;'];
		const at: (Break & { line: number })[] = [];
		const rel = (p: string): string => {
			const r = relative(probeDir, p);
			return r.startsWith('.') ? r : `./${r}`;
		};
		files.forEach((f, i) => {
			const was = old.byEntry.get(f)!;
			const is = now.byEntry.get(f)!;
			if (was.size === 0) return;
			if (!existsSync(join(after, f))) {
				found.push({ entry: f, name: '*', why: 'the entry is gone' });
				return;
			}
			lines.push(`import type * as O${i} from '${rel(join(before, asJs(f)))}';`);
			lines.push(`import type * as N${i} from '${rel(join(after, asJs(f)))}';`);
			for (const [name, sym] of was) {
				const target = is.get(name);
				if (target === undefined) {
					found.push({ entry: f, name, why: 'the export is gone' });
					continue;
				}
				const real = sym.flags & ts.SymbolFlags.Alias ? old.checker.getAliasedSymbol(sym) : sym;
				const realNow = target.flags & ts.SymbolFlags.Alias ? now.checker.getAliasedSymbol(target) : target;
				// A declaration whose text did not change is not checked: what it names is checked on its own
				// when exported, and the checker cannot prove two copies of some generic signatures (zod's
				// mapped object shapes in platform-wire's presenceEchoSchema) assignable even when identical.
				if (declText(real) === declText(realNow)) continue;
				const oldFlags = real.flags;
				if (oldFlags & ts.SymbolFlags.Type && !(oldFlags & ts.SymbolFlags.Class)) {
					const g = anyArgs(old.checker, sym);
					at.push({ entry: f, name, why: 'a value of the old type is not one of the new type', line: lines.length });
					lines.push(`{ const _: N${i}.${name}${g} = take<O${i}.${name}${g}>(); void _; }`);
				}
				if (oldFlags & ts.SymbolFlags.Value) {
					at.push({ entry: f, name, why: 'the new value cannot stand where the old one did', line: lines.length });
					lines.push(`{ const _: typeof O${i}.${name} = take<typeof N${i}.${name}>(); void _; }`);
				}
			}
		});
		const probe = join(probeDir, 'probe.ts');
		writeFileSync(probe, `${lines.join('\n')}\n`);
		const program = ts.createProgram([probe], options);
		const sf = program.getSourceFile(probe)!;
		const bad = new Map<number, string>();
		for (const d of ts.getPreEmitDiagnostics(program, sf)) {
			if (d.file !== sf || d.start === undefined) continue;
			const { line } = sf.getLineAndCharacterOfPosition(d.start);
			// Paths into the two unpacked trees read as old:/new:, so a message names the module, not the temp dir.
			const text = ts.flattenDiagnosticMessageText(d.messageText, ' ').replaceAll(`${before}/`, 'old:').replaceAll(`${after}/`, 'new:');
			if (!bad.has(line)) bad.set(line, text.length > 400 ? `${text.slice(0, 400)}…` : text);
		}
		for (const a of at) {
			const msg = bad.get(a.line);
			// An unresolvable import reads as `any` and never lands here: only a real assignability failure does.
			if (msg !== undefined) found.push({ entry: a.entry, name: a.name, why: `${a.why}: ${msg}` });
		}
		return found;
	} finally {
		rmSync(probeDir, { recursive: true, force: true });
	}
}

/** Does `next` over `prev` move the digit a caret holds still (the minor pre-1.0, else the major)? */
export function isBreakingBump(prev: string, next: string): boolean {
	const [pM, pm] = prev.split('.').map(Number) as [number, number];
	const [nM, nm] = next.split('.').map(Number) as [number, number];
	if (nM !== pM) return nM > pM;
	return pM === 0 && nm > pm;
}

/** npmjs's newest version of `name`, unpacked into a temporary directory, or null when it has none. */
function unpackPublished(name: string, into: string): { version: string; root: string } | null {
	let version: string;
	try {
		version = execFileSync('npm', ['view', name, 'version', `--registry=${NPMJS}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	} catch (err) {
		if (/E404|404 Not Found/.test(String((err as { stderr?: unknown }).stderr ?? ''))) return null;
		throw err;
	}
	const out = execFileSync('npm', ['pack', `${name}@${version}`, `--registry=${NPMJS}`, '--pack-destination', into, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
	const [packed] = JSON.parse(out) as { filename: string }[];
	execFileSync('tar', ['xzf', join(into, packed!.filename), '-C', into]);
	return { version, root: join(into, 'package') };
}

function report(name: string, from: string, to: string, found: Break[]): number {
	if (found.length === 0) {
		console.log(`${name}: ${to} breaks nothing that compiled against ${from}`);
		return 0;
	}
	if (isBreakingBump(from, to)) {
		for (const b of found) console.log(`${name}: ${b.entry} ${b.name}: ${b.why}`);
		console.log(`${name}: ${found.length} breaking change(s), and ${to} over ${from} is a breaking bump, so a caret will not take it`);
		return 0;
	}
	for (const b of found) {
		console.log(`::error title=${name} ${to} breaks ${b.name}::${b.entry} ${b.name}: ${b.why}. ${to} is a patch over ${from}, which every caret consumer installs: commit a minor bump in the package.json and update the consumers, or make the change additive`);
	}
	return 1;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args[0] === '--before' && args[2] === '--after' && args[3] !== undefined) {
		const [before, after] = [resolve(args[1]!), resolve(args[3])];
		const pkg = (root: string): PackageJson & { name: string } => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson & { name: string };
		process.exit(report(pkg(after).name, pkg(before).version, pkg(after).version, breaks(before, after, process.cwd())));
	}
	const dir = args[0];
	if (dir === undefined) {
		console.error('usage: node scripts/publish/surface.ts packages/<name> | --before <dir> --after <dir>');
		process.exit(2);
	}
	const root = resolve(dir);
	const name = `@hadoku/${basename(root)}`;
	const tmp = mkdtempSync(join(tmpdir(), 'surface-'));
	try {
		const published = unpackPublished(name, tmp);
		if (published === null) {
			console.log(`${name}: not on npmjs yet, no consumer to break`);
			process.exit(0);
		}
		mkdirSync(join(root, 'dist'), { recursive: true });
		const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson).version;
		process.exit(report(name, published.version, version, breaks(published.root, root, root)));
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}
