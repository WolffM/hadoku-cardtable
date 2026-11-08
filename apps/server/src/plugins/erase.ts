/**
 * The account-erase steps for the stores the other plugins built, in this order: the person's live
 * games and rooms first, so a room closed here is archived before the tournaments are anonymised.
 * Last before listen, since it binds every store. `erase/` has the operator's rulings.
 */
import { join } from 'node:path';
import { CONFIG } from '../config.js';
import { legacyIdsStep } from '../erase/legacy-ids.js';
import { recordingsStep } from '../erase/recordings.js';
import { roomsEraseSteps } from '../erase/rooms.js';
import { endForfeitedGame } from '../http/table-actions.js';
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
				{ what: 'pods', erase: (p) => state.draftRooms?.erase(p.participantId, p.ids, p.placeholder) ?? { decks: 0, pods: 0 } },
				{ what: 'tournaments', erase: (p) => state.tournaments.anonymise(p.ids, p.placeholder) },
				{ what: 'events', erase: (p) => state.events.anonymise(p.ids, p.placeholder) },
				recordingsStep(CONFIG.recordingsDir),
				{ what: 'parked', erase: (p) => state.parked.forget(p.participantId) },
				{ what: 'presets', erase: (p) => state.presetStore.anonymise(p.ids, p.placeholder) },
				{ what: 'cubes', erase: (p) => state.cubeStore.anonymise(p.ids, p.placeholder) },
				legacyIdsStep(join(CONFIG.dataDir, 'legacy-ids.done.json')),
			],
		};
	},
};
