/**
 * What cardtable's plugins build and share: each plugin fills its own fields in its boot phase
 * (`index.ts` lists them in order), and a later plugin reads them. A field read in a callback is
 * read when the callback runs, so a closure may name a field a later plugin fills, as the old
 * single-file boot's closures named a later `const`.
 */
import type { GamePlugin } from '@hadoku/service-kernel/server';
import type { JsonLog } from '@hadoku/service-kernel/log';
import type { DraftPlan, PoolVerdict } from '@hadoku/shared';
import type { RestoredRooms } from '../boot.js';
import type { ForgetfulPeople } from '../people.js';
import type { Featured } from '../play/featured.js';
import type { ParkedStore } from '../play/parked.js';
import type { Placement } from '../play/placement/index.js';
import type { JvmHostFactory } from '../play/host.js';
import type { PlayHandle, jvmHostConfig, roomDeckCosts } from '../play/index.js';
import type { Recorder } from '../play/recording/recorder.js';
import type { ArtKeys } from '../pools/art-keys.js';
import type { CardCatalog } from '../pools/catalog.js';
import type { CubeStore } from '../pools/cubes.js';
import type { ForgePools } from '../pools/forge.js';
import type { PresetStore } from '../pools/presets.js';
import type { SetsStore } from '../pools/sets.js';
import type { Events } from '../room/events.js';
import type { AnonymisableTournaments } from '../room/tournaments.js';
import type { attachDraftSocket } from '../room/socket.js';
import type { attachRoomFeed } from '../room/feed.js';
import type { RoomStreams } from '../stream/alloc.js';
import type { KeyBook } from '../stats/keys.js';
import type { MatchStats } from '../stats/index.js';
import type { TablesHandle } from '../http/routes.js';
import type { loadTablesLibrary } from '../http/index.js';
import type { fleetCli } from '../play/placement/index.js';
import type { Challenges } from '../room/challenge.js';

/** Cardtable's plugins declare no bus events of their own yet. */
export type CardtableEvents = Record<never, never>;

export interface Cardtable {
	/** The server package's root and this instance's checkout: `index.ts` computes both, one level below the package. */
	readonly pkgRoot: string;
	readonly repoRoot: string;

	// bundle
	placementLog: JsonLog;
	primedFleet: ReturnType<typeof fleetCli> | undefined;

	// stores
	library: ReturnType<typeof loadTablesLibrary>;
	forge: ReturnType<typeof jvmHostConfig>;
	roomsLog: JsonLog;
	tournaments: AnonymisableTournaments;
	events: Events;
	statsKeys: KeyBook;
	matchStats: MatchStats;
	shortlistDir: string;
	catalog: CardCatalog;
	artKeys: ArtKeys;
	cubeStore: CubeStore;
	forgePools: ForgePools | null;
	setsStore: SetsStore;
	defaultCubeCards: ReturnType<CubeStore['cards']> | null;
	checkDraftPlan: (plan: DraftPlan) => Promise<PoolVerdict>;
	lobby: RestoredRooms['lobby'];
	draftRooms: RestoredRooms['draftRooms'];
	runTestingRoomSeed: () => Promise<void>;
	/** The catalogued Challenges (`room/challenge.ts`). */
	challenges: Challenges;
	/** Keeps the operator's standing Challenge room when the env names one (`plugins/rooms.ts`). */
	runChallengeSeed: () => void;
	roomClosed: (roomId: string, matches: readonly string[]) => void;
	roomForfeited: (roomId: string, tableId: string, loser: string, matches: readonly string[]) => void;

	// routes
	streamLog: JsonLog;
	streamCount: number;
	roomStreams: RoomStreams | null;
	ensureRoomStreams: (roomKey: string) => void;
	people: ForgetfulPeople;
	featured: Featured;
	tables: TablesHandle;
	presetStore: PresetStore;
	deckCosts: ReturnType<typeof roomDeckCosts>;
	serverBuild: string;
	recorder: Recorder;
	parked: ParkedStore;

	// sockets
	draftSocket: ReturnType<typeof attachDraftSocket>;
	roomFeed: ReturnType<typeof attachRoomFeed>;
	clawHosts: Placement | null;
	localHost: JvmHostFactory | null;
	play: PlayHandle | null;
}

export type CardtablePlugin = GamePlugin<CardtableEvents, Cardtable>;
