// @vitest-environment jsdom
/*
 * A board left open across a release (match m-13e598202544, 2026-11-07): a v0.56.0 page under a
 * v0.57.0 server, which had started stamping `ScryfallId` on every card face. The page's strict
 * frame schema refused each frame holding a face, resynced into a snapshot it refused the same way,
 * and after three stopped, blaming the server's cursor, while the game went on unseen.
 *
 * The board here is the real driver (`startMatch`) on a stub transport that answers the way that
 * server did, with a face carrying a property this page has never heard of.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { safeParseServerFrame } from '@hadoku/forge-wire';

import { claimReload } from '@hadoku/game-ui/stale-build.ts';
import { fixtureFrames } from './replay-server.ts';
import { closeMatch, MAX_RESYNCS_WITHOUT_PROGRESS, startMatch, type LiveMatch, type MatchTransport, type MatchTrouble } from './match.ts';
import { MATCH_EVENTS } from './transport.ts';

const MATCH_ID = 'm-stale';
const EPOCH = 'e1';
const PAGE = 'v0.56.0+91a313c62';
/** Main past the page's release: the same release, so only a frame it cannot read reloads it. */
const PPE_SERVER = 'v0.56.0+0123abcde';
const NEWER_SERVER = 'v0.57.0+915f1d2f7';
/** The event name as the wire spells it, so the stub can send it to a page that predates it. */
const BUILD_EVENT = 'forge:build';

/** A delta holding a card face the way a newer server sends it: one property more than this page knows. */
function newerFaceFrame(): unknown {
  const frame = structuredClone(fixtureFrames()[0]!) as unknown as { payload: { packet: { newObjects: Record<string, Record<string, unknown>> } } };
  const face = Object.values(frame.payload.packet.newObjects).find((o) => 'Name' in o)!;
  face.FutureProperty = { t: 'str', v: 'from a later release' };
  return frame;
}

interface Stub {
  transport: MatchTransport;
  /**
   * The socket connects: the server tells its build first, as it does on every connection (`null`: a
   * server older than that), then answers what was asked before the handshake.
   */
  connect(build: string | null): void;
  /** Deliver a `forge:s2c` frame at the next cursor. */
  frame(frame: unknown): void;
  requests: string[];
  emitted: { event: string; payload: unknown }[];
}

/** Answers every join and resync with a snapshot whose frames are `snapshotFrames()`, at the latest cursor. */
function stub(snapshotFrames: () => unknown[]): Stub {
  const handlers = new Map<string, (payload: unknown) => void>();
  let seq = 0;
  let connected = false;
  const pending: ((err: Error | null, response: unknown) => void)[] = [];
  const answer = (onAck: (err: Error | null, response: unknown) => void) =>
    onAck(null, { matchId: MATCH_ID, seat: 0, playerId: 1, cursor: seq === 0 ? null : { epoch: EPOCH, seq }, frames: snapshotFrames() });
  const s: Stub = {
    requests: [],
    emitted: [],
    transport: {
      on: (event, handler) => void handlers.set(event, handler),
      emit: (event, payload) => void s.emitted.push({ event, payload }),
      request: (event, _payload, onAck) => {
        s.requests.push(event);
        if (connected) answer(onAck);
        else pending.push(onAck);
      },
      disconnect: () => undefined,
    },
    connect: (build) => {
      connected = true;
      if (build !== null) handlers.get(BUILD_EVENT)?.({ build });
      for (const onAck of pending.splice(0)) answer(onAck);
    },
    frame: (frame) => {
      seq += 1;
      handlers.get(MATCH_EVENTS.serverToClient)!({ matchId: MATCH_ID, cursor: { epoch: EPOCH, seq }, frame });
    },
  };
  return s;
}

const open: LiveMatch[] = [];

/** One page load: a board with this page's build, reporting into `reports`, counting its reloads. */
function page(s: Stub, options: { reloadable?: boolean } = {}) {
  const reports: { what: MatchTrouble; detail: Record<string, unknown> }[] = [];
  const reloads: string[] = [];
  let target = '';
  const match = startMatch({
    matchId: MATCH_ID,
    tabId: 'tab-stale-0001',
    transport: s.transport,
    report: (what, detail) => reports.push({ what, detail }),
    ...(options.reloadable === false
      ? {}
      : {
          staleBuild: {
            page: PAGE,
            claim: (t: string) => ((target = t), claimReload(t)),
            reload: () => void reloads.push(target),
          },
        }),
  });
  open.push(match);
  return { match, reports, reloads };
}

afterEach(() => {
  for (const m of open.splice(0)) closeMatch(m);
  sessionStorage.clear();
});

describe('a page older than the server it talks to', () => {
  it('the face a newer server sends is one this page refuses: the premise of every case below', () => {
    const parsed = safeParseServerFrame(newerFaceFrame());
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed.ok ? null : parsed.errors)).toContain('FutureProperty');
  });

  it('reloads once on connect when the server runs a newer release, and says so with both builds', () => {
    const s = stub(() => []);
    const { match, reports, reloads } = page(s);
    s.connect(NEWER_SERVER);
    expect(match.serverBuild).toBe(NEWER_SERVER);
    expect(reloads).toEqual([NEWER_SERVER]);
    expect(reports.map((r) => r.what)).toEqual(['stale-build-reload']);
    expect(reports[0]!.detail).toMatchObject({ page: PAGE, server: NEWER_SERVER, cause: 'newer-release' });
  });

  it('a frame it cannot read reloads the page once, without resyncing into the same refusal or refusing the ask', () => {
    const s = stub(() => []);
    const { match, reports, reloads } = page(s);
    s.connect(PPE_SERVER);
    expect(reloads).toEqual([]);
    const requestsBefore = s.requests.length;

    s.frame(newerFaceFrame());

    expect(reloads).toEqual([PPE_SERVER]);
    expect(match.reloading).toBe(true);
    expect(s.requests.length).toBe(requestsBefore);
    expect(s.emitted.filter((e) => e.event === MATCH_EVENTS.clientToServer)).toEqual([]);
    expect(reports.map((r) => r.what)).toEqual(['stale-build-reload']);
    expect(reports[0]!.detail).toMatchObject({ page: PAGE, server: PPE_SERVER, cause: 'unreadable' });
    expect(JSON.stringify(reports[0]!.detail.lastInvalid)).toContain('FutureProperty');

    // Whatever else arrives before the page goes is not read.
    const applied = match.stats.applied;
    s.frame(fixtureFrames()[1]);
    expect(match.stats.applied).toBe(applied);
  });

  it('after its reload for that build, a page that still cannot read the server stops with the parse errors, not a cursor story, and never reloads again', () => {
    // The first load reloads for the build.
    const first = stub(() => []);
    const before = page(first);
    first.connect(PPE_SERVER);
    first.frame(newerFaceFrame());
    expect(before.reloads).toEqual([PPE_SERVER]);

    // The reloaded page: the same tab's session storage, and the server answering every resync with the face it cannot read.
    const s = stub(() => [newerFaceFrame()]);
    const { match, reports, reloads } = page(s);
    s.connect(PPE_SERVER);
    for (let i = 0; i <= MAX_RESYNCS_WITHOUT_PROGRESS + 1; i++) s.frame(newerFaceFrame());

    expect(reloads).toEqual([]);
    expect(match.reloading).toBe(false);
    expect(match.lastError).toContain('could not read');
    expect(match.lastError).not.toContain('cursor');
    const failed = reports.filter((r) => r.what === 'snapshot-failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(JSON.stringify(failed[0]!.detail.lastInvalid)).toContain('FutureProperty');
  });

  it('an unreadable frame from a server running this very build is a bug, not a stale page: no reload', () => {
    const s = stub(() => []);
    const { reloads } = page(s);
    s.connect(PAGE);
    s.frame(newerFaceFrame());
    expect(reloads).toEqual([]);
    expect(s.requests).toContain(MATCH_EVENTS.resync);
  });

  it('a server that never says its build is one this page may predate: an unreadable frame reloads', () => {
    const s = stub(() => []);
    const { reloads } = page(s);
    s.connect(null);
    s.frame(newerFaceFrame());
    expect(reloads).toEqual(['unknown']);
  });

  it('a board that cannot reload (the embed) resyncs as it always has', () => {
    const s = stub(() => []);
    const { match, reports } = page(s, { reloadable: false });
    s.connect(NEWER_SERVER);
    s.frame(newerFaceFrame());
    expect(match.reloading).toBe(false);
    expect(s.requests).toContain(MATCH_EVENTS.resync);
    expect(reports.map((r) => r.what)).not.toContain('stale-build-reload');
  });
});
