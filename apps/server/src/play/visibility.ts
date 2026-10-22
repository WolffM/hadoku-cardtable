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
 * ## What a seat was shown, it keeps
 *
 * Forge shows a seat a card in a hidden zone for a moment — a reveal
 * (`PlayerControllerHuman.reveal` → `tempShowCards`, undone by
 * `endTempShowCards` once the reveal is answered), the hand a Thoughtseize
 * looks at, a library search — or for as long as a static says (Courser of
 * Kruphix's `MayLookAt`, which follows the TOP card and lets go of it the
 * moment it is drawn). Read as Forge's grant alone, the projection took every
 * one of them back: a revealed hand went face down again when the reveal
 * closed, and Goblin Guide's revealed top card was a stranger once drawn. The
 * operator, 2026-10-13: *"revealed hand information should always be
 * revealed … if goblin guide reveals top of deck. And then that card is
 * drawn, it should be revealed in the hand."*
 *
 * So the projector keeps, per seat, the cards it has been shown in a hand or
 * a library ({@link STICKY_ZONES}) and where each one was, and sends such a
 * card in full for exactly as long as the seat could still name it at a real
 * table:
 *
 *   - it stays in that hand, or that library unshuffled — a library whose
 *     common cards change order was shuffled, and every card the seat knew in
 *     it is forgotten. The cards a look let the player see are left out of
 *     that reading, in the packet the look ended and the one before: the look
 *     moves them itself (a scry's bottom card), and the player saw where;
 *   - a known library card drawn into its holder's hand stays known there;
 *   - any other move forgets it — discarded, put back from the hand, cast: the
 *     seat sees it while it is public, and once it is hidden again it is known
 *     only by the way in below. A card in no zone list at all (between two,
 *     or on the stack) is judged where it lands. A card that left and came
 *     back inside one packet (Timetwister shuffles a hand away and deals a new
 *     one) is in the same list on both sides of it, but Forge made it a new
 *     object on the way (`GameAction.changeZone` copies a card that changes
 *     zones, CR 400.7) and sends it as one — the card replaced in the
 *     packet's `newObjects` ({@link replacedCards}) — so it is judged as moved.
 *     Unless it is a library card that stands where it last stood in that
 *     library, as its holder's library had it the last time it was in one:
 *     a fate seal's kept card is taken out of the library and put back on
 *     top (`DigEffect`), and when the look's end reaches the seat in two
 *     packets instead of one the card can come back as a replace. Put back
 *     where it was taken from, it was not lost; the shuffle rule above still
 *     reads the library around it.
 *
 * The ways in, one set: a card whose Forge grant (`PlayerMayLook`) reaches
 * this seat while it sits in SOMEONE ELSE's hand or library; the cards of a
 * reveal the server answered ({@link SeatProjector.learn}) — because Forge may
 * grant and take back the look inside one packet, and a reveal is the one
 * place the seat is told outright that it was shown a card, its own included
 * (Goblin Guide's top card is revealed to its owner too); and two that reach
 * the seat's OWN library too:
 *
 *   - a look at the top of a library — Forge grants this seat that library's
 *     top cards and none under them: a scry, a fate seal, Sensei's Divining
 *     Top, Ponder, Courser of Kruphix. The operator, 2026-10-19: *"when 'fate
 *     seal' happens and the card stays on top, it should stay revealed for the
 *     player who has that knowledge … we should also utilize this zone for when
 *     you have cards that let you look at the top of your library"*. A look at
 *     a WHOLE library is a search, not this, and is not kept: the library is
 *     shuffled when it ends, and what the seat chose there is its decision
 *     window's, never the table's (`e2e/w70-nissa.spec.ts`);
 *   - the cards the seat put on top of its own library from its own hand
 *     (Brainstorm), from the top down, unless that packet shuffled it.
 *
 * And one that reaches every player but the hand's holder: a card the whole
 * table could see — face up on the battlefield, in a graveyard, in exile, on
 * the stack — that goes to a hand. Jace's −1 and Unsummon bounce it, Regrowth
 * returns it from a graveyard, Remand from the stack: everyone watched which
 * card it was. The operator, 2026-10-19: *"returned a card to hand with Jace,
 * why is it not showing as revealed?"* Not when that packet shuffled the
 * holder's library or put a card into it: Timetwister shuffles a graveyard in
 * and deals a new hand inside one packet, and a card dealt that way went
 * through a library on its way, where the table lost it.
 *
 * Which of a library's known cards a screen draws on it is the client's: the
 * top ones, in order, while no card it does not know is above them
 * (`apps/ui/src/play/adapter.ts`, `knownTop`).
 *
 * ## What the other seats were shown, the owner is told
 *
 * The same set is kept for every OTHER player too, from the same ways in — Forge's grant, read
 * off the same raw state, a reveal the server answered for that seat
 * ({@link SeatProjector.learn} with its `learner`), and a card the table saw go to a hand — and
 * forgotten by the same rule. It is never
 * used to show this seat anything; it is how this seat is told which of the cards IT holds in a
 * hand or a library another player still knows. The operator, 2026-10-15: *"let's also create an
 * 'eye' pill for cards that have been revealed to your opponent"*. Said in Forge's own words, as a
 * known card is: each such player is in the card's `PlayerMayLook` as this seat receives it. Only
 * on a card this seat holds — and, so a screen can tell a card only it knows from one the table
 * saw (a fate seal from Goblin Guide's reveal), on a library card this seat itself knows, whose
 * holder is named when it was shown that card too. So a seat learns nothing about anyone's
 * knowledge but of cards it holds or knows — and nothing it could not have watched happen.
 *
 * ## What it cannot fix
 *
 * A shuffle is read off the order of the cards the player did not just look
 * at. A library holding at most one such card can be shuffled without the
 * order saying so; the bridge sends no shuffle event (`PlayBridge.java` never
 * encodes events), so a card known there stays known.
 *
 * Card ids are stable in Forge. A library is an ordered id list, so a card the
 * viewer has SEEN (it was on the battlefield, it was revealed) and that is later
 * shuffled back in can be followed by id. Forge's own client has the same
 * property; its mitigation is `HiddenId`, which this projection passes through
 * for exactly that reason. Closing it needs id remapping on the server, which
 * would break every reference Forge makes — recorded in `README.md`, not fixed.
 */

import {
	boolOf,
	cardIdOfState,
	coreTypes,
	currentFace,
	DELTA_TYPE,
	deltaKey,
	deltaKeyType,
	enumOf,
	idsOf,
	intOf,
	tagOf,
	type CantBlock,
	type ConditionMet,
	type Damage,
	type Deaths,
	type FaceDamage,
	type PendingTriggers,
	type PrintedPT,
	type PrintedTypes,
	type StateSiblings,
	type TokenSources,
	type WaitingEffects,
} from '@hadoku/forge-wire';

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

/** The three Tier C frames, loosely typed for the projector's own use. */
export type StateFrame =
	| { kind: 'notify'; method: 'setGameView'; payload: { gameView: ObjTable; sequenceNumber: number } & StateSiblings }
	| { kind: 'notify'; method: 'openView'; payload: { myPlayers: number[] } }
	| { kind: 'notify'; method: 'applyDelta'; payload: { packet: DeltaPacketJson; damage?: Damage; deaths?: Deaths; faceDamage?: FaceDamage } & StateSiblings };

export type Visibility = 'full' | 'faceOnly' | 'hidden';

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

/** The hidden zones a card the seat was shown stays known in — see the header. */
const STICKY_ZONES = new Set(['Hand', 'Library']);

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
		if (obj._type !== DELTA_TYPE.player) continue;
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
	const card = state.get(deltaKey(DELTA_TYPE.card, cardId));
	if (card === undefined) return 'hidden';

	const listed = zones.byCard.get(cardId);
	const zone = listed?.zone ?? enumOf(card, 'Zone');
	if (viewer === null) return publicVisibility(card, zone);
	const controller = intOf(card, 'Controller') ?? listed?.holder ?? intOf(card, 'Owner');
	const mayLook = idsOf(card, 'PlayerMayLook').includes(viewer);
	const master = controller === null ? null : intOf(state.get(deltaKey(DELTA_TYPE.player, controller)), 'MindSlaveMaster');
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
	const current = intOf(state.get(deltaKey(DELTA_TYPE.card, cardIdOfState(csvId))), 'CurrentState') ?? 0;
	return csvOrdinal(csvId) === current;
}

/**
 * A replacement that empties a face the viewer may no longer hold. `null`
 * deletes (fold rule 3), and one property keeps it a valid tracked object.
 */
function wipeFace(csvId: number): WireObj {
	return { _type: DELTA_TYPE.cardState, _id: csvId, Name: null };
}

/**
 * Whether the cards `before` and `now` share, leaving out `looked`, stand in a different order in
 * `now` — a shuffle. Cards drawn, milled or put on top are not shared and say nothing; nor do the
 * cards a look let the player see, which the look itself moves (a scry's bottom card, a fate seal's).
 */
function reordered(before: readonly number[], now: readonly number[], looked: ReadonlySet<number>): boolean {
	const inNow = new Set(now);
	const inBefore = new Set(before);
	const was = before.filter((id) => inNow.has(id) && !looked.has(id));
	const is = now.filter((id) => inBefore.has(id) && !looked.has(id));
	return was.some((id, i) => is[i] !== id);
}

/** Each card's `PlayerMayLook` in `state`, for the cards that have one. */
function grantsOf(state: ReadonlyMap<string, WireObj>): Map<number, number[]> {
	const out = new Map<number, number[]>();
	for (const obj of state.values()) {
		if (obj._type !== DELTA_TYPE.card) continue;
		const look = idsOf(obj, 'PlayerMayLook');
		if (look.length > 0) out.set(obj._id, look);
	}
	return out;
}

/**
 * The cards `packet` replaces whole: a card key in its `newObjects` that `state` already holds.
 * Forge sends an existing id as a new object only when it is a new `CardView` instance
 * (`DeltaSyncManager.collectObjectDelta`, "New or replacement"), which is what moving zones makes
 * (`GameAction.changeZone` → `CardCopyService.copyCard`).
 */
function replacedCards(state: ReadonlyMap<string, WireObj>, packet: DeltaPacketJson): Set<number> {
	const out = new Set<number>();
	for (const [key, obj] of Object.entries(packet.newObjects)) if (obj._type === DELTA_TYPE.card && state.has(key)) out.add(obj._id);
	return out;
}

/* ── The projector ───────────────────────────────────────────────────── */

export interface SeatProjector {
	/** The Forge PlayerView id this seat sees as, from `openView`. */
	readonly viewer: number | null;
	setViewer(playerId: number): void;
	/** One raw Tier C frame in, the frame this seat may receive out. */
	project(frame: StateFrame): StateFrame;
	/** Current visibility of a card for this seat, a card it was shown and still knows included. */
	visibilityOf(cardId: number): Visibility;
	/**
	 * `learner` (this seat when absent) was shown these cards (a reveal the server answered): each
	 * one in a hand or a library is known to it from now on, as the header says. Returns the packet
	 * that sends this seat what that changes — the cards it did not already hold, or which of its
	 * own another player now knows — or null when nothing changes.
	 */
	learn(cardIds: Iterable<number>, learner?: number): StateFrame | null;
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
	 * The core types (`Instant`, `Creature`, …) of the SPELL on top of the stack, or null
	 * when the stack is empty, its top is an ability, or its card's face is not known.
	 * Public, as {@link stackTopActivator} is: the stack is on the table.
	 */
	stackTopSpellTypes(): readonly string[] | null;
	/** A card's current face name and the zone list that holds it, each null when the state does not say. */
	cardAt(cardId: number): { name: string | null; zone: string | null };
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
	/** Per player, the cards it was shown in a sticky zone, and where they were then — see the header. */
	const known = new Map<number, Map<number, { zone: string; holder: number }>>();
	/** What the client was last given as each `full` card's `PlayerMayLook`, as {@link lookKey} writes it. */
	const sentLook = new Map<number, string>();
	/** Each player's library as last folded, top first — what a shuffle is read against. */
	const libraries = new Map<number, number[]>();
	/** Where each card last stood in a library, kept while it is in no zone list — what a card Forge re-creates there is read against. */
	const libraryPlaces = new Map<number, { holder: number; index: number }>();
	/** Forge's `PlayerMayLook` grants as last folded — a look that ended in this packet still explains its moves. */
	let grantsBefore = new Map<number, number[]>();
	/** The cards the whole table could see as of the last packet — {@link tableCards}. */
	let onTable = new Set<number>();
	let lastSeq = 0;
	let who = viewer;
	/** The zone index of the raw state as last folded — {@link visibilities} rebuilds it once per packet. */
	let zonesNow: ZoneIndex | null = null;

	function knownTo(player: number): Map<number, { zone: string; holder: number }> {
		let cards = known.get(player);
		if (cards === undefined) {
			cards = new Map();
			known.set(player, cards);
		}
		return cards;
	}

	/**
	 * Bring {@link known} up to the raw state: forget what moved or was shuffled, follow a
	 * library card into its holder's hand. Run once per packet, before visibility is read.
	 */
	function settleKnown(zones: ZoneIndex, replaced: ReadonlySet<number>, zonesBefore: ZoneIndex | null): void {
		const grants = grantsOf(raw);
		/** Whether `player` was let look at `cardId` in this packet or the one before it. */
		const looked = (player: number, cardId: number): boolean => [grants, grantsBefore].some((g) => g.get(cardId)?.includes(player) === true);
		const before = new Map(libraries);
		const nowOf = new Map<number, number[]>();
		for (const obj of raw.values()) {
			if (obj._type !== DELTA_TYPE.player) continue;
			nowOf.set(obj._id, idsOf(obj, 'Library'));
			libraries.set(obj._id, idsOf(obj, 'Library'));
		}
		/** Whether `holder`'s library was shuffled, read past the cards `player` looked at. */
		const shuffledFor = (player: number, holder: number): boolean => {
			const was = before.get(holder);
			const now = nowOf.get(holder);
			if (was === undefined || now === undefined) return false;
			return reordered(was, now, new Set([...was, ...now].filter((id) => looked(player, id))));
		};
		/** Whether a card Forge re-created stands where it last stood in that library: put back where it was taken from. */
		const putBack = (cardId: number, at: { zone: string; holder: number }): boolean => {
			const place = libraryPlaces.get(cardId);
			return at.zone === 'Library' && place?.holder === at.holder && nowOf.get(at.holder)?.indexOf(cardId) === place.index;
		};
		for (const [player, cards] of known) {
			const shuffled = new Map<number, boolean>();
			for (const [cardId, was] of cards) {
				const at = zones.byCard.get(cardId);
				// In no zone list: between two (Goblin Guide's Dig takes the card out and puts it back on
				// top) or on the stack. Nothing to judge it by until it lands somewhere.
				if (at === undefined && raw.has(deltaKey(DELTA_TYPE.card, cardId))) continue;
				if (at !== undefined && at.holder === was.holder && at.zone === was.zone && (!replaced.has(cardId) || putBack(cardId, at))) {
					if (was.zone !== 'Library') continue;
					if (!shuffled.has(was.holder)) shuffled.set(was.holder, shuffledFor(player, was.holder));
					if (shuffled.get(was.holder) === true) cards.delete(cardId);
				} else if (at !== undefined && at.holder === was.holder && was.zone === 'Library' && at.zone === 'Hand' && at.holder !== player) {
					cards.set(cardId, at);
				} else {
					cards.delete(cardId);
				}
			}
		}
		/** Whether `holder`'s library took in a card it did not hold before — Timetwister's graveyard and hand. */
		const fedFor = (holder: number): boolean => {
			const was = new Set(before.get(holder) ?? []);
			return (nowOf.get(holder) ?? []).some((id) => !was.has(id));
		};
		for (const [cardId, at] of zones.byCard) {
			if (at.zone !== 'Hand' || !onTable.has(cardId) || fedFor(at.holder)) continue;
			for (const player of nowOf.keys()) if (player !== at.holder && !shuffledFor(player, at.holder)) knownTo(player).set(cardId, at);
		}
		for (const [holder, library] of nowOf) library.forEach((cardId, index) => libraryPlaces.set(cardId, { holder, index }));
		for (const [cardId, at] of zones.byCard) if (at.zone !== 'Library') libraryPlaces.delete(cardId);
		onTable = tableCards(zones);
		if (who !== null) learnOwnTop(who, zones, zonesBefore, nowOf.get(who) ?? [], shuffledFor(who, who));
		grantsBefore = grants;
	}

	/**
	 * The cards the whole table can see now: face up in a public zone, by its zone list, or by its
	 * own `Zone` when it is in none (on the stack). A card between two lists stays as it was, unless
	 * it says it is in a library already.
	 */
	function tableCards(zones: ZoneIndex): Set<number> {
		const out = new Set<number>();
		for (const obj of raw.values()) {
			if (obj._type !== DELTA_TYPE.card) continue;
			const listed = zones.byCard.get(obj._id);
			const zone = listed?.zone ?? enumOf(obj, 'Zone');
			const now = zone !== null && publicVisibility(obj, zone) === 'full';
			if (now || (listed === undefined && zone !== 'Library' && onTable.has(obj._id))) out.add(obj._id);
		}
		return out;
	}

	/**
	 * What this seat put on top of its own library from its own hand (Brainstorm, Jace's 0) it knows
	 * there, from the top down — never after a shuffle in the same packet, and never a card under one
	 * it does not know.
	 */
	function learnOwnTop(self: number, zones: ZoneIndex, zonesBefore: ZoneIndex | null, library: readonly number[], shuffled: boolean): void {
		if (zonesBefore === null || shuffled) return;
		const cards = knownTo(self);
		for (const cardId of library) {
			const was = zonesBefore.byCard.get(cardId);
			if (was !== undefined && was.zone === 'Hand' && was.holder === self) cards.set(cardId, zones.byCard.get(cardId)!);
			else if (!cards.has(cardId)) return;
		}
	}

	/**
	 * A look at the top of a library: Forge lets this seat see that library's top cards and no others
	 * (a scry, a fate seal, Sensei's Divining Top, Courser of Kruphix). Kept like a reveal, its own
	 * library included. A look at a whole library is a search, not this: the library is shuffled when
	 * it ends, and what the seat chose there is the decision window's (`e2e/w70-nissa.spec.ts`).
	 */
	function noteTopLooks(zones: ZoneIndex): void {
		if (who === null) return;
		for (const [holder, library] of libraries) {
			let top = 0;
			while (top < library.length && cardVisibility(raw, zones, library[top]!, who) === 'full') top += 1;
			if (top === 0 || top === library.length) continue;
			if (library.slice(top).some((id) => cardVisibility(raw, zones, id, who) === 'full')) continue;
			for (const cardId of library.slice(0, top)) knownTo(who).set(cardId, { zone: 'Library', holder });
		}
	}

	/** Every player but this seat's, by the raw state's PlayerViews. */
	function others(): number[] {
		const out: number[] = [];
		for (const obj of raw.values()) if (obj._type === DELTA_TYPE.player && obj._id !== who) out.push(obj._id);
		return out;
	}

	/** A Forge grant to another player on a card this seat holds in a sticky zone is remembered, as this seat's own is in {@link seen}. */
	function noteOthersShown(zones: ZoneIndex): void {
		if (who === null) return;
		const players = others();
		for (const [cardId, at] of zones.byCard) {
			if (at.holder !== who || !STICKY_ZONES.has(at.zone)) continue;
			for (const p of players) if (cardVisibility(raw, zones, cardId, p) === 'full') knownTo(p).set(cardId, at);
		}
	}

	/** {@link cardVisibility}, with what this seat was shown: a Forge grant in a sticky zone is remembered, and a remembered card is `full`. */
	function seen(zones: ZoneIndex, cardId: number): Visibility {
		const vis = cardVisibility(raw, zones, cardId, who);
		if (who === null) return vis;
		const at = zones.byCard.get(cardId);
		if (vis === 'full') {
			if (at !== undefined && at.holder !== who && STICKY_ZONES.has(at.zone)) knownTo(who).set(cardId, at);
			return vis;
		}
		return knownTo(who).has(cardId) ? 'full' : vis;
	}

	/** Every card id the raw state knows, with its faces. */
	function cardsAndFaces(): Map<number, string[]> {
		const out = new Map<number, string[]>();
		for (const [key, obj] of raw) {
			if (obj._type === DELTA_TYPE.card) {
				if (!out.has(obj._id)) out.set(obj._id, []);
			} else if (obj._type === DELTA_TYPE.cardState) {
				const cardId = cardIdOfState(obj._id);
				const faces = out.get(cardId) ?? [];
				faces.push(key);
				out.set(cardId, faces);
			}
		}
		return out;
	}

	function visibilities(replaced: ReadonlySet<number> = new Set()): Map<number, Visibility> {
		const zones = indexZones(raw);
		const zonesBefore = zonesNow;
		zonesNow = zones;
		settleKnown(zones, replaced, zonesBefore);
		noteTopLooks(zones);
		noteOthersShown(zones);
		const out = new Map<number, Visibility>();
		for (const cardId of cardsAndFaces().keys()) out.set(cardId, seen(zones, cardId));
		return out;
	}

	/**
	 * A `full` card's `PlayerMayLook` as this seat is sent it: Forge's grant, this seat when it KNOWS
	 * the card, — on a card this seat holds — every other player that knows it (the header's
	 * "What the other seats were shown"), and on a card this seat knows in someone else's library,
	 * that library's holder when it was shown it too (Goblin Guide's reveal, not a fate seal). A card sent in full because the seat knows it, not because
	 * Forge grants it, so says so in Forge's own words: a client reads one field for "I may look at
	 * this card" whichever of the two put it there — and a client fed Forge's raw stream, where a
	 * hand card carries its name for everybody, still draws it as a back (`Board.test.ts`).
	 */
	function lookOf(cardId: number): number[] {
		const look = idsOf(raw.get(deltaKey(DELTA_TYPE.card, cardId)), 'PlayerMayLook');
		if (who === null) return look;
		const add = (p: number): void => {
			if (!look.includes(p)) look.push(p);
		};
		if (knownTo(who).has(cardId)) add(who);
		const at = (zonesNow ?? indexZones(raw)).byCard.get(cardId);
		if (at?.holder === who) for (const [p, cards] of known) if (p !== who && cards.has(cardId)) add(p);
		if (at !== undefined && at.holder !== who && at.zone === 'Library' && knownTo(who).has(cardId) && knownTo(at.holder).has(cardId)) add(at.holder);
		return look;
	}

	function lookKey(look: readonly number[]): string {
		return [...look].sort((a, b) => a - b).join(',');
	}

	function lookValue(look: readonly number[]): { t: 'list'; v: { t: 'int'; v: number }[] } | null {
		return look.length === 0 ? null : { t: 'list', v: look.map((v) => ({ t: 'int', v })) };
	}

	function stamped(obj: WireObj): WireObj {
		const granted = idsOf(raw.get(deltaKey(DELTA_TYPE.card, obj._id)), 'PlayerMayLook');
		const look = lookOf(obj._id);
		if (lookKey(look) === lookKey(granted)) return obj;
		return { ...obj, PlayerMayLook: lookValue(look) };
	}

	/**
	 * Every `full` card whose `PlayerMayLook` this seat would now be sent differently from what it
	 * holds — a player came to know one of its cards, or forgot it, with nothing else about the card
	 * changing — gets it in this packet: inside the card's replace when the packet already has one,
	 * otherwise as a delta of that one property.
	 */
	function syncLooks(vis: Map<number, Visibility>, newObjects: ObjTable, objectDeltas: ObjTable): void {
		for (const [cardId, v] of vis) {
			if (v !== 'full') {
				sentLook.delete(cardId);
				continue;
			}
			const look = lookOf(cardId);
			const key = lookKey(look);
			if (sentLook.get(cardId) === key) continue;
			sentLook.set(cardId, key);
			const cardKey = deltaKey(DELTA_TYPE.card, cardId);
			if (newObjects[cardKey] !== undefined) continue;
			objectDeltas[cardKey] = { ...(objectDeltas[cardKey] ?? { _type: DELTA_TYPE.card, _id: cardId }), PlayerMayLook: lookValue(look) };
		}
	}

	/** Project one object by its key; null when the viewer gets nothing for it. */
	function projectObject(key: string, obj: WireObj, vis: Map<number, Visibility>): WireObj | null {
		const type = deltaKeyType(Number(key));
		if (type === DELTA_TYPE.card) {
			const v = vis.get(obj._id) ?? 'hidden';
			const out = redactCard(obj, v);
			return out !== null && v === 'full' ? stamped(out) : out;
		}
		if (type === DELTA_TYPE.cardState) {
			const v = vis.get(cardIdOfState(obj._id)) ?? 'hidden';
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
		const replaced = replacedCards(raw, packet);
		foldInto(raw, packet);
		lastSeq = packet.seq;
		const vis = visibilities(replaced);
		const newObjects = projectTable(packet.newObjects, vis);
		const objectDeltas = projectTable(packet.objectDeltas, vis);
		const faces = cardsAndFaces();

		for (const [cardId, now] of vis) {
			const before = sent.get(cardId);
			if (before === undefined || before === now) continue;
			const cardKey = deltaKey(DELTA_TYPE.card, cardId);
			const card = raw.get(cardKey);
			if (card === undefined) continue;
			// Re-send the card whole-as-allowed, as a replace.
			const redacted = redactCard(card, now);
			if (redacted !== null) newObjects[cardKey] = now === 'full' ? stamped(redacted) : redacted;
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
		syncLooks(vis, newObjects, objectDeltas);

		return { seq: packet.seq, checksum: 0, checksumProperties: [], newObjects, objectDeltas, events: [] };
	}

	/**
	 * The waiting triggers this seat may see: one whose card it may not see would name that card
	 * (`key` is the card's words), so it is dropped here, as the card's name is everywhere else.
	 */
	function pendingSeen(pending: PendingTriggers | undefined): { pendingTriggers?: PendingTriggers } {
		if (pending === undefined) return {};
		const zones = indexZones(raw);
		return { pendingTriggers: pending.filter((t) => seen(zones, t.hostCard) === 'full') };
	}

	/** The waiting effects this seat may see: the same rule, by the card that made each one (its words name it). */
	function effectsSeen(effects: WaitingEffects | undefined): { waitingEffects?: WaitingEffects } {
		if (effects === undefined) return {};
		const zones = indexZones(raw);
		return { waitingEffects: effects.filter((e) => cardVisibility(raw, zones, e.source, who) === 'full') };
	}

	/** Which card made each token, for the sources this seat may see: the pair names that card. */
	function tokensSeen(tokens: TokenSources | undefined): { tokenSources?: TokenSources; cantBlock?: CantBlock } {
		if (tokens === undefined) return {};
		const zones = indexZones(raw);
		return { tokenSources: tokens.filter(([, source]) => cardVisibility(raw, zones, source, who) === 'full') };
	}

	/**
	 * The creatures that can't block, for the cards this seat is sent at all: a battlefield creature
	 * is public, and a face-down one's restriction is its face-down card's, so it reads as itself.
	 */
	function cantBlockSeen(ids: CantBlock | undefined): { cantBlock?: CantBlock } {
		if (ids === undefined) return {};
		const zones = indexZones(raw);
		return { cantBlock: ids.filter((id) => cardVisibility(raw, zones, id, who) !== 'hidden') };
	}

	/** The printed type lines, for the cards this seat is sent at all: a battlefield permanent is public, and the bridge never names a face-down one. */
	function printedTypesSeen(pairs: PrintedTypes | undefined): { printedTypes?: PrintedTypes } {
		if (pairs === undefined) return {};
		const zones = indexZones(raw);
		return { printedTypes: pairs.filter(([id]) => cardVisibility(raw, zones, id, who) !== 'hidden') };
	}

	/** The printed power and toughness, for the cards this seat is sent at all: a battlefield creature is public, and the bridge never names a face-down one. */
	function printedPTSeen(rows: PrintedPT | undefined): { printedPT?: PrintedPT } {
		if (rows === undefined) return {};
		const zones = indexZones(raw);
		return { printedPT: rows.filter(([id]) => cardVisibility(raw, zones, id, who) !== 'hidden') };
	}

	/**
	 * The cards whose condition is on, for the faces this seat may read: a card in the other seat's
	 * hand, or a face-down one, says nothing — whether its condition is on would say what it is.
	 */
	function conditionMetSeen(ids: ConditionMet | undefined): { conditionMet?: ConditionMet } {
		if (ids === undefined) return {};
		const zones = indexZones(raw);
		return { conditionMet: ids.filter((id) => cardVisibility(raw, zones, id, who) === 'full') };
	}

	/**
	 * The damage dealt, for the cards this seat is sent at all — a battlefield creature is public, so
	 * in practice every hit — with a source this seat may not see named as none (-1).
	 */
	function damageSeen(hits: Damage | undefined): { damage?: Damage } {
		if (hits === undefined) return {};
		const zones = indexZones(raw);
		const seen = hits.filter(([target]) => cardVisibility(raw, zones, target, who) !== 'hidden');
		return seen.length === 0
			? {}
			: { damage: seen.map(([target, source, amount]) => [target, source >= 0 && cardVisibility(raw, zones, source, who) !== 'hidden' ? source : -1, amount] as const) };
	}

	/** The damage dealt to players — every player is public — with a source this seat may not see named as none (-1). */
	function faceDamageSeen(hits: FaceDamage | undefined): { faceDamage?: FaceDamage } {
		if (hits === undefined || hits.length === 0) return {};
		const zones = indexZones(raw);
		return { faceDamage: hits.map(([player, source, amount, combat]) => [player, source >= 0 && cardVisibility(raw, zones, source, who) !== 'hidden' ? source : -1, amount, combat] as const) };
	}

	/** Why each permanent died, for the cards this seat is sent at all: a graveyard is public, so in practice every one. */
	function deathsSeen(deaths: Deaths | undefined): { deaths?: Deaths } {
		if (deaths === undefined) return {};
		const zones = indexZones(raw);
		const seen = deaths.filter(([card]) => cardVisibility(raw, zones, card, who) !== 'hidden');
		return seen.length === 0 ? {} : { deaths: seen };
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
					zonesNow = null;
					sent.clear();
					sentLook.clear();
					libraries.clear();
					grantsBefore = new Map();
					onTable = new Set();
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
					for (const [cardId, v] of vis) if (v === 'full') sentLook.set(cardId, lookKey(lookOf(cardId)));
					return {
						kind: 'notify',
						method: 'setGameView',
						payload: {
							gameView: projectTable(frame.payload.gameView, vis),
							sequenceNumber: frame.payload.sequenceNumber,
							// Passed through UNREDACTED: both
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
							...tokensSeen(frame.payload.tokenSources),
							...cantBlockSeen(frame.payload.cantBlock),
							...printedTypesSeen(frame.payload.printedTypes),
							...printedPTSeen(frame.payload.printedPT),
							...(frame.payload.lifePaying === undefined ? {} : { lifePaying: frame.payload.lifePaying }),
							...conditionMetSeen(frame.payload.conditionMet),
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
							...tokensSeen(frame.payload.tokenSources),
							...cantBlockSeen(frame.payload.cantBlock),
							...printedTypesSeen(frame.payload.printedTypes),
							...printedPTSeen(frame.payload.printedPT),
							...(frame.payload.lifePaying === undefined ? {} : { lifePaying: frame.payload.lifePaying }),
							...conditionMetSeen(frame.payload.conditionMet),
							...damageSeen(frame.payload.damage),
							...deathsSeen(frame.payload.deaths),
							...faceDamageSeen(frame.payload.faceDamage),
						},
					};
			}
		},
		visibilityOf(cardId: number): Visibility {
			return seen(indexZones(raw), cardId);
		},
		learn(cardIds: Iterable<number>, learner?: number): StateFrame | null {
			const shownTo = learner ?? who;
			if (who === null || shownTo === null) return null;
			const zones = indexZones(raw);
			for (const cardId of cardIds) {
				const at = zones.byCard.get(cardId);
				if (at !== undefined && STICKY_ZONES.has(at.zone)) knownTo(shownTo).set(cardId, at);
			}
			const packet = projectPacket({ seq: lastSeq, checksum: 0, checksumProperties: [], newObjects: {}, objectDeltas: {}, events: [] });
			return Object.keys(packet.newObjects).length === 0 && Object.keys(packet.objectDeltas).length === 0
				? null
				: { kind: 'notify', method: 'applyDelta', payload: { packet } };
		},
		stackTopActivator(): number | null {
			// `GameView.Stack` is the stack item ids, TOP FIRST (`apps/ui/src/play/adapter.ts`).
			const game = [...raw.values()].find((o) => o._type === DELTA_TYPE.game);
			const top = idsOf(game, 'Stack')[0];
			if (top === undefined) return null;
			return intOf(raw.get(deltaKey(DELTA_TYPE.stackItem, top)), 'ActivatingPlayer');
		},
		stackTopSpellTypes(): readonly string[] | null {
			const game = [...raw.values()].find((o) => o._type === DELTA_TYPE.game);
			const top = idsOf(game, 'Stack')[0];
			if (top === undefined) return null;
			const item = raw.get(deltaKey(DELTA_TYPE.stackItem, top));
			if (item === undefined || boolOf(item, 'Ability')) return null;
			const source = intOf(item, 'SourceCard');
			return source === null ? null : coreTypes(raw, source);
		},
		cardAt(cardId: number): { name: string | null; zone: string | null } {
			const face = currentFace(raw, cardId);
			const name = tagOf(face, 'Name') ?? tagOf(raw.get(deltaKey(DELTA_TYPE.card, cardId)), 'Name');
			return {
				name: name?.t === 'str' && typeof name.v === 'string' && name.v !== '' ? name.v : null,
				zone: indexZones(raw).byCard.get(cardId)?.zone ?? null,
			};
		},
		creatureCount(): number | null {
			if (who === null) return null;
			const player = raw.get(deltaKey(DELTA_TYPE.player, who));
			if (player === undefined) return null;
			let creatures = 0;
			for (const id of idsOf(player, 'Battlefield')) {
				const core = coreTypes(raw, id);
				if (core === null || core.includes('Creature')) creatures += 1;
			}
			return creatures;
		},
		turnNumber(): number | null {
			const game = [...raw.values()].find((o) => o._type === DELTA_TYPE.game);
			return intOf(game, 'Turn');
		},
		phase(): string | null {
			return enumOf([...raw.values()].find((o) => o._type === DELTA_TYPE.game), 'Phase');
		},
	};
}
