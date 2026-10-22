/*
 * The draft room's lobby — who is here, who is ready, and the Ready toggle
 * that becomes the pod once everyone has pressed it.
 *
 * Moved out of `ConstructedScreen.tsx` by wave 72 §Q, unchanged (a pure move,
 * per the wave file's "Ordering, not sharing"): `ConstructedScreen` still
 * renders this for a draft room whose `draftStartedAt` is null, and nothing
 * about what it draws or how it behaves changed in the move. From here on
 * lane R owns this file, and wave 72 §R.1 is where the 8 pod seats arrive.
 *
 * ## Seats are additive, not a new gate (wave 72 §R.1)
 *
 * `apps/server/src/room/lobby.ts`'s `startDraft`: "the pod's ready gate
 * counts SEATED members only… nobody having sat yet… falls back to 'every
 * member' — the exact gate this had before the pod lobby existed, byte for
 * byte." So `ready-toggle` keeps its exact current meaning (the CALLER's own
 * `ready` flag, global, unaffected by seating) and this draws it exactly as
 * before for whoever holds no seat. Seats only matter once at least one is
 * taken — the 3+-human pod this wave exists for — and that is `PodSeats`'
 * own job, not a second readiness mechanism. This is what keeps a 2-person
 * room's existing "join, ready, draft" path (`e2e/draft.spec.ts`) working
 * with nobody ever touching a seat.
 *
 * ## The pod comes with the room
 *
 * `pod` is the room read's own `RoomView.pod` (`ConstructedScreen`'s `view`),
 * so the seats are drawn in the same frame as the room's name and members. A
 * second read of its own landed a beat later and pushed the seats in above
 * the member list (the operator, 2026-10-19: *"elements quickly shift around
 * as things are loaded"*). Which seat is mine comes from `myId`, the server's
 * own `you.id` for this room — never whoami's id, which for an admin session
 * is not the member id the pod's seats name.
 *
 * ## The pool picker (wave 73 §B, Set+Custom+presets wave 74 §F)
 *
 * The leader picks the pod's source here, in one of three tabs: Cube (wave
 * 73), Set (a whole set, realistic or set-cube) and Custom (one source per
 * round — ruling 5: "shards of alara + alara reborn in one draft"). `PoolPicker`
 * is purely presentational; every write — a pick, an import, a refresh, a
 * delete, a preset save/load/delete — is made right here, the same way the
 * seat actions above already are (`pod/client.ts`'s functions, called
 * directly rather than threaded through `ConstructedScreen` as a prop) —
 * `ConstructedScreen.tsx` is untouched this wave.
 *
 * A pick is NOT the same round trip as a seat action: the server runs the
 * verdict first (`PUT /api/rooms/:id/pod/plan`), and a refusal leaves the
 * room's plan exactly as it was. So the refused attempt is never visible on
 * `pod.plan` — it is held here, locally, only until the next attempt (or a
 * reload) — which is what `attempt` (Cube/Set) and `customAttempt` (Custom)
 * below are for.
 *
 * **The active tab is live too** (Acceptance 1: Bob, who never touches a
 * tab, sees Alice land on Set the instant she picks one). `planTabOf` derives
 * it from the room's own plan — equal rounds of one kind name that tab,
 * unequal rounds name Custom — for EVERYONE; the leader may additionally
 * override it locally (`tabOverride`) so clicking "Set" shows that tab's own
 * controls before any pick has written anything, the same ephemeral pattern
 * `attempt` already uses for a refused pick. A non-leader gets no override:
 * their tab is always the room's own.
 *
 * **Custom's three rounds are independent, and a `PoolSource` carries no
 * verdict of its own.** Rather than guess which round a combined-plan
 * refusal names, `PoolPicker` shows each round's OWN chosen source's cached
 * verdict (`CubeSummary.verdict`/`SetSummary.verdict` — already cached per
 * source at this Forge pin, "listing never triggers a check") right under
 * that round's picker; the shared verdict line at the foot of the card still
 * gates Ready off the real `PUT …/pod/plan` round trip for the combined plan,
 * same as every tab.
 *
 * ## Pre-deal art, from the plan's own cube (wave 73 §B follow-up)
 *
 * `GET /api/pools/cubes/:id/cards` (lane C's follow-up, landed `de2f79e3`)
 * lists a cube's whole `DraftCard[]`, so the lobby can warm its art before
 * anything is dealt — `cubeIdsOf` names every distinct cube-kind source the
 * plan's rounds hold (one today; a future Custom round could differ), and
 * `preloadCubeArt` (`art-preload.ts`) is called once per id, each time the
 * set changes. `PodScreen.tsx` does the same, for a reload mid-draft that
 * never passes back through here.
 */

import { useEffect, useRef, useState } from 'react';

import type { CubeSummary, DraftPlan, DraftPreset, PoolSource, SetSummary } from '@hadoku/shared';

import { ActionButton } from '../components/ActionButton.tsx';
import { poolsClient, roomsClient, type PoolsClient, type RoomsClient, type RoomMember } from '../rooms/api.ts';
import { latestReads } from '../rooms/latest.ts';
import { PoolPicker, type PoolTab, type Refusal, type SourceStyle } from '../draft/PoolPicker.tsx';
import { preloadCubeArt } from '../play/live/art-preload.ts';
import { aiPod, closePod, sitPod, standPod } from './pod/client.ts';
import { PodSeats } from './pod/PodSeats.tsx';
import { PodSpectators } from './pod/PodSpectators.tsx';
import { podDealable, type PodView } from './pod/wire.ts';

export { podDealable };

/**
 * Every distinct cube `plan`'s rounds hold, in round order — not just round
 * 1 — so a future Custom round with a different cube per round warms every
 * one of them rather than only the first. Exported for `PodScreen.tsx`'s own
 * reload-mid-draft case. `undefined` reads as no plan at all: nothing to warm.
 */
export function cubeIdsOf(plan: DraftPlan | undefined): string[] {
  if (plan === undefined) return [];
  return [...new Set(plan.rounds.flatMap((r) => (r.kind === 'cube' ? [r.cubeId] : [])))];
}

/** Same source, same card — the only identity a `PoolSource` has. */
function sourcesEqual(a: PoolSource, b: PoolSource | null): boolean {
  if (b === null || a.kind !== b.kind) return false;
  if (a.kind === 'cube') return b.kind === 'cube' && a.cubeId === b.cubeId;
  return b.kind === 'set' && a.code === b.code && a.style === b.style;
}

/**
 * Which tab the room's own plan names: equal rounds of one kind name that
 * tab, unequal rounds name Custom. `undefined` (no plan at all) defaults to
 * Cube — the tab a fresh draft room always opens on.
 */
function planTabOf(plan: DraftPlan | undefined): PoolTab {
  if (plan === undefined) return 'cube';
  const [r1, r2, r3] = plan.rounds;
  if (!sourcesEqual(r1, r2) || !sourcesEqual(r1, r3)) return 'custom';
  return r1.kind;
}

const defaultPools = poolsClient();
const defaultRooms = roomsClient();

export function DraftLobby({
  roomId,
  pod,
  members,
  leaderId,
  myId,
  iAmReady,
  allReady,
  dealing,
  error,
  onReady,
  onRetry,
  pools = defaultPools,
  rooms = defaultRooms,
}: {
  roomId: string;
  /** The room read's `RoomView.pod`; null for a body that carried none. */
  pod: PodView | null;
  members: RoomMember[];
  leaderId: string;
  /** My member id here (`RoomView.you.id`); `''` while unknown. */
  myId: string;
  iAmReady: boolean;
  allReady: boolean;
  dealing: boolean;
  error: string | null;
  onReady: (ready: boolean) => void;
  onRetry: () => void;
  /** Tests inject a stub. Production leaves it undefined. */
  pools?: PoolsClient;
  rooms?: Pick<RoomsClient, 'setPlan'>;
}) {
  const myMemberId = myId === '' ? null : myId;
  const amLeader = myId !== '' && myId === leaderId;

  const [seatError, setSeatError] = useState<string | null>(null);
  /**
   * One seat change at a time, held here and not drawn: disabling every seat's
   * buttons for the round trip made the whole list blink on each press (the
   * operator, 2026-10-19: *"whenever i click sit here or ai, i notice all the
   * buttons flash"*). A press while one is in flight goes out once it has answered.
   */
  const inFlight = useRef(false);
  const later = useRef<(() => Promise<{ ok: boolean; message: string | null }>)[]>([]);

  const act = (call: () => Promise<{ ok: boolean; message: string | null }>): void => {
    if (inFlight.current) {
      later.current.push(call);
      return;
    }
    inFlight.current = true;
    setSeatError(null);
    call()
      .then((r) => {
        if (!r.ok) setSeatError(r.message);
      })
      .finally(() => {
        inFlight.current = false;
        const next = later.current.shift();
        if (next !== undefined) act(next);
      });
  };
  const doSit = (seat: number): void => act(() => sitPod(roomId, seat));
  const doAi = (seat: number, on: boolean): void => act(() => aiPod(roomId, seat, on));
  const doClose = (seat: number, closed: boolean): void => act(() => closePod(roomId, seat, closed));
  const doStand = (): void => act(() => standPod(roomId));

  /* ── the pool picker: the room's cube/set lists, and the plan write ──── */
  const verdict = pod?.verdict ?? null;

  // The plan's own cube(s), warmed before the deal — joined so the effect's dependency is one stable string, not a new array each render.
  const planCubeIdsKey = cubeIdsOf(pod?.plan).join(',');
  useEffect(() => {
    if (planCubeIdsKey === '') return;
    let cancelled = false;
    for (const id of planCubeIdsKey.split(',')) {
      pools.cubeCards(id).then((cards) => {
        if (!cancelled && cards !== null) preloadCubeArt(cards);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [planCubeIdsKey]);

  const [cubes, setCubes] = useState<CubeSummary[]>([]);
  const [cubesError, setCubesError] = useState<string | null>(null);
  /** The cube and preset lists' reads, latest-wins (`../rooms/latest.ts`): every write is followed by a fresh read, so a read is kept or dropped. */
  const [cubeReads] = useState(latestReads);
  const loadCubes = (): void => {
    const landed = cubeReads.read();
    pools.listCubes().then(
      (list) => {
        if (landed() !== 'keep') return;
        setCubes(list);
        setCubesError(null);
      },
      (e: unknown) => {
        if (landed() === 'keep') setCubesError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  useEffect(() => void loadCubes(), []);

  const [sets, setSets] = useState<SetSummary[]>([]);
  const [setsError, setSetsError] = useState<string | null>(null);
  useEffect(() => {
    pools
      .listSets()
      .then((list) => {
        setSets(list);
        setSetsError(null);
      })
      .catch((e: unknown) => setSetsError(e instanceof Error ? e.message : String(e)));
  }, []);

  const [presets, setPresets] = useState<DraftPreset[]>([]);
  const [presetsError, setPresetsError] = useState<string | null>(null);
  const [presetReads] = useState(latestReads);
  const loadPresets = (): void => {
    const landed = presetReads.read();
    pools.listPresets().then(
      (list) => {
        if (landed() !== 'keep') return;
        setPresets(list);
        setPresetsError(null);
      },
      (e: unknown) => {
        if (landed() === 'keep') setPresetsError(e instanceof Error ? e.message : String(e));
      },
    );
  };
  useEffect(() => void loadPresets(), []);

  /** The leader's own tab override — see the file header. `null` for a non-leader, always. */
  const [tabOverride, setTabOverride] = useState<PoolTab | null>(null);
  const planTab = planTabOf(pod?.plan);
  const tab: PoolTab = amLeader ? tabOverride ?? planTab : planTab;

  const [planBusy, setPlanBusy] = useState(false);
  /**
   * The last Cube/Set attempt's own refusal, and which source it tried. A
   * refusal never changes `pod.plan` (the contract: "Refused… the plan is
   * unchanged"), so this is the one place that attempt is remembered —
   * local to this browser, and cleared by the next attempt.
   */
  const [attempt, setAttempt] = useState<{ source: PoolSource; refusal: Refusal } | null>(null);
  /**
   * Custom's three rounds, LOCAL overrides only — a round this browser has
   * actually picked in Custom mode this session, `null` for one it has not
   * touched. Found live (AF305, the tracker's screenshot review): a slot
   * that is merely untouched is not the same as a slot with no source — the
   * room's own current plan already names one, and the pack slots must show
   * it (`customRounds` below), not sit blank until somebody edits them.
   */
  const [customDraft, setCustomDraft] = useState<[PoolSource | null, PoolSource | null, PoolSource | null]>([null, null, null]);
  /** The last FULL custom plan's own refusal — each round's own attempted source is already held in `customDraft`, refusal or not. */
  const [customAttempt, setCustomAttempt] = useState<Refusal | null>(null);

  /** `customDraft`, falling back round by round to the room's own current plan — what the pack slots and the active picker actually show. */
  const planRounds = pod?.plan?.rounds ?? null;
  const customRounds: [PoolSource | null, PoolSource | null, PoolSource | null] = [
    customDraft[0] ?? planRounds?.[0] ?? null,
    customDraft[1] ?? planRounds?.[1] ?? null,
    customDraft[2] ?? planRounds?.[2] ?? null,
  ];

  const writeSource = (source: PoolSource): void => {
    setPlanBusy(true);
    setAttempt(null);
    const plan: DraftPlan = { rounds: [source, source, source] };
    rooms.setPlan(roomId, plan).then((r) => {
      setPlanBusy(false);
      if (!r.ok) setAttempt({ source, refusal: r.verdict !== null && !r.verdict.ok ? r.verdict : { ok: false, unplayable: [], missingText: [r.message] } });
    });
  };

  const selectedSource: PoolSource | null = attempt?.source ?? (pod?.plan ? pod.plan.rounds[0] : null);

  const pickCube = (cubeId: string): void => {
    const source: PoolSource = { kind: 'cube', cubeId };
    if (sourcesEqual(source, selectedSource) && attempt === null) return;
    writeSource(source);
  };

  const pickSet = (code: string, style: SourceStyle): void => {
    const source: PoolSource = { kind: 'set', code, style };
    if (sourcesEqual(source, selectedSource) && attempt === null) return;
    writeSource(source);
  };

  const pickCustomRound = (round: 0 | 1 | 2, source: PoolSource): void => {
    const next = [...customDraft] as [PoolSource | null, PoolSource | null, PoolSource | null];
    next[round] = source;
    setCustomDraft(next);
    setCustomAttempt(null);
    // Merge with the room's own plan for whichever rounds this browser has not
    // touched — the slots show the current plan already (see `customRounds`
    // above), so one round's own edit should write immediately, carrying the
    // other two rounds' CURRENT sources forward rather than waiting for all
    // three to be picked fresh.
    const merged: [PoolSource | null, PoolSource | null, PoolSource | null] = [
      next[0] ?? planRounds?.[0] ?? null,
      next[1] ?? planRounds?.[1] ?? null,
      next[2] ?? planRounds?.[2] ?? null,
    ];
    if (merged[0] === null || merged[1] === null || merged[2] === null) return;
    const plan: DraftPlan = { rounds: [merged[0], merged[1], merged[2]] };
    setPlanBusy(true);
    rooms.setPlan(roomId, plan).then((r) => {
      setPlanBusy(false);
      if (!r.ok) setCustomAttempt(r.verdict !== null && !r.verdict.ok ? r.verdict : { ok: false, unplayable: [], missingText: [r.message] });
    });
  };

  const savePreset = (name: string): void => {
    const [r0, r1, r2] = customRounds;
    if (r0 === null || r1 === null || r2 === null) return;
    const plan: DraftPlan = { rounds: [r0, r1, r2] };
    setPlanBusy(true);
    pools.savePreset(name, plan).then((r) => {
      setPlanBusy(false);
      if (r.ok) loadPresets();
      else setPresetsError(r.message);
    });
  };

  const loadPreset = (preset: DraftPreset): void => {
    setCustomDraft([...preset.plan.rounds]);
    setCustomAttempt(null);
    setPlanBusy(true);
    rooms.setPlan(roomId, preset.plan).then((r) => {
      setPlanBusy(false);
      if (!r.ok) setCustomAttempt(r.verdict !== null && !r.verdict.ok ? r.verdict : { ok: false, unplayable: [], missingText: [r.message] });
    });
  };

  const deletePreset = (id: string): void => {
    setPlanBusy(true);
    pools.deletePreset(id).then((r) => {
      setPlanBusy(false);
      if (r.ok) loadPresets();
      else setPresetsError(r.message);
    });
  };

  // Import stays in the room (it is how a cube gets into a draft); refresh and delete moved to
  // `#/inventory` (AF305 §B — the operator: "when i'm in a room i wouldn't want to mess with the
  // refresh state of the cube"), so this is the only cube write left here.
  const importCube = (link: string): void => {
    setPlanBusy(true);
    pools.importCube(link).then((r) => {
      setPlanBusy(false);
      if (r.ok) loadCubes();
      else setCubesError(r.message);
    });
  };

  /** Whether a LOCAL attempt (Cube/Set, or a full Custom round set) is still unresolved or refused, for whichever tab is active. */
  const pendingLocalAttempt = tab === 'custom' ? customAttempt !== null : attempt !== null;
  const checking = pod !== null && !pendingLocalAttempt && verdict === null;
  const planOk = verdict !== null && verdict.ok;
  const readyCards = verdict !== null && verdict.ok ? verdict.cards : null;
  /**
   * What the picker shows refused: a local attempt's own refusal, else the
   * CURRENT plan's own background verdict when THAT is refused (no jar yet,
   * or a Forge pin change that re-failed a once-good cube) — never defaulted
   * to "ready" just because nobody locally attempted anything. Found live
   * (wave 73 §B): without this, `readyCards === null` (verdict refused) but
   * `refusal` (the old, attempt-only field) stayed `null` too, so the
   * verdict line showed `data-state="ready"` with no text while Ready stayed
   * correctly disabled — a driver waiting on "ready" by state got stuck
   * forever (draft.spec.ts's jar-less tests, 2026-10-22).
   */
  const backgroundRefusal = verdict !== null && !verdict.ok ? verdict : null;
  const refusal = (tab === 'custom' ? customAttempt : attempt?.refusal) ?? backgroundRefusal;

  /**
   * The draft-state line and the Ready button: always drawn (`pod` may
   * still be null for the one frame before the room's own read lands), and
   * one shared element — never two copies — so it sits inside the pod strip
   * once seats exist, and stands alone before they do.
   */
  const side = (
    <div className="pod-strip__side">
      {dealing && (
        <p className="lobby__note" data-testid="draft-state">
          Dealing the draft…
        </p>
      )}
      <ActionButton
        action={iAmReady ? 'unready' : 'ready'}
        className="lobby__go"
        data-testid="ready-toggle"
        aria-pressed={iAmReady}
        disabled={dealing || members.length === 0 || (pod !== null && (planBusy || pendingLocalAttempt || !planOk))}
        onPress={() => onReady(!iAmReady)}
      >
        {iAmReady ? 'Stand down' : 'Ready'}
      </ActionButton>
    </div>
  );

  return (
    <section className="lobby__card" data-testid="draft-lobby">
      {pod !== null ? (
        <>
          <div className="pod-strip">
            <PodSeats
              seats={pod.seats}
              myMemberId={myMemberId}
              leaderId={leaderId}
              readyOf={(id) => members.find((m) => m.id === id)?.ready === true}
              avatarIdOf={(id) => members.find((m) => m.id === id)?.avatarId}
              onSit={doSit}
              onStand={doStand}
              onAi={doAi}
              onClose={doClose}
            />
            {side}
          </div>
          {seatError !== null && (
            <p className="ct-error" role="alert" data-testid="pod-seat-error">
              {seatError}
            </p>
          )}
          <PodSpectators pod={pod} members={members} myId={myMemberId} leaderId={leaderId} />

          <h2>Pool</h2>
          <PoolPicker
            tab={tab}
            onTabChange={setTabOverride}
            cubes={cubes}
            cubesError={cubesError}
            sets={sets}
            setsError={setsError}
            presets={presets}
            presetsError={presetsError}
            selected={selectedSource}
            customRounds={customRounds}
            leader={amLeader}
            busy={planBusy}
            checking={checking}
            refusal={refusal}
            readyCards={readyCards}
            myId={myMemberId ?? ''}
            onPickCube={pickCube}
            onPickSet={pickSet}
            onPickCustomRound={pickCustomRound}
            onImport={importCube}
            onSavePreset={savePreset}
            onLoadPreset={loadPreset}
            onDeletePreset={deletePreset}
          />
        </>
      ) : (
        side
      )}

      {error !== null && (
        <div className="ct-error" role="alert" data-testid="draft-error">
          <p>{error}</p>
          {/* Only while everyone still is ready: a refusal because somebody
              stood down in the meantime fixes itself when they ready again, and
              the deal is asked for on its own then. */}
          {allReady && (
            <button type="button" data-testid="draft-retry" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}

    </section>
  );
}

