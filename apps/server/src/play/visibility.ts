/**
 * Hidden information, enforced on the server — one projection per seat.
 *
 * ## Forge's own stream is NOT per-player safe
 *
 * Read, not assumed: `DeltaSyncManager.collectDeltas` walks the WHOLE shared
 * `GameView` for every client (`forge/forge-gui/.../net/server/
 * DeltaSyncManager.java:112-128`, `walkAndCollect` from the root with no viewer
 * anywhere in it), and `toNetworkValue` (`:356-401`) only flattens references to
 * ids — it never drops a property. There is no `canBeShownTo` call anywhere in
 * `forge/.../gamemodes/net/` (`grep -rn 'canBeShown\|mayView'` finds two
 * comments and nothing else). Forge's network client hides cards itself, at
 * render time, with `CardView.canBeShownTo(viewer)` (`CardView.java:622-681`):
 * the wire is trust-the-client.
 *
 * The data agrees with the reading. In `apps/ui/src/play/fixtures/
 * tierc-game1-seq1-27.json` — seat 0's own stream — every one of seat 1's hand
 * cards arrives with `Name`, `OracleName` and a full face (`CardStateView`)
 * carrying `ImageKey`, `OracleText` and the rest; and the opening sync carries
 * both LIBRARIES, in order, named. The events arm is worse: a
 * `GameEventCardChangeZone` for a draw names the drawn card
 * (`packages/forge-wire/src/events/fixtures/GameEventCardChangeZone.json`).
 *
 * So a browser never sees Forge's stream. It sees this projection of it.
 *
 * ## The rule is Forge's, transcribed
 *
 * `cardVisibility` is `CardView.canBeShownTo` and `canFaceDownBeShownTo`
 * (`CardView.java:622-704`) evaluated over the wire state instead of the object
 * graph — same zone table, same `PlayerMayLook` override, same mind-slave
 * fallback. Three outcomes:
 *
 *   `full`     — the viewer may see the card and its face.
 *   `faceOnly` — it is on the table face down and not theirs to peek at: they
 *                see a face-down card (its `CurrentState` face, which is the
 *                generic face-down one) and none of the others.
 *   `hidden`   — a card in someone else's hand, any library, a face-down exile
 *                pile. They see that it exists and whose it is, never what.
 *
 * A card's zone is read from the PlayerView zone LISTS first and the card's own
 * `Zone` second, for the reason `apps/ui/src/play/adapter.ts` gives: Forge's
 * client re-stamps `Zone` from the lists because the per-card field can lag.
 * A card the state does not know at all is `hidden` — the conservative answer.
 *
 * ## It is stateful, and it has to be
 *
 * A card moves between visibilities without the packet that moves it saying
 * anything about the card: you draw, and the only change on the wire may be
 * your PlayerView's `Hand` list. Its face was redacted while it sat in your
 * library, so a stateless filter would leave you holding a nameless card. The
 * projector therefore folds the raw stream (Forge's own apply rules — see
 * `apps/ui/src/play/fold.ts`), recomputes every card's visibility after each
 * packet, and on a change:
 *
 *   upgrade   (hidden → faceOnly → full) — re-sends the card and its faces in
 *             `newObjects`, from the raw state, so the client has them whole.
 *   downgrade (full → faceOnly → hidden) — re-sends the card redacted in
 *             `newObjects` (a replace, which clears the old bag) and wipes each
 *             face the viewer may no longer hold, so stale names do not linger.
 *
 * ## What else it strips
 *
 * - **The events arm, entirely.** Events carry card NAMES (see above), and a
 *   per-event visibility rule is its own piece of work. Nothing a browser
 *   renders reads events today — the board is drawn from state. Dropped here
 *   and also at the source (`bridge/PlayBridge.java` never encodes them).
 * - **The checksum.** It is computed over the unredacted state, so it is
 *   meaningless to a client holding the projection, and a hash over hidden
 *   properties is not something to hand out. `checksum: 0`, no properties.
 *
 * ## What it cannot fix
 *
 * Card ids are stable in Forge. A library is an ordered id list, so a card the
 * viewer has SEEN (it was on the battlefield, it was revealed) and that is later
 * shuffled back in can be followed by id. Forge's own client has the same
 * property; its mitigation is `HiddenId`, which this projection passes through
 * for exactly that reason. Closing it needs id remapping on the server, which
 * would break every reference Forge makes — recorded in `README.md`, not fixed.
 */

/** A property bag as the Tier C wire carries it. Values are tagged JSON. */
export interface WireObj {
	_type: number;
	_id: number;
	[property: string]: unknown;
}

export type ObjTable = Record<string, WireObj>;

export interface DeltaPacketJson {
	seq: number;
	checksum: number;
	checksumProperties: number[];
	newObjects: ObjTable;
	objectDeltas: ObjTable;
	events: unknown[];
}

/**
 * `PlayBridge.java`'s `stackTargetSpells` — `[fromStackItemId,
 * toStackItemId]` pairs, a SIBLING of `gameView`/`packet` in the frame's own
 * payload, not a `TrackableProperty` (`packages/forge-wire/src/tier-c.ts`'s
 * `StackTargetSpellsSchema`). Optional: a frame from before this addition, or
 * one built by hand in a test, carries none.
 */
export type StackTargetSpells = readonly (readonly [number, number])[];

/** `PlayBridge.java`'s `pendingTriggers` — `packages/forge-wire/src/tier-c.ts`'s `PendingTriggersSchema`. */
export type PendingTriggers = readonly { id: number; hostCard: number; controller: number; key: string; current?: true }[];

/** `PlayBridge.java`'s `waitingEffects` — `packages/forge-wire/src/tier-c.ts`'s `WaitingEffectsSchema`. */
export type WaitingEffects = readonly { source: number; text: string; kind: 'trigger' | 'effect' }[];

/** The three Tier C frames, loosely typed for the projector's own use. */
export type StateFrame =
	| { kind: 'notify'; method: 'setGameView'; payload: { gameView: ObjTable; sequenceNumber: number; stackTargetSpells?: StackTargetSpells; pendingTriggers?: PendingTriggers; waitingEffects?: WaitingEffects } }
	| { kind: 'notify'; method: 'openView'; payload: { myPlayers: number[] } }
	| { kind: 'notify'; method: 'applyDelta'; payload: { packet: DeltaPacketJson; stackTargetSpells?: StackTargetSpells; pendingTriggers?: PendingTriggers; waitingEffects?: WaitingEffects } };

export type Visibility = 'full' | 'faceOnly' | 'hidden';

/** `DeltaPacket.TYPE_*` (`DeltaPacket.java:34-38`). */
export const TYPE = { card: 0, player: 1, stackItem: 2, game: 3, cardState: 4 } as const;

export function keyOf(type: number, id: number): string {
	return String(((type << 28) | (id & 0x0fffffff)) >>> 0);
}

function typeOfKey(key: string): number {
	return (Number(key) >>> 28) & 0xf;
}

/** A `CardStateView` id is `cardId * 16 + CardStateName.ordinal()` (`DeltaPacket.java:61-66`). */
export function csvCardId(csvId: number): number {
	return Math.floor(csvId / 16);
}

function csvOrdinal(csvId: number): number {
	return csvId % 16;
}

/**
 * PlayerView properties that are zone lists, mapped to the `ZoneType` each one
 * is. `NetworkGuiGame.getZoneTypeForProperty` (`NetworkGuiGame.java:~555-572`)
 * with the two it maps to null left out: `Flashback` (a virtual zone whose
 * cards keep their real zone) and `Commander` (a list of commanders wherever
 * they are). The four deck zones Forge's own table skips are included: they are
 * hidden zones, and leaving them out would make their cards fall back to the
 * per-card `Zone`, which is the field that lags.
 */
const ZONE_LISTS: Readonly<Record<string, string>> = {
	Hand: 'Hand',
	Library: 'Library',
	Graveyard: 'Graveyard',
	Battlefield: 'Battlefield',
	Exile: 'Exile',
	Command: 'Command',
	Ante: 'Ante',
	Sideboard: 'Sideboard',
	PlanarDeck: 'PlanarDeck',
	SchemeDeck: 'SchemeDeck',
	AttractionDeck: 'AttractionDeck',
	ContraptionDeck: 'ContraptionDeck',
	Junkyard: 'Junkyard',
};

/** Zones whose cards anyone may see (`CardView.java:630-637`). */
const PUBLIC_ZONES = new Set(['Ante', 'Command', 'Battlefield', 'Graveyard', 'Flashback', 'Stack', 'Junkyard']);

/** Zones where a face-down card's controller may still peek (`CardView.java:703`). */
const PEEKABLE_FACE_DOWN_ZONES = new Set(['Battlefield', 'Stack', 'Sideboard']);

/**
 * What a `hidden` card keeps: that it exists, whose it is, where it is, and
 * Forge's own anti-tracking handle. Nothing that says WHICH card.
 */
const HIDDEN_KEEP = new Set(['Owner', 'Controller', 'Zone', 'HiddenId']);

/**
 * What a `faceOnly` card keeps: everything a face-down permanent shows on a
 * table — its state on the battlefield — and none of the fields that name the
 * card underneath (`Name`, `OracleName`, `Cloner`, `MergedCards`,
 * `PaperCardBackup`, the split/flip/modal shape flags). A whitelist, so a
 * property Forge adds later is hidden until someone decides otherwise.
 */
const FACE_ONLY_KEEP = new Set([
	...HIDDEN_KEEP,
	'GamePieceType',
	'Facedown',
	'FacedownImageKey',
	'CurrentState',
	'Tapped',
	'Sickness',
	'PhasedOut',
	'Damage',
	'AssignedDamage',
	'LethalDamage',
	'Counters',
	'Attacking',
	'Blocking',
	'EntityAttachedTo',
	'AttachedCards',
	'NeedsTapAnimation',
	'NeedsUntapAnimation',
	'Token',
]);

/* ── Reading tagged values ───────────────────────────────────────────── */

function tagged(obj: WireObj | undefined, prop: string): { t: string; v?: unknown } | undefined {
	const value = obj?.[prop];
	return typeof value === 'object' && value !== null && typeof (value as { t?: unknown }).t === 'string'
		? (value as { t: string; v?: unknown })
		: undefined;
}

function intOf(obj: WireObj | undefined, prop: string): number | null {
	const v = tagged(obj, prop);
	return v !== undefined && v.t === 'int' && typeof v.v === 'number' ? v.v : null;
}

function boolOf(obj: WireObj | undefined, prop: string): boolean {
	const v = tagged(obj, prop);
	return v !== undefined && v.t === 'bool' && v.v === true;
}

function enumOf(obj: WireObj | undefined, prop: string): string | null {
	const v = tagged(obj, prop);
	return v !== undefined && v.t === 'enum' && typeof v.v === 'string' ? v.v : null;
}

function idsOf(obj: WireObj | undefined, prop: string): number[] {
	const v = tagged(obj, prop);
	if (v === undefined || (v.t !== 'list' && v.t !== 'set') || !Array.isArray(v.v)) return [];
	const out: number[] = [];
	for (const item of v.v as unknown[]) {
		const t = item as { t?: unknown; v?: unknown } | null;
		if (t !== null && t.t === 'int' && typeof t.v === 'number' && t.v !== -1) out.push(t.v);
	}
	return out;
}

/* ── The raw fold — Forge's apply rules ──────────────────────────────── */

/**
 * `NetworkGuiGame.applyDelta`'s rules, which `apps/ui/src/play/fold.ts` also
 * transcribes: `newObjects` replace, `objectDeltas` merge, `null` deletes, and
 * a delta for an unknown object is skipped.
 */
function foldInto(state: Map<string, WireObj>, packet: DeltaPacketJson): void {
	for (const [key, obj] of Object.entries(packet.newObjects)) {
		const clean: WireObj = { _type: obj._type, _id: obj._id };
		for (const [prop, value] of Object.entries(obj)) {
			if (prop !== '_type' && prop !== '_id' && value !== null) clean[prop] = value;
		}
		state.set(key, clean);
	}
	for (const [key, delta] of Object.entries(packet.objectDeltas)) {
		const existing = state.get(key);
		if (existing === undefined) continue;
		const next: WireObj = { ...existing };
		for (const [prop, value] of Object.entries(delta)) {
			if (prop === '_type' || prop === '_id') continue;
			if (value === null) delete next[prop];
			else next[prop] = value;
		}
		state.set(key, next);
	}
}

/**
 * Fold a stream of state frames the way a client does: `setGameView` resets to
 * its table, `applyDelta` folds by the rules above, `openView` carries no state.
 * What a seat SHOULD hold after the frames it was sent.
 */
export function foldFrames(frames: readonly StateFrame[]): Map<string, WireObj> {
	const state = new Map<string, WireObj>();
	for (const frame of frames) {
		if (frame.method === 'setGameView') {
			state.clear();
			foldInto(state, { seq: 0, checksum: 0, checksumProperties: [], newObjects: frame.payload.gameView, objectDeltas: {}, events: [] });
		} else if (frame.method === 'applyDelta') {
			foldInto(state, frame.payload.packet);
		}
	}
	return state;
}

/* ── Visibility ──────────────────────────────────────────────────────── */

interface ZoneIndex {
	/** cardId → [zone, the player whose list holds it]. */
	byCard: Map<number, { zone: string; holder: number }>;
}

function indexZones(state: ReadonlyMap<string, WireObj>): ZoneIndex {
	const byCard = new Map<number, { zone: string; holder: number }>();
	for (const obj of state.values()) {
		if (obj._type !== TYPE.player) continue;
		for (const [prop, zone] of Object.entries(ZONE_LISTS)) {
			for (const id of idsOf(obj, prop)) byCard.set(id, { zone, holder: obj._id });
		}
	}
	return { byCard };
}

/**
 * `CardView.canBeShownTo` + `canFaceDownBeShownTo`, over wire state. `viewer`
 * is a Forge PlayerView id; `null` is nobody in particular — the TABLE itself.
 * A null viewer is shown exactly what is public: every card in a public zone
 * and every face-up card in exile, as the card shows it (a face-down permanent
 * is its face-down face), and nothing from any hand, library or sideboard.
 * That is what a watcher with no seat receives (`match.ts`'s watcher channel,
 * 2026-10-12): the same projection for everyone who is not playing, built once.
 */
export function cardVisibility(
	state: ReadonlyMap<string, WireObj>,
	zones: ZoneIndex,
	cardId: number,
	viewer: number | null,
): Visibility {
	const card = state.get(keyOf(TYPE.card, cardId));
	if (card === undefined) return 'hidden';

	const listed = zones.byCard.get(cardId);
	const zone = listed?.zone ?? enumOf(card, 'Zone');
	if (viewer === null) return publicVisibility(card, zone);
	const controller = intOf(card, 'Controller') ?? listed?.holder ?? intOf(card, 'Owner');
	const mayLook = idsOf(card, 'PlayerMayLook').includes(viewer);
	const master = controller === null ? null : intOf(state.get(keyOf(TYPE.player, controller)), 'MindSlaveMaster');
	const viaMaster = master !== null && master !== controller && master === viewer && controller !== null;

	const shownTo = (who: number): boolean => {
		if (zone === null) return true; // "cards outside any zone are visible to all" (:627)
		if (PUBLIC_ZONES.has(zone)) return true;
		if ((zone === 'Exile' || zone === 'Merged') && !boolOf(card, 'Facedown')) return true;
		if (zone === 'Hand' && controller === who) return true;
		if (zone === 'Sideboard') {
			// Hidden from an OPPONENT unless they may look; in a two-seat game
			// everyone who is not the controller is an opponent.
			if (controller === who) return true;
		}
		if (zone === 'SchemeDeck') return true;
		return idsOf(card, 'PlayerMayLook').includes(who);
	};

	const faceShownTo = (who: number): boolean => {
		if (!boolOf(card, 'Facedown')) return true;
		if (idsOf(card, 'PlayerMayLook').includes(who)) return true;
		return zone !== null && PEEKABLE_FACE_DOWN_ZONES.has(zone) && controller === who;
	};

	const shown = shownTo(viewer) || mayLook || (viaMaster && controller !== null && shownTo(controller));
	if (!shown) return 'hidden';
	const face = faceShownTo(viewer) || (viaMaster && controller !== null && faceShownTo(controller));
	return face ? 'full' : 'faceOnly';
}

/**
 * What the table shows to nobody in particular: `shownTo` with no `who` to be
 * the controller of anything, so a hand, a library, a sideboard and a
 * `PlayerMayLook` grant are all somebody else's. A face-down card in a public
 * zone is its face-down face and nothing underneath (`canFaceDownBeShownTo`
 * with no peek). Nothing a seat could not already see passes here.
 */
function publicVisibility(card: WireObj, zone: string | null): Visibility {
	const shown =
		zone === null || // "cards outside any zone are visible to all" (:627)
		PUBLIC_ZONES.has(zone) ||
		((zone === 'Exile' || zone === 'Merged') && !boolOf(card, 'Facedown')) ||
		zone === 'SchemeDeck';
	if (!shown) return 'hidden';
	return boolOf(card, 'Facedown') ? 'faceOnly' : 'full';
}

function redactCard(obj: WireObj, vis: Visibility): WireObj | null {
	if (vis === 'full') return obj;
	const keep = vis === 'hidden' ? HIDDEN_KEEP : FACE_ONLY_KEEP;
	const out: WireObj = { _type: obj._type, _id: obj._id };
	let props = 0;
	for (const [prop, value] of Object.entries(obj)) {
		if (keep.has(prop)) {
			out[prop] = value;
			props += 1;
		}
	}
	return props > 0 ? out : null;
}

/**
 * A face (`CardStateView`) passes whole or not at all: every property on it
 * describes the card. `faceOnly` keeps exactly the face the card is showing.
 */
function faceAllowed(state: ReadonlyMap<string, WireObj>, csvId: number, vis: Visibility): boolean {
	if (vis === 'full') return true;
	if (vis === 'hidden') return false;
	const current = intOf(state.get(keyOf(TYPE.card, csvCardId(csvId))), 'CurrentState') ?? 0;
	return csvOrdinal(csvId) === current;
}

/**
 * A replacement that empties a face the viewer may no longer hold. `null`
 * deletes (fold rule 3), and one property keeps it a valid tracked object.
 */
function wipeFace(csvId: number): WireObj {
	return { _type: TYPE.cardState, _id: csvId, Name: null };
}

/* ── The projector ───────────────────────────────────────────────────── */

export interface SeatProjector {
	/** The Forge PlayerView id this seat sees as, from `openView`. */
	readonly viewer: number | null;
	setViewer(playerId: number): void;
	/** One raw Tier C frame in, the frame this seat may receive out. */
	project(frame: StateFrame): StateFrame;
	/** Current visibility of a card for this seat (diagnostics and tests). */
	visibilityOf(cardId: number): Visibility;
	/**
	 * How many creatures this seat's own battlefield holds, or null when the seat
	 * has no player yet or the state does not know it. Wave 32, Q10 — the fact
	 * behind *"no creatures, no block"* (`auto.ts` `skipEmptyBlockStop`).
	 *
	 * Public information by construction: a battlefield is on the table, and every
	 * card counted here is one this seat is already sent. A card whose face is not
	 * known is counted as a creature, because "when in doubt, the player is asked".
	 */
	creatureCount(): number | null;
	/**
	 * The Forge player id that activated the item on top of the stack, or null when
	 * the stack is empty or the state does not say. Wave 32, Q17 — the fact behind
	 * "this is my own spell, resolving" (`auto.ts` `passOwnSpell`). The stack is on
	 * the table for everyone to read, so this is public by construction.
	 */
	stackTopActivator(): number | null;
	/**
	 * Forge's own turn counter (the Game object's `Turn`), or null when the
	 * state does not know it yet — off a delta every seat already receives,
	 * never off a prompt's own text, so a seat that has not acted yet this
	 * turn still gets it right. Same construction as {@link stackTopActivator}:
	 * a global fact off the table, so `who` is never consulted.
	 */
	turnNumber(): number | null;
	/** Forge's own current phase (the Game object's `Phase`), or null when the state does not say. Global, as {@link turnNumber} is. */
	phase(): string | null;
}

export function createProjector(viewer: number | null = null): SeatProjector {
	const raw = new Map<string, WireObj>();
	/** What the client was last given for each card. */
	const sent = new Map<number, Visibility>();
	let who = viewer;

	/** Every card id the raw state knows, with its faces. */
	function cardsAndFaces(): Map<number, string[]> {
		const out = new Map<number, string[]>();
		for (const [key, obj] of raw) {
			if (obj._type === TYPE.card) {
				if (!out.has(obj._id)) out.set(obj._id, []);
			} else if (obj._type === TYPE.cardState) {
				const cardId = csvCardId(obj._id);
				const faces = out.get(cardId) ?? [];
				faces.push(key);
				out.set(cardId, faces);
			}
		}
		return out;
	}

	function visibilities(): Map<number, Visibility> {
		const zones = indexZones(raw);
		const out = new Map<number, Visibility>();
		for (const cardId of cardsAndFaces().keys()) out.set(cardId, cardVisibility(raw, zones, cardId, who));
		return out;
	}

	/** Project one object by its key; null when the viewer gets nothing for it. */
	function projectObject(key: string, obj: WireObj, vis: Map<number, Visibility>): WireObj | null {
		const type = typeOfKey(key);
		if (type === TYPE.card) return redactCard(obj, vis.get(obj._id) ?? 'hidden');
		if (type === TYPE.cardState) {
			const v = vis.get(csvCardId(obj._id)) ?? 'hidden';
			return faceAllowed(raw, obj._id, v) ? obj : null;
		}
		return obj;
	}

	function projectTable(table: ObjTable, vis: Map<number, Visibility>): ObjTable {
		const out: ObjTable = {};
		for (const [key, obj] of Object.entries(table)) {
			const projected = projectObject(key, obj, vis);
			if (projected !== null) out[key] = projected;
		}
		return out;
	}

	function projectPacket(packet: DeltaPacketJson): DeltaPacketJson {
		foldInto(raw, packet);
		const vis = visibilities();
		const newObjects = projectTable(packet.newObjects, vis);
		const objectDeltas = projectTable(packet.objectDeltas, vis);
		const faces = cardsAndFaces();

		for (const [cardId, now] of vis) {
			const before = sent.get(cardId);
			if (before === undefined || before === now) continue;
			const cardKey = keyOf(TYPE.card, cardId);
			const card = raw.get(cardKey);
			if (card === undefined) continue;
			// Re-send the card whole-as-allowed, as a replace.
			const redacted = redactCard(card, now);
			if (redacted !== null) newObjects[cardKey] = redacted;
			delete objectDeltas[cardKey];
			for (const faceKey of faces.get(cardId) ?? []) {
				const face = raw.get(faceKey);
				if (face === undefined) continue;
				delete objectDeltas[faceKey];
				if (faceAllowed(raw, face._id, now)) newObjects[faceKey] = face;
				else if (faceAllowed(raw, face._id, before)) newObjects[faceKey] = wipeFace(face._id);
				else delete newObjects[faceKey];
			}
		}
		for (const [cardId, now] of vis) sent.set(cardId, now);

		return { seq: packet.seq, checksum: 0, checksumProperties: [], newObjects, objectDeltas, events: [] };
	}

	/**
	 * The waiting triggers this seat may see: one whose card it may not see would name that card
	 * (`key` is the card's words), so it is dropped here, as the card's name is everywhere else.
	 */
	function pendingSeen(pending: PendingTriggers | undefined): { pendingTriggers?: PendingTriggers } {
		if (pending === undefined) return {};
		const zones = indexZones(raw);
		return { pendingTriggers: pending.filter((t) => cardVisibility(raw, zones, t.hostCard, who) === 'full') };
	}

	/** The waiting effects this seat may see: the same rule, by the card that made each one (its words name it). */
	function effectsSeen(effects: WaitingEffects | undefined): { waitingEffects?: WaitingEffects } {
		if (effects === undefined) return {};
		const zones = indexZones(raw);
		return { waitingEffects: effects.filter((e) => cardVisibility(raw, zones, e.source, who) === 'full') };
	}

	return {
		get viewer() {
			return who;
		},
		setViewer(playerId: number): void {
			who = playerId;
		},
		project(frame: StateFrame): StateFrame {
			switch (frame.method) {
				case 'openView':
					return frame;
				case 'setGameView': {
					raw.clear();
					sent.clear();
					foldInto(raw, {
						seq: 0,
						checksum: 0,
						checksumProperties: [],
						newObjects: frame.payload.gameView,
						objectDeltas: {},
						events: [],
					});
					const vis = visibilities();
					for (const [cardId, v] of vis) sent.set(cardId, v);
					return {
						kind: 'notify',
						method: 'setGameView',
						payload: {
							gameView: projectTable(frame.payload.gameView, vis),
							sequenceNumber: frame.payload.sequenceNumber,
							// Passed through UNREDACTED — see `StackTargetSpells`'s own note: both
							// ids name stack items, and the Stack zone is in `PUBLIC_ZONES`, so a
							// pairing of two ids already on the public stack hides nothing a card
							// redaction elsewhere in this same frame has not already hidden (the
							// SOURCE card of a face-down spell on the stack, say — this pairing
							// never carries a name, only ids the client already has).
							...(frame.payload.stackTargetSpells === undefined
								? {}
								: { stackTargetSpells: frame.payload.stackTargetSpells }),
							...pendingSeen(frame.payload.pendingTriggers),
							...effectsSeen(frame.payload.waitingEffects),
						},
					};
				}
				case 'applyDelta':
					return {
						kind: 'notify',
						method: 'applyDelta',
						payload: {
							packet: projectPacket(frame.payload.packet),
							...(frame.payload.stackTargetSpells === undefined
								? {}
								: { stackTargetSpells: frame.payload.stackTargetSpells }),
							...pendingSeen(frame.payload.pendingTriggers),
							...effectsSeen(frame.payload.waitingEffects),
						},
					};
			}
		},
		visibilityOf(cardId: number): Visibility {
			return cardVisibility(raw, indexZones(raw), cardId, who);
		},
		stackTopActivator(): number | null {
			// `GameView.Stack` is the stack item ids, TOP FIRST (`apps/ui/src/play/adapter.ts`).
			const game = [...raw.values()].find((o) => o._type === TYPE.game);
			const top = idsOf(game, 'Stack')[0];
			if (top === undefined) return null;
			return intOf(raw.get(keyOf(TYPE.stackItem, top)), 'ActivatingPlayer');
		},
		creatureCount(): number | null {
			if (who === null) return null;
			const player = raw.get(keyOf(TYPE.player, who));
			if (player === undefined) return null;
			let creatures = 0;
			for (const id of idsOf(player, 'Battlefield')) {
				const card = raw.get(keyOf(TYPE.card, id));
				const face = raw.get(keyOf(TYPE.cardState, id * 16 + (intOf(card, 'CurrentState') ?? 0)));
				const type = tagged(face, 'Type') as { t: string; core?: unknown } | undefined;
				const core = type?.t === 'cardtype' && Array.isArray(type.core) ? (type.core as unknown[]) : null;
				if (core === null || core.includes('Creature')) creatures += 1;
			}
			return creatures;
		},
		turnNumber(): number | null {
			const game = [...raw.values()].find((o) => o._type === TYPE.game);
			return intOf(game, 'Turn');
		},
		phase(): string | null {
			return enumOf([...raw.values()].find((o) => o._type === TYPE.game), 'Phase');
		},
	};
}
