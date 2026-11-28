/*
 * A turn-start snapshot's text (`PlayBridge.TurnSnapshot`, Forge's own `GameState` text), read so two
 * snapshots of one position compare equal across a restore: Forge gives every card a new id on apply,
 * so each id is replaced by the name of the card it is.
 *
 * `restore.jvm.test.ts` checks a restore with it, and the monkey's two-seat run (`monkey/pvp/`) checks
 * every Restart turn it presses with it.
 */

/** Keys whose value names other cards by id: `Id:` marks the card the others point at. */
const ID_REF = /\b(AttachedTo|ExiledWith|RememberedCards|Imprinting|ChosenCards|Attacking):([\d,]+)/g;
/** A control condition's source, `ControlUntil:<kinds>@<id>`. */
const UNTIL_REF = /\b(ControlUntil:[A-Za-z+]+)@(\d+)/g;
/** Zones whose order is the game's: the battlefield is rebuilt tokens first, so it is compared as a set. */
const UNORDERED = /^p\dbattlefield$/;

/**
 * A snapshot as `key → entries`, every card id replaced by the name of the card it is (the `Id:`
 * entry), so two snapshots of one position compare equal across a restore.
 */
export function normalizedSnapshot(state: string): Record<string, string[]> {
	const names = new Map<string, string>();
	for (const entry of state.split(/[\n;=]/)) {
		const id = /\|Id:(\d+)/.exec(entry)?.[1];
		if (id !== undefined) names.set(id, entry.split('|')[0]!);
	}
	const name = (id: string): string => names.get(id) ?? `?${id}`;
	const out: Record<string, string[]> = {};
	for (const line of state.split('\n')) {
		const at = line.indexOf('=');
		if (at < 0) continue;
		const key = line.slice(0, at);
		const entries = line
			.slice(at + 1)
			.split(';')
			.filter((e) => e !== '')
			.map((e) =>
				e
					.replace(/\|Id:(\d+)/, (_m, id: string) => `|Id:${name(id)}`)
					.replace(ID_REF, (_m, k: string, ids: string) => `${k}:${ids.split(',').map(name).join(',')}`)
					.replace(UNTIL_REF, (_m, k: string, id: string) => `${k}@${name(id)}`),
			);
		// A delayed trigger names its host and remembered cards by id: `<host>|<activator>|<kind>|<intrinsic>|<c<id>,…>|<params>`.
		if (key === 'delayedtrigger') {
			const fields = (line.slice(at + 1)).split('|');
			fields[0] = name(fields[0]!);
			fields[4] = (fields[4] ?? '').replace(/c(\d+)/g, (_m, id: string) => `c${name(id)}`);
			out[key] = [...(out[key] ?? []), fields.join('|')];
			continue;
		}
		// An effect card, or a return, is Base64 of `key=value` lines naming its host, and what it remembers,
		// chose, moved or waits on, by id.
		if (key === 'effect' || key === 'return') {
			const fields = Buffer.from(line.slice(at + 1), 'base64')
				.toString('utf8')
				.split('\n')
				.filter((f) => f !== '')
				.map((f) => {
					const eq = f.indexOf('=');
					const k = f.slice(0, eq);
					const v = f.slice(eq + 1);
					if (k === 'host') return `host=${name(v)}`;
					if (k === 'remembered') return `remembered=${v.replace(/\bc(\d+)/g, (_m, id: string) => `c${name(id)}`)}`;
					if (k === 'imprinted' || k === 'chosencards') return `${k}=${v === '' ? '' : v.split(',').map(name).join(',')}`;
					if (k === 'until') return `until=${v.replace(/\bcard:(\d+):/g, (_m, id: string) => `card:${name(id)}:`)}`;
					if (k === 'moved') return `moved=${v.replace(/>([\d/]+)(?=,|$)/g, (_m, ids: string) => `>${ids.split('/').map(name).join('/')}`)}`;
					return f;
				});
			out[key] = [...(out[key] ?? []), fields.join('|')];
			continue;
		}
		out[key] = UNORDERED.test(key) ? entries.sort() : entries;
	}
	return out;
}
