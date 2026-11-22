/**
 * The account-erase steps for the stores the other plugins built, in this order: the person's live
 * games and rooms first, so a room closed here is archived before the tournaments are anonymised.
 * Last before listen, since it binds every store. `erase/` has the operator's rulings.
 *
 * Each step's `merge` is its store's part of an account merge (`POST /api/_account/merge`; the
 * kernel's `erase.ts` has the contract): the kept account wins a conflict, the rest moves to it.
 * The rooms are moved before the pods, so a pod follows its room: a room still naming the
 * merged-away account after the rooms' merge is one the kept account conflicts in, and its pods
 * stay with it for the erase sweep.
 */
import { join } from 'node:path';
import { CONFIG } from '@hadoku/game-server/config';
import { legacyIdsStep } from '@hadoku/game-server/erase/legacy-ids';
import { recordingsStep } from '@hadoku/game-server/erase/recordings';
import { roomsEraseSteps } from '@hadoku/game-server/erase/rooms';
import { MAGIC_CONFIG } from '../config.js';
import { endForfeitedGame } from '../http/table-actions.js';
import { podOfDraftId } from '../room/pods.js';
import type { Match } from '../play/match.js';
import type { CardtablePlugin } from './state.js';

export const erasePlugin: CardtablePlugin = {
	name: 'erase',
	phase: 'sockets',
	setup({ state }) {
		return {
			erase: [
				...roomsEraseSteps<Match>({
					lobby: state.lobby,
					liveMatches: () => state.play?.matches.active() ?? [],
					forfeit: endForfeitedGame,
					closed: state.roomClosed,
					forfeited: state.roomForfeited,
				}),
				{
					what: 'pods',
					erase: (p) => state.draftRooms?.erase(p.participantId, p.ids, p.placeholder) ?? { decks: 0, pods: 0 },
					merge: (m) => state.draftRooms?.merge(m, (draftId) => state.lobby.names(podOfDraftId(draftId).roomId, m.from.ids)) ?? { decks: 0, pods: 0 },
				},
				{ what: 'tournaments', erase: (p) => state.tournaments.anonymise(p.ids, p.placeholder), merge: (m) => state.tournaments.merge(m) },
				{ what: 'events', erase: (p) => state.events.anonymise(p.ids, p.placeholder), merge: (m) => state.events.merge(m) },
				recordingsStep(MAGIC_CONFIG.recordingsDir),
				{ what: 'parked', erase: (p) => state.parked.forget(p.participantId), merge: (m) => state.parked.merge(m) },
				{ what: 'presets', erase: (p) => state.presetStore.anonymise(p.ids, p.placeholder), merge: (m) => state.presetStore.merge(m.renames) },
				{ what: 'cubes', erase: (p) => state.cubeStore.anonymise(p.ids, p.placeholder), merge: (m) => state.cubeStore.merge(m.renames) },
				legacyIdsStep(join(CONFIG.dataDir, 'legacy-ids.done.json')),
			],
		};
	},
};
