/**
 * A room's settings, as a game declares them: each field's kind, default, label and lock, once,
 * read by the server (what it stores, what a PATCH may change, and when) and by the page (the
 * settings panel draws every field from the same definition). Knows no game.
 *
 *   const BOMBERMAN_SETTINGS = defineRoomSettings({
 *     mode: choice(['classic', 'roguelike', 'sandbox'], 'classic', { label: 'Mode', lock: LIVE }),
 *     pickTimer: toggle(true, { label: 'Pick timer', lock: LIVE }),
 *   });
 *
 * ## Locks
 *
 * A field's `lock` names WHEN it cannot change, never why: `LIVE` ("while a match is live") is the
 * kit's own, which a relay game's server answers (`@hadoku/game-server`'s `startRelayGame`). Any
 * other name is a group the hosting room type answers itself (Magic's `event` and `rules`). A field
 * with no lock changes whenever the leader likes.
 *
 * ## Refusals
 *
 * Every refusal names the field and what it must be (`settings.mode must be one of: classic, …`),
 * and never echoes a value. A setting nobody declared is refused, never dropped.
 */

import { z } from 'zod';

/** The kit's own lock: a field that changes in the lobby only, never while a match is live. */
export const LIVE = 'live';

/** What every field has. `T` is the value as it is stored, sent and read. */
interface FieldBase<T> {
	/** A new room's value, and a stored room's when it has none. */
	default: T;
	/** What the panel calls it. */
	label: string;
	/** When it cannot change (see the header). Absent: whenever. */
	lock?: string;
	/** What a value must be, as a refusal says it after the field's name. */
	must: string;
	schema: z.ZodType<T>;
}

/** On or off. */
export interface ToggleField extends FieldBase<boolean> {
	kind: 'toggle';
}

/** One of a closed list, drawn as a row of cards. */
export interface ChoiceField<T extends string = string> extends FieldBase<T> {
	kind: 'choice';
	choices: readonly { value: T; label: string }[];
}

/** A number in `[min, max]`, in steps of `step`. */
export interface NumberField extends FieldBase<number> {
	kind: 'number';
	min: number;
	max: number;
	step: number;
}

/** Anything else (Magic's pick timer, an object). The panel cannot draw it: the game draws its own row. */
export interface CustomField<T = unknown> extends FieldBase<T> {
	kind: 'custom';
}

export type SettingField = ToggleField | ChoiceField | NumberField | CustomField;

export type SettingFields = Readonly<Record<string, SettingField>>;

/** The settings object a set of fields declares. */
export type SettingsOf<F extends SettingFields> = { [K in keyof F]: F[K] extends FieldBase<infer T> ? T : never };

interface FieldOptions {
	label: string;
	lock?: string;
}

export function toggle(fallback: boolean, opts: FieldOptions): ToggleField {
	return { kind: 'toggle', default: fallback, must: 'must be a boolean', schema: z.boolean(), ...opts };
}

/** `labels` names each value for the panel; a value with none is shown as itself. */
export function choice<const T extends string>(values: readonly [T, ...T[]], fallback: NoInfer<T>, opts: FieldOptions & { labels?: Readonly<Partial<Record<T, string>>> }): ChoiceField<T> {
	const { labels, ...rest } = opts;
	return {
		kind: 'choice',
		default: fallback,
		choices: values.map((value) => ({ value, label: labels?.[value] ?? value })),
		must: `must be one of: ${values.join(', ')}`,
		schema: z.enum(values as unknown as [T, ...T[]]) as unknown as z.ZodType<T>,
		...rest,
	};
}

/** A whole number when `step` is (the default, 1); otherwise any number in range. */
export function bounded(range: { min: number; max: number; step?: number }, fallback: number, opts: FieldOptions): NumberField {
	const step = range.step ?? 1;
	const whole = Number.isInteger(step);
	const base = whole ? z.int() : z.number();
	return {
		kind: 'number',
		default: fallback,
		min: range.min,
		max: range.max,
		step,
		must: `must be ${whole ? 'an integer' : 'a number'} ${range.min}–${range.max}`,
		schema: base.min(range.min).max(range.max),
		...opts,
	};
}

/** A value of any shape `schema` admits; `must` says what that is. */
export function custom<T>(schema: z.ZodType<T>, fallback: T, opts: FieldOptions & { must: string }): CustomField<T> {
	return { kind: 'custom', default: fallback, schema, ...opts };
}

/** The whole settings object's schema: a strict zod object, so a game may `.partial()` or `.omit()` it. */
export type SettingsSchema<F extends SettingFields> = z.ZodObject<{ [K in keyof F]: F[K]['schema'] }, z.core.$strict>;

export type PatchResult<S> = { ok: true; patch: Partial<S> } | { ok: false; error: string };
export type ApplyResult<S> = { ok: true; next: S; changed: (keyof S & string)[] } | { ok: false; reason: string };

export interface RoomSettingsSpec<F extends SettingFields = SettingFields> {
	readonly fields: F;
	/** In declaration order: the panel's rows. */
	readonly keys: readonly (keyof F & string)[];
	/** The whole settings object, every field required and nothing else. */
	readonly schema: SettingsSchema<F>;
	/** A new room's settings, a fresh copy each call. */
	defaults(): SettingsOf<F>;
	/** A PATCH's `settings`: some of the fields, each valid; at least one; nothing undeclared. */
	parsePatch(raw: unknown): PatchResult<SettingsOf<F>>;
	/**
	 * The settings a room file holds, every missing field at its default and every retired one
	 * dropped. Null when it is not settings at all (a field undeclared, or a value its field refuses):
	 * the caller quarantines the room. `undefined` (a room written before it had settings) is the defaults.
	 */
	readStored(raw: unknown): SettingsOf<F> | null;
	/**
	 * `patch` over `current`. Only the fields whose value actually moves are checked against their
	 * lock, in declaration order; the first lock `lockedBy` answers non-null refuses the whole patch.
	 */
	apply(current: SettingsOf<F>, patch: Partial<SettingsOf<F>>, lockedBy: (lock: string) => string | null): ApplyResult<SettingsOf<F>>;
}

/**
 * Any game's settings as the kit reads them: the fields by name, the values as plain records. Every
 * `RoomSettingsSpec` is one, so a server or a panel takes this and a game passes its own spec.
 */
export interface AnyRoomSettings {
	readonly fields: SettingFields;
	readonly keys: readonly string[];
	defaults(): Record<string, unknown>;
	parsePatch(raw: unknown): PatchResult<Record<string, unknown>>;
	readStored(raw: unknown): Record<string, unknown> | null;
	apply(current: Record<string, unknown>, patch: Record<string, unknown>, lockedBy: (lock: string) => string | null): ApplyResult<Record<string, unknown>>;
}

/** Values are JSON (they are stored and sent), so equal JSON is the same value. */
function same(a: unknown, b: unknown): boolean {
	return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A game's settings. `retired` names fields a room file may still hold from an older build: read
 * and dropped, so the room still loads.
 */
export function defineRoomSettings<const F extends SettingFields>(fields: F, opts: { retired?: readonly string[] } = {}): RoomSettingsSpec<F> {
	type S = SettingsOf<F>;
	const keys = Object.keys(fields) as (keyof F & string)[];
	const retired = new Set(opts.retired ?? []);
	const fieldOf = (k: string): SettingField | undefined => (Object.hasOwn(fields, k) ? fields[k] : undefined);
	const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
	const schema = z.strictObject(Object.fromEntries(keys.map((k) => [k, fields[k]!.schema]))) as unknown as SettingsSchema<F>;
	return {
		fields,
		keys,
		schema,
		defaults: () => structuredClone(Object.fromEntries(keys.map((k) => [k, fields[k]!.default]))) as S,
		parsePatch(raw) {
			if (!isObject(raw)) return { ok: false, error: 'settings must be an object' };
			// A bad value is named before an undeclared field, as a PATCH has always answered.
			for (const [k, v] of Object.entries(raw)) {
				const field = fieldOf(k);
				if (field !== undefined && !field.schema.safeParse(v).success) return { ok: false, error: `settings.${k} ${field.must}` };
			}
			const unknown = Object.keys(raw).filter((k) => fieldOf(k) === undefined);
			if (unknown.length > 0) return { ok: false, error: `unknown setting(s): ${unknown.join(', ')}` };
			if (Object.keys(raw).length === 0) return { ok: false, error: 'settings names no setting' };
			return { ok: true, patch: structuredClone(raw) as Partial<S> };
		},
		readStored(raw) {
			if (raw === undefined) return this.defaults();
			if (!isObject(raw)) return null;
			const out = this.defaults() as Record<string, unknown>;
			for (const [k, v] of Object.entries(raw)) {
				if (retired.has(k)) continue;
				const field = fieldOf(k);
				if (field === undefined || !field.schema.safeParse(v).success) return null;
				out[k] = structuredClone(v);
			}
			return out as S;
		},
		apply(current, patch, lockedBy) {
			const changed = keys.filter((k) => k in patch && patch[k] !== undefined && !same(patch[k], current[k]));
			for (const k of changed) {
				const lock = fields[k]!.lock;
				const reason = lock === undefined ? null : lockedBy(lock);
				if (reason !== null) return { ok: false, reason };
			}
			const next = { ...current };
			for (const k of changed) next[k] = structuredClone(patch[k]) as S[typeof k];
			return { ok: true, next, changed };
		},
	};
}
