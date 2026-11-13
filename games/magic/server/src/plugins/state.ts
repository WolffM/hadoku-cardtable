/**
 * What cardtable's plugins build and share: each plugin fills its own fields in its boot phase
 * (the site's `apps/server/src/plugins/index.ts` lists them in order), and a later plugin reads them. A field read in a callback is
 * read when the callback runs, so a closure may name a field a later plugin fills, as the old
 * single-file boot's closures named a later `const`.
 */
import type { GamePlugin } from '@hadoku/service-kernel/server';
import type { JsonLog } from '@hadoku/service-kernel/log';
import type { PresenceTracker } from '@wolffm/rooms-server';
import type { DraftPlan, PoolVerdict } from '@hadoku/shared';
import type { RestoredRooms } from '../boot.js';
import type { ForgetfulPeople } from '@hadoku/game-server/people';
import type { Featured } from '../play/featured.js';
import type { ParkedStore } from '../play/parked.js';
import type { Placement } from '@hadoku/game-server/play/placement/index';
import type { JvmHostFactory } from '@hadoku/game-server/play/host';
import type { BridgeCommand, BridgeLine } from '../play/bridge-protocol.js';
import type { PlayHandle, jvmHostConfig, roomDeckCosts } from '../play/index.js';
import type { Recorder } from '../play/recording/recorder.js';
import type { ArtKeys } from '../pools/art-keys.js';
import type { CardCatalog } from '../pools/catalog.js';
import type { CubeStore } from '../pools/cubes.js';
import type { ForgePools } from '../pools/forge.js';
import type { PresetStore } from '../pools/presets.js';
import type { SetsStore } from '../pools/sets.js';
import type { Events } from '@hadoku/game-server/room/events';
import type { AnonymisableTournaments } from '../room/tournaments.js';
import type { attachDraftSocket } from '../room/socket.js';
import type { attachRoomFeed } from '@hadoku/game-server/room/watching';
import type { RoomStreams } from '@hadoku/game-server/stream/alloc';
import type { StreamedMatchHost } from '@hadoku/game-server/play/runtimes/streamed';
import type { KeyBook } from '../stats/keys.js';
import type { MatchStats } from '../stats/index.js';
import type { TablesHandle } from '../http/routes.js';
import type { loadTablesLibrary } from '../http/index.js';
import type { fleetCli } from '@hadoku/game-server/play/placement/index';
import type { Challenges } from '../room/challenge.js';

/** Cardtable's plugins declare no bus events of their own yet. */
export type CardtableEvents = Record<never, never>;

export interface Cardtable {
	/**
	 * The site's package root (`apps/server`, where `dist/version.txt` is) and this instance's checkout: the
	 * site's `index.ts` computes both. Magic's own tree is `root.ts`'s `MAGIC_ROOT`.
	 */
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
	/**
	 * The ONE server-wide presence tracker (`room/socket.ts`'s
	 * `createSeatPresence`) — built in `plugins/rooms.ts` before
	 * `draftRooms`, which takes this same instance. The one accessor: nothing
	 * else constructs a `PresenceTracker`. Watchparty's `serveRoom` is handed
	 * this in w98.
	 */
	seatPresence: PresenceTracker<string>;
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
	/** Every room-keyed streamed desktop `ensureRoomStreams` has started (`runtimes/streamed.ts`'s `StreamedMatchHost`), by room key. `plugins/stream.ts` only. */
	streamedHosts: Map<string, StreamedMatchHost>;
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
	clawHosts: Placement<BridgeLine, BridgeCommand> | null;
	localHost: JvmHostFactory<BridgeLine, BridgeCommand> | null;
	play: PlayHandle | null;
}

export type CardtablePlugin = GamePlugin<CardtableEvents, Cardtable>;
