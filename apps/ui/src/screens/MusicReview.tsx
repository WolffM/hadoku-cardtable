/*
 * `#/sounds/music` — the match-music review.
 *
 * The operator, 2026-10-17: *"post it as a new route under /sounds/ i want to be able to go there, test,
 * then send the results for review later. make sure /sounds/ is friendtier+ gated"*. One section per
 * match-music slot (`musicReviewSlots`, the grouping the server validates against), each with its
 * candidates: the take the cell plays today (badged) and the generated ones. A card plays its take on a
 * loop through the mixer's music bus, one at a time; its two lane buttons put it in the slot's normal or
 * 16-bit lane (one take per lane, any take in either); three small verdicts rate it; a note goes with the
 * slot. Submit appends the whole review server-side.
 *
 * Friend tier and above, the same server-answered gate as the builder (`canView`). Re-opening restores
 * this browser's unsent draft, or else the viewer's latest submission; the submit button shows saved
 * while what is on screen is what was sent.
 *
 * Reset (pressed twice) starts a fresh round: it drops the draft and remembers, in this browser, the `at`
 * of the submission on screen (`FRESH_KEY`), so a re-open no longer restores that one or anything older.
 * The server's file is untouched; the next submission is simply a later line.
 *
 * Built from the queue's own card (`.sound-queue__card`, `.sound-queue__choice`, `.sound-queue__pick`)
 * and the builder's header and buttons, so it reads as one of the sound screens.
 */

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@wolffm/themes';

import {
  MUSIC_LANES,
  MUSIC_RATINGS,
  isChiptuneName,
  musicReviewSlots,
  type MusicLane,
  type MusicRating,
  type MusicReviewEntry,
  type MusicReviewRecord,
  type MusicReviewSlot,
} from '@hadoku/shared';

import { ManaCost } from '../components/ManaPip.tsx';
import { musicReviewClient, soundsClient, type MusicReviewClient, type SoundsClient } from '../sound/builderClient.ts';
import { createMixer, type Mixer } from '../sound/mixer.ts';
import { getLevel, subscribeSound } from '../sound/mute.ts';
import './SoundBuilder.css';

export interface MusicReviewProps {
  /** Tests pass stubs. Production builds the real fetch-backed clients and mixer. */
  client?: SoundsClient;
  reviews?: MusicReviewClient;
  player?: Pick<Mixer, 'loopFile' | 'setLevels'>;
}

/** This browser's unsent review. Per browser on purpose: a draft, not a record. */
export const DRAFT_KEY = 'cardtable.sound.music-review.draft';

/** The `at` of the last submission a reset set aside: one at or before it is not restored. */
export const FRESH_KEY = 'cardtable.sound.music-review.fresh-since';

/** How long a first press of reset waits for the second. */
export const RESET_ARM_MS = 4000;

type Review = Record<string, MusicReviewEntry>;

const NO_PICKS: MusicReviewEntry['picks'] = { normal: null, chiptune: null };
const EMPTY: MusicReviewEntry = { picks: NO_PICKS, ratings: {}, note: '' };

const LANE_ICON: Record<MusicLane, 'music' | 'gamepad'> = { normal: 'music', chiptune: 'gamepad' };
const LANE_LABEL: Record<MusicLane, string> = { normal: 'Normal', chiptune: '16-bit' };

const RATING_ICON: Record<MusicRating, 'thumbs-up' | 'circle' | 'thumbs-down'> = {
  keep: 'thumbs-up',
  maybe: 'circle',
  no: 'thumbs-down',
};
const RATING_LABEL: Record<MusicRating, string> = { keep: 'Keep', maybe: 'Maybe', no: 'No' };

/** Only the slots that say something, each with only what it says — what is sent and what is compared. */
export function normalizeReview(review: Review): Review {
  const out: Review = {};
  for (const [cell, e] of Object.entries(review)) {
    const note = e.note.trim();
    if (e.picks.normal === null && e.picks.chiptune === null && Object.keys(e.ratings).length === 0 && note === '') continue;
    out[cell] = { picks: { normal: e.picks.normal, chiptune: e.picks.chiptune }, ratings: e.ratings, note };
  }
  return out;
}

function sameReview(a: Review, b: Review): boolean {
  const x = normalizeReview(a);
  const y = normalizeReview(b);
  const keys = Object.keys(x);
  if (keys.length !== Object.keys(y).length) return false;
  return keys.every((k) => {
    const p = x[k]!;
    const q = y[k];
    if (q === undefined || p.note !== q.note || MUSIC_LANES.some((l) => p.picks[l] !== q.picks[l])) return false;
    const r = Object.keys(p.ratings);
    return r.length === Object.keys(q.ratings).length && r.every((f) => p.ratings[f] === q.ratings[f]);
  });
}

function loadDraft(): Review | null {
  try {
    const raw = globalThis.localStorage?.getItem(DRAFT_KEY);
    if (raw == null) return null;
    const v: unknown = JSON.parse(raw);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Review) : null;
  } catch {
    // Unreadable or blocked: no draft, and the latest submission stands.
    return null;
  }
}

function loadFreshSince(): string | null {
  try {
    return globalThis.localStorage?.getItem(FRESH_KEY) ?? null;
  } catch {
    // Blocked: no reset remembered, and the latest submission is restored as before.
    return null;
  }
}

function saveFreshSince(at: string): void {
  try {
    globalThis.localStorage?.setItem(FRESH_KEY, at);
  } catch {
    // A blocked store costs the reset surviving a reload, nothing on this page.
  }
}

/** The submission to restore: none when a reset set it (or a later one's predecessor) aside. */
function sinceReset(mine: MusicReviewRecord | null): MusicReviewRecord | null {
  const since = loadFreshSince();
  return mine !== null && since !== null && mine.at <= since ? null : mine;
}

function saveDraft(review: Review | null): void {
  try {
    if (review === null) globalThis.localStorage?.removeItem(DRAFT_KEY);
    else globalThis.localStorage?.setItem(DRAFT_KEY, JSON.stringify(review));
  } catch {
    // A blocked store costs the draft surviving a reload, nothing on this page.
  }
}

/** A restored review, kept to what the slots offer now: a take since retired drops out of it. */
function fitToSlots(review: Review, slots: readonly MusicReviewSlot[]): Review {
  const out: Review = {};
  for (const slot of slots) {
    const e = review[slot.cell];
    if (e === undefined) continue;
    const offered = new Set(slot.candidates.map((c) => c.file));
    const ratings: Record<string, MusicRating> = {};
    for (const [f, r] of Object.entries(e.ratings ?? {})) if (offered.has(f) && MUSIC_RATINGS.includes(r)) ratings[f] = r;
    // A draft saved before the two lanes carries one `pick`: it is the normal lane's.
    const legacy = (e as { pick?: unknown }).pick;
    const picks: Partial<Record<MusicLane, unknown>> = e.picks ?? { normal: legacy };
    const lane = (l: MusicLane): string | null => {
      const f = picks[l];
      return typeof f === 'string' && offered.has(f) ? f : null;
    };
    out[slot.cell] = {
      picks: { normal: lane('normal'), chiptune: lane('chiptune') },
      ratings,
      note: typeof e.note === 'string' ? e.note : '',
    };
  }
  return out;
}

type SendState = 'idle' | 'sending' | 'failed';

export function MusicReview({ client: givenClient, reviews: givenReviews, player: givenPlayer }: MusicReviewProps) {
  const client = useMemo(() => givenClient ?? soundsClient(), [givenClient]);
  const reviews = useMemo(() => givenReviews ?? musicReviewClient(), [givenReviews]);
  const player = useMemo(() => givenPlayer ?? createMixer((f) => client.takeUrl(f)), [givenPlayer, client]);

  const [loaded, setLoaded] = useState(false);
  const [canView, setCanView] = useState(false);
  const [slots, setSlots] = useState<MusicReviewSlot[]>([]);
  const [review, setReview] = useState<Review>({});
  const [submitted, setSubmitted] = useState<MusicReviewRecord | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [send, setSend] = useState<SendState>('idle');
  const [resetArmed, setResetArmed] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([client.catalogue(), client.assignments(), reviews.mine()]).then(([takes, a, mine]) => {
      if (!alive) return;
      const s = musicReviewSlots(takes, a.cells);
      setSlots(s);
      const restored = sinceReset(mine);
      setSubmitted(restored);
      setReview(fitToSlots(loadDraft() ?? restored?.slots ?? {}, s));
      setCanView(a.canView);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [client, reviews]);

  // The player's own levels, as a match hears its music; and silence when the page goes.
  useEffect(() => {
    const apply = (): void => player.setLevels({ volume: getLevel('volume'), music: getLevel('music') });
    apply();
    const off = subscribeSound(apply);
    return () => {
      off();
      player.loopFile(null);
    };
  }, [player]);

  // An armed reset waits a few seconds for its second press, then stands down.
  useEffect(() => {
    if (!resetArmed) return;
    const t = setTimeout(() => setResetArmed(false), RESET_ARM_MS);
    return () => clearTimeout(t);
  }, [resetArmed]);

  const saved = submitted !== null && sameReview(review, submitted.slots);

  function edit(cell: string, change: (e: MusicReviewEntry) => MusicReviewEntry): void {
    setSend('idle');
    setResetArmed(false);
    setReview((r) => {
      const next = { ...r, [cell]: change(r[cell] ?? EMPTY) };
      saveDraft(next);
      return next;
    });
  }

  function toggle(file: string): void {
    const next = playing === file ? null : file;
    setPlaying(next);
    player.loopFile(next);
  }

  function reset(): void {
    if (!resetArmed) {
      setResetArmed(true);
      return;
    }
    setResetArmed(false);
    if (submitted !== null) saveFreshSince(submitted.at);
    saveDraft(null);
    setSubmitted(null);
    setReview({});
    setSend('idle');
  }

  async function submit(): Promise<void> {
    setResetArmed(false);
    setSend('sending');
    const record = await reviews.submit({ slots: normalizeReview(review) });
    if (record === null) {
      setSend('failed');
      return;
    }
    setSubmitted(record);
    saveDraft(null);
    setSend('idle');
  }

  if (!loaded || !canView) return null;

  const sendState = send === 'idle' ? (saved ? 'saved' : 'unsent') : send;
  const nothing = submitted === null && Object.keys(normalizeReview(review)).length === 0;

  return (
    <div className="sound-builder music-review" data-testid="music-review">
      <header className="sound-builder__top">
        <h1>Match Music</h1>
        <nav className="sound-builder__tabs" aria-label="Sound screens">
          <a className="sound-builder__btn" href="#/sounds">
            Builder
          </a>
          <a className="sound-builder__btn" href="#/sounds/sandbox">
            Sandbox
          </a>
          <button
            type="button"
            className="sound-builder__btn music-review__reset"
            data-testid="music-review-reset"
            data-armed={resetArmed ? '' : undefined}
            disabled={nothing}
            onClick={reset}
          >
            <Icon name={resetArmed ? 'warning' : 'refresh'} />
            Reset
          </button>
          <button
            type="button"
            className="sound-builder__btn sound-builder__btn--primary music-review__submit"
            data-testid="music-review-submit"
            data-state={sendState}
            disabled={nothing || sendState === 'saved' || sendState === 'sending'}
            onClick={() => void submit()}
          >
            <Icon name={sendState === 'saved' ? 'tick' : sendState === 'failed' ? 'warning' : 'send'} />
            Submit
          </button>
        </nav>
      </header>

      <main className="sound-builder__main">
        {slots.map((slot) => {
          const entry = review[slot.cell] ?? EMPTY;
          const pips = slot.code.split('');
          return (
            <section key={slot.cell} className="music-review__slot" data-testid="music-review-slot" data-cell={slot.cell}>
              <h2 className="music-review__code">
                <ManaCost cost={pips} label={slot.code} />
                <span>{slot.code}</span>
              </h2>
              <ol className="sound-queue__choices">
                {slot.candidates.map((c) => {
                  const on = playing === c.file;
                  const rating = entry.ratings[c.file];
                  const lanes = MUSIC_LANES.filter((l) => entry.picks[l] === c.file);
                  return (
                    <li
                      key={c.file}
                      className="sound-queue__card music-review__card"
                      data-file={c.file}
                      data-picked={lanes.length > 0 ? lanes.join(' ') : undefined}
                      data-current={c.current ? '' : undefined}
                    >
                      <button
                        type="button"
                        className="sound-queue__choice"
                        data-testid="music-review-play"
                        data-heard={on ? '' : undefined}
                        aria-pressed={on}
                        aria-label={`${on ? 'Stop' : 'Play'} ${c.label}`}
                        onClick={() => toggle(c.file)}
                      >
                        <span className="sound-queue__key" aria-hidden="true">
                          <Icon name={on ? 'stop' : 'play'} size="0.9rem" />
                        </span>
                        <span className="sound-queue__label">
                          {c.current && <Icon name="globe" size="0.9rem" title="Current" className="music-review__current" />}
                          {isChiptuneName(c.label) && (
                            <span className="music-review__chip" data-testid="music-review-chiptune">
                              <Icon name={LANE_ICON.chiptune} size="0.8rem" title="16-bit" />
                            </span>
                          )}
                          <span className="music-review__name">{c.label}</span>
                        </span>
                      </button>
                      <div className="music-review__lanes" role="group" aria-label={`Lanes for ${c.label}`}>
                        {MUSIC_LANES.map((l) => (
                          <button
                            key={l}
                            type="button"
                            className="music-review__lane"
                            data-testid="music-review-pick"
                            data-lane={l}
                            aria-label={`${LANE_LABEL[l]} pick ${c.label}`}
                            title={LANE_LABEL[l]}
                            aria-pressed={entry.picks[l] === c.file}
                            onClick={() =>
                              edit(slot.cell, (e) => ({ ...e, picks: { ...e.picks, [l]: e.picks[l] === c.file ? null : c.file } }))
                            }
                          >
                            <Icon name={LANE_ICON[l]} size="0.9rem" />
                          </button>
                        ))}
                      </div>
                      <div className="music-review__ratings" role="group" aria-label={`Rate ${c.label}`}>
                        {MUSIC_RATINGS.map((r) => (
                          <button
                            key={r}
                            type="button"
                            className="music-review__rate"
                            data-rating={r}
                            aria-label={RATING_LABEL[r]}
                            title={RATING_LABEL[r]}
                            aria-pressed={rating === r}
                            onClick={() =>
                              edit(slot.cell, (e) => {
                                const ratings = { ...e.ratings };
                                if (ratings[c.file] === r) delete ratings[c.file];
                                else ratings[c.file] = r;
                                return { ...e, ratings };
                              })
                            }
                          >
                            <Icon name={RATING_ICON[r]} size="0.9rem" />
                          </button>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ol>
              <textarea
                className="music-review__note"
                aria-label={`${slot.code} note`}
                rows={1}
                maxLength={1000}
                value={entry.note}
                onChange={(ev) => {
                  const note = ev.target.value;
                  edit(slot.cell, (e) => ({ ...e, note }));
                }}
              />
            </section>
          );
        })}
      </main>
    </div>
  );
}
