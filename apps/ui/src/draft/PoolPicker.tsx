/*
 * The draft room's pool picker — Cube (wave 73 §B), Set and Custom (wave 74
 * §F), redesigned as a card gallery (AF305 §B, "Cube Gallery" — the operator:
 * "ok new UI looking better i like B - Cube Gallery the best").
 *
 * All three tabs build the same `DraftPlan` (`packages/shared/src/pool.ts`):
 * Cube and Set each fill all three rounds with one source, Custom fills each
 * round with its own (ruling 5: "shards of alara + alara reborn in one
 * draft" — one source per pack round, cube or set, mixed freely).
 *
 * ## The gallery (Cube/Set tabs)
 *
 * Every cube or set is a card in a responsive grid (`.pool-picker__gallery`,
 * `repeat(auto-fill, minmax(…, 1fr))`); the chosen one wears a primary
 * border, a tinted fill and a check badge (`data-verdict` flips that to the
 * danger token while the chosen source is refused — the operator's "the
 * cube cobra import field is looking pretty ugly" plus "oh boy does the
 * draft room look ugly" is what AF305 answers). The Cube Cobra import box is
 * the grid's own LAST card, dashed — no longer a loose field under the list.
 *
 * `RadioCards` draws every card (its `renderRow` is what lets a card carry a
 * size, an importer badge and its own refresh/delete beside the radio); the
 * grid is CSS only — `.pool-picker__gallery > .radio-cards { display:
 * contents }` lets `RadioCards`' own cards and the import card share one grid
 * as siblings, with no change to that component.
 *
 * The tab itself is LIVE too (Acceptance 1: Bob, who never touches a tab,
 * sees Alice land on Set the moment she picks one) — `tab` is a prop, not
 * state here. `DraftLobby.tsx` derives it from the room's own plan for
 * everyone, and additionally lets the LEADER override it locally (so
 * clicking "Set" shows the Set tab's own controls before any pick has
 * written anything yet — the same ephemeral, local-only pattern `attempt`
 * already uses for a refused cube pick).
 *
 * Imported cubes are pinned above the shortlist, newest first — the same
 * order `GET /api/pools/cubes` already answers in, kept rather than re-sorted.
 * Any friend may import or refresh; only the importer deletes (ruling 4).
 *
 * The leader edits; everyone else sees the same gallery, read-only and live —
 * the picker draws straight off the room's own feed (`pod.plan`), so a
 * change lands on every seated screen without a reload.
 *
 * ## Custom: three pack slots, ONE shared picker (AF305 §B)
 *
 * Earlier this drew three independent `CustomRound`s, each mounting its own
 * full picker at once — three Cube/Set toggles and three galleries stacked,
 * which is what made Custom "where it gets complicated" (the operator). Now
 * the three rounds are PACK SLOTS (`pool-picker-custom-round-<n>`, a
 * `RadioCards` group of its own: picking a slot only changes which one is
 * being edited, locally, for every viewer — never gated on leadership, since
 * reading what a round holds is not an edit) and exactly one gallery is
 * mounted at a time, for whichever slot is active. A round's own
 * Cube/Set-type choice (`customType`) is remembered per slot so switching
 * slots and back does not lose it.
 *
 * This is why a test id addressed AT a round — `pool-picker-custom-round-
 * <n>-sets-<code>` — only resolves once that round's slot is the active one:
 * the contract (AF305's brief) is that the id still names the same job, not
 * that every round's picker is mounted simultaneously.
 *
 * `PoolSource` carries no per-round verdict of its own, so each slot (and the
 * active picker below it) shows that round's OWN chosen source's cached
 * verdict (`CubeSummary.verdict` / `SetSummary.verdict`, the same cache the
 * contract already keeps per source at this Forge pin, "listing never
 * triggers a check") — independent of the shared verdict line at the foot of
 * the card, which still gates Ready off the real `PUT …/pod/plan` round trip
 * for the combined plan, same as every tab.
 */
import { useState, type ReactNode } from 'react';

import type { CubeSummary, DraftPreset, PoolSource, PoolVerdict, SetSummary } from '@hadoku/shared';

import { RadioCards, type RadioCard } from '../components/RadioCards.tsx';
import './PoolPicker.css';

/** A refused verdict only — the arm this picker ever shows the names of. */
export type Refusal = Extract<PoolVerdict, { ok: false }>;
export type PoolTab = 'cube' | 'set' | 'custom';
export type SourceStyle = Extract<PoolSource, { kind: 'set' }>['style'];
/** The shared verdict line's own three states — also used to flip the chosen gallery card's border/fill. */
type VerdictState = 'checking' | 'ready' | 'refused';

const STYLE_OPTIONS: readonly RadioCard<SourceStyle>[] = [
  { value: 'realistic', label: 'Realistic' },
  { value: 'set-cube', label: 'Set-cube' },
];

const TABS: readonly { id: PoolTab; label: string }[] = [
  { id: 'cube', label: 'Cube' },
  { id: 'set', label: 'Set' },
  { id: 'custom', label: 'Custom' },
];

export interface PoolPickerProps {
  tab: PoolTab;
  /** Only the leader may switch tabs; a non-leader's is driven entirely by the room's own plan. */
  onTabChange: (tab: PoolTab) => void;

  cubes: readonly CubeSummary[];
  /** Could not load the cube list at all — a reachability problem, not a cube's own refusal. */
  cubesError: string | null;
  sets: readonly SetSummary[];
  setsError: string | null;
  presets: readonly DraftPreset[];
  presetsError: string | null;

  /**
   * The Cube/Set tab's one source: the last attempted pick while it is still
   * refused (ephemeral, local — the server never stores a refused plan),
   * else the room's own current plan's round 1 (both tabs fill every round
   * identically, so round 1 names the whole plan).
   */
  selected: PoolSource | null;
  /** Custom's three rounds, independently — `null` for a round nothing has chosen yet. */
  customRounds: readonly [PoolSource | null, PoolSource | null, PoolSource | null];

  /** Only the leader edits; everyone else reads the same picker, disabled. */
  leader: boolean;
  /** A write (a pick, an import, a refresh, a delete, a preset save/delete) is in flight. */
  busy: boolean;
  /** The selected plan's verdict has not come back yet. */
  checking: boolean;
  /** The last attempted plan's own refusal, or null. */
  refusal: Refusal | null;
  /** The accepted plan's card count, once a verdict says ok. */
  readyCards: number | null;
  /** My own friend id — whose imports/presets get a Delete button. */
  myId: string;

  onPickCube: (cubeId: string) => void;
  onPickSet: (code: string, style: SourceStyle) => void;
  onPickCustomRound: (round: 0 | 1 | 2, source: PoolSource) => void;
  onImport: (link: string) => void;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
  onSavePreset: (name: string) => void;
  onLoadPreset: (preset: DraftPreset) => void;
  onDeletePreset: (id: string) => void;
}

/** A source's own cached verdict, read off whichever list carries it — never a round trip (see the file header). */
function sourceVerdict(source: PoolSource | null, cubes: readonly CubeSummary[], sets: readonly SetSummary[]): PoolVerdict | null {
  if (source === null) return null;
  if (source.kind === 'cube') return cubes.find((c) => c.id === source.cubeId)?.verdict ?? null;
  return sets.find((s) => s.code === source.code)?.verdict ?? null;
}

/** A pack slot's one-line summary: what it holds, and what kind — `null` for a round nothing has chosen yet. */
function sourceSummary(source: PoolSource | null, cubes: readonly CubeSummary[], sets: readonly SetSummary[]): { name: string; kind: string } | null {
  if (source === null) return null;
  if (source.kind === 'cube') {
    const cube = cubes.find((c) => c.id === source.cubeId);
    return { name: cube?.name ?? source.cubeId, kind: 'Cube' };
  }
  const set = sets.find((s) => s.code === source.code);
  return { name: set?.name ?? source.code, kind: `Set · ${source.style === 'realistic' ? 'Realistic' : 'Set-cube'}` };
}

/** One cube's gallery card: name, size and — imported only — who imported it plus its own refresh/delete. */
function CubeRow({
  cube,
  input,
  checked,
  verdictState,
  leader,
  busy,
  myId,
  onRefresh,
  onDelete,
}: {
  cube: CubeSummary;
  input: ReactNode;
  checked: boolean;
  verdictState: VerdictState | undefined;
  leader: boolean;
  busy: boolean;
  myId: string;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div key={cube.id} className="pool-picker__row">
      <label className="radio-cards__card pool-picker__card" data-verdict={checked ? verdictState : undefined}>
        {input}
        <span className="pool-picker__name">{cube.name}</span>
        <span className="pool-picker__meta-row">
          <span className="pool-picker__size">{cube.size} cards</span>
          {cube.origin === 'cubecobra' && (
            <span className="pool-picker__badge" data-testid={`pool-picker-meta-${cube.id}`}>
              Cube Cobra · {cube.importedBy}
              {cube.refreshedAt !== null ? ` · refreshed ${cube.refreshedAt}` : ''}
            </span>
          )}
        </span>
      </label>
      {cube.origin === 'cubecobra' && leader && (
        <span className="pool-picker__actions">
          <button type="button" className="pool-picker__action" data-testid={`pool-picker-refresh-${cube.id}`} disabled={busy} onClick={() => onRefresh(cube.id)}>
            Refresh
          </button>
          {cube.importedBy === myId && (
            <button type="button" className="pool-picker__action" data-testid={`pool-picker-delete-${cube.id}`} disabled={busy} onClick={() => onDelete(cube.id)}>
              Delete
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/** The Cube Cobra import box — the gallery's own last, dashed card (the ugly loose field this redesign replaces). */
function ImportCard({ link, setLink, busy, onImport }: { link: string; setLink: (v: string) => void; busy: boolean; onImport: (link: string) => void }) {
  return (
    <form
      className="pool-picker__import-card"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = link.trim();
        if (trimmed === '') return;
        onImport(trimmed);
        setLink('');
      }}
    >
      <label htmlFor="pool-picker-import-link">Cube Cobra</label>
      <div className="pool-picker__import-row">
        <input
          id="pool-picker-import-link"
          type="text"
          placeholder="cubecobra.com/cube/…"
          data-testid="pool-picker-import-link"
          value={link}
          disabled={busy}
          onChange={(e) => setLink(e.target.value)}
        />
        <button type="submit" data-testid="pool-picker-import-go" disabled={busy || link.trim() === ''}>
          Import
        </button>
      </div>
    </form>
  );
}

/** The cube gallery, reused by the Cube tab and by Custom's active picker — one implementation, per the file header. */
function CubeList({
  name,
  testId,
  cubes,
  value,
  disabled,
  leader,
  busy,
  myId,
  verdictState,
  after,
  onChange,
  onRefresh,
  onDelete,
}: {
  name: string;
  testId: string;
  cubes: readonly CubeSummary[];
  value: string | null;
  disabled: boolean;
  leader: boolean;
  busy: boolean;
  myId: string;
  /** Flips the CHOSEN card's border/fill to the danger token while refused. Only the Cube tab passes this (its one source gates the shared verdict); a Custom round shows its own cached verdict underneath instead. */
  verdictState?: VerdictState;
  /** An extra, non-radio tile at the gallery's end (the Cube tab's import card). */
  after?: ReactNode;
  onChange: (cubeId: string) => void;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  // Imported first (the server's own order), then the shortlist — never re-sorted here.
  const imported = cubes.filter((c) => c.origin === 'cubecobra');
  const shortlist = cubes.filter((c) => c.origin === 'shortlist');
  const ordered = [...imported, ...shortlist];
  const byId = new Map(ordered.map((c) => [c.id, c]));

  return (
    <div className="pool-picker__gallery">
      <RadioCards
        name={name}
        label="Cube"
        testId={testId}
        options={ordered.map((c) => ({ value: c.id, label: c.name }))}
        value={value}
        disabled={disabled}
        onChange={onChange}
        renderRow={(option, input) => {
          const cube = byId.get(option.value)!;
          return (
            <CubeRow
              key={cube.id}
              cube={cube}
              input={input}
              checked={option.value === value}
              verdictState={verdictState}
              leader={leader}
              busy={busy}
              myId={myId}
              onRefresh={onRefresh}
              onDelete={onDelete}
            />
          );
        }}
      />
      {after}
    </div>
  );
}

/** The set gallery (searchable, newest first) plus the Realistic/Set-cube style toggle — reused by the Set tab and Custom's active picker. */
function SetList({
  namePrefix,
  testId,
  sets,
  code,
  style,
  disabled,
  verdictState,
  onPick,
}: {
  namePrefix: string;
  testId: string;
  sets: readonly SetSummary[];
  code: string | null;
  style: SourceStyle | null;
  disabled: boolean;
  verdictState?: VerdictState;
  onPick: (code: string, style: SourceStyle) => void;
}) {
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const filtered = q === '' ? sets : sets.filter((s) => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q));

  return (
    <div className="pool-picker__set-list">
      <label className="pool-picker__search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          type="search"
          data-testid={`${testId}-search`}
          placeholder="Search sets"
          aria-label="Search sets"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      <div className="pool-picker__gallery">
        <RadioCards
          name={`${namePrefix}-set`}
          label="Set"
          testId={testId}
          options={filtered.map((s) => ({ value: s.code, label: s.name }))}
          value={code}
          disabled={disabled}
          onChange={(picked) => onPick(picked, style ?? 'realistic')}
          renderRow={(option, input) => {
            const set = filtered.find((s) => s.code === option.value)!;
            return (
              <label key={set.code} className="radio-cards__card pool-picker__card" data-verdict={option.value === code ? verdictState : undefined}>
                {input}
                <span className="pool-picker__set-code">{set.code}</span>
                <span className="pool-picker__name">{set.name}</span>
                <span className="pool-picker__size">{set.date.slice(0, 4)} · {set.cards} cards</span>
              </label>
            );
          }}
        />
      </div>
      <RadioCards
        name={`${namePrefix}-style`}
        label="Style"
        testId={`${testId.replace('-sets', '')}-style`}
        options={STYLE_OPTIONS}
        value={style}
        disabled={disabled || code === null}
        onChange={(picked) => {
          if (code !== null) onPick(code, picked);
        }}
      />
    </div>
  );
}

/** A source's own cached verdict, drawn the same way the shared verdict line is — used only by a Custom round (see the file header). */
function RoundVerdict({ round, source, cubes, sets }: { round: number; source: PoolSource | null; cubes: readonly CubeSummary[]; sets: readonly SetSummary[] }) {
  const verdict = sourceVerdict(source, cubes, sets);
  if (verdict === null) return null;
  const state = verdict.ok ? 'ready' : 'refused';
  return (
    <p className="pool-picker__verdict pool-picker__round-verdict" data-testid={`pool-picker-custom-round-${round}-verdict`} data-state={state}>
      {verdict.ok ? `${verdict.cards} cards` : [...verdict.unplayable, ...verdict.missingText].join(', ')}
    </p>
  );
}

/** Custom's active pack: a Cube/Set type switch, then whichever gallery is active, and that round's own cached verdict. */
function CustomActivePicker({
  round,
  source,
  type,
  cubes,
  sets,
  disabled,
  leader,
  busy,
  myId,
  onTypeChange,
  onPick,
  onRefresh,
  onDelete,
}: {
  round: 0 | 1 | 2;
  source: PoolSource | null;
  type: 'cube' | 'set';
  cubes: readonly CubeSummary[];
  sets: readonly SetSummary[];
  disabled: boolean;
  leader: boolean;
  busy: boolean;
  myId: string;
  onTypeChange: (round: 0 | 1 | 2, type: 'cube' | 'set') => void;
  onPick: (round: 0 | 1 | 2, source: PoolSource) => void;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const testId = `pool-picker-custom-round-${round}`;

  return (
    <div className="pool-picker__active-pack">
      <RadioCards
        name={`${testId}-type`}
        label="Source type"
        testId={`${testId}-type`}
        options={[
          { value: 'cube', label: 'Cube' },
          { value: 'set', label: 'Set' },
        ]}
        value={type}
        disabled={disabled}
        onChange={(v) => onTypeChange(round, v)}
      />
      {type === 'cube' ? (
        <CubeList
          name={`${testId}-cube`}
          testId={`${testId}-cubes`}
          cubes={cubes}
          value={source?.kind === 'cube' ? source.cubeId : null}
          disabled={disabled}
          leader={leader}
          busy={busy}
          myId={myId}
          onChange={(cubeId) => onPick(round, { kind: 'cube', cubeId })}
          onRefresh={onRefresh}
          onDelete={onDelete}
        />
      ) : (
        <SetList
          namePrefix={testId}
          testId={`${testId}-sets`}
          sets={sets}
          code={source?.kind === 'set' ? source.code : null}
          style={source?.kind === 'set' ? source.style : null}
          disabled={disabled}
          onPick={(code, style) => onPick(round, { kind: 'set', code, style })}
        />
      )}
      <RoundVerdict round={round} source={source} cubes={cubes} sets={sets} />
    </div>
  );
}

function PresetRow({ preset, myId, busy, onLoad, onDelete }: { preset: DraftPreset; myId: string; busy: boolean; onLoad: (preset: DraftPreset) => void; onDelete: (id: string) => void }) {
  return (
    <div className="pool-picker__preset" data-testid={`pool-picker-preset-${preset.id}`}>
      <button type="button" className="pool-picker__preset-load" data-testid={`pool-picker-preset-${preset.id}-load`} disabled={busy} onClick={() => onLoad(preset)}>
        {preset.name}
      </button>
      {preset.createdBy === myId && (
        <button
          type="button"
          className="pool-picker__preset-delete"
          data-testid={`pool-picker-preset-${preset.id}-delete`}
          aria-label={`Delete preset ${preset.name}`}
          disabled={busy}
          onClick={() => onDelete(preset.id)}
        >
          ×
        </button>
      )}
    </div>
  );
}

export function PoolPicker({
  tab,
  onTabChange,
  cubes,
  cubesError,
  sets,
  setsError,
  presets,
  presetsError,
  selected,
  customRounds,
  leader,
  busy,
  checking,
  refusal,
  readyCards,
  myId,
  onPickCube,
  onPickSet,
  onPickCustomRound,
  onImport,
  onRefresh,
  onDelete,
  onSavePreset,
  onLoadPreset,
  onDeletePreset,
}: PoolPickerProps) {
  const [link, setLink] = useState('');
  const [presetName, setPresetName] = useState('');
  const disabled = !leader || busy;
  const verdictState: VerdictState = checking ? 'checking' : refusal !== null ? 'refused' : 'ready';

  /** Which pack slot is being edited — a local, view-only choice; never gated on leadership (see the file header). */
  const [activeRound, setActiveRound] = useState<0 | 1 | 2>(0);
  /** Each round's own Cube/Set toggle, remembered per slot so switching away and back keeps it. Seeded once from whatever the room's plan already holds. */
  const [customType, setCustomType] = useState<['cube' | 'set', 'cube' | 'set', 'cube' | 'set']>(() => [
    customRounds[0]?.kind ?? 'cube',
    customRounds[1]?.kind ?? 'cube',
    customRounds[2]?.kind ?? 'cube',
  ]);
  const setRoundType = (round: 0 | 1 | 2, type: 'cube' | 'set'): void => {
    setCustomType((prev) => {
      const next = [...prev] as typeof prev;
      next[round] = type;
      return next;
    });
  };
  const typeOf = (round: 0 | 1 | 2): 'cube' | 'set' => customRounds[round]?.kind ?? customType[round];

  return (
    <div className="pool-picker" data-testid="pool-picker">
      <div className="lobby__format-tabs pool-picker__tabs" role="tablist" data-testid="pool-picker-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="ct-toggle"
            role="tab"
            aria-selected={tab === t.id}
            data-testid={`pool-picker-tab-${t.id}`}
            disabled={!leader}
            onClick={() => onTabChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'cube' && (
        <>
          <CubeList
            name="pool-picker-cube"
            testId="pool-picker-cubes"
            cubes={cubes}
            value={selected?.kind === 'cube' ? selected.cubeId : null}
            disabled={disabled}
            leader={leader}
            busy={busy}
            myId={myId}
            verdictState={verdictState}
            after={leader ? <ImportCard link={link} setLink={setLink} busy={busy} onImport={onImport} /> : undefined}
            onChange={onPickCube}
            onRefresh={onRefresh}
            onDelete={onDelete}
          />
          {cubesError !== null && (
            <p className="lobby__error" role="alert" data-testid="pool-picker-list-error">
              {cubesError}
            </p>
          )}
        </>
      )}

      {tab === 'set' && (
        <>
          <SetList
            namePrefix="pool-picker-set"
            testId="pool-picker-sets"
            sets={sets}
            code={selected?.kind === 'set' ? selected.code : null}
            style={selected?.kind === 'set' ? selected.style : null}
            disabled={disabled}
            verdictState={verdictState}
            onPick={onPickSet}
          />
          {setsError !== null && (
            <p className="lobby__error" role="alert" data-testid="pool-picker-set-list-error">
              {setsError}
            </p>
          )}
        </>
      )}

      {tab === 'custom' && (
        <>
          <RadioCards
            name="pool-picker-custom-slot"
            label="Pack being edited"
            testId="pool-picker-custom-round"
            className="pool-picker__packs"
            options={(['0', '1', '2'] as const).map((v) => ({ value: v, label: `Pack ${Number(v) + 1}` }))}
            value={String(activeRound) as '0' | '1' | '2'}
            disabled={false}
            onChange={(v) => setActiveRound(Number(v) as 0 | 1 | 2)}
            renderRow={(option, input) => {
              const round = Number(option.value) as 0 | 1 | 2;
              const source = customRounds[round];
              const summary = sourceSummary(source, cubes, sets);
              const verdict = sourceVerdict(source, cubes, sets);
              return (
                <label key={option.value} className="radio-cards__card pool-picker__pack" data-verdict={verdict === null ? undefined : verdict.ok ? 'ready' : 'refused'}>
                  {input}
                  <span className="pool-picker__pack-n">{`Pack ${round + 1}`}</span>
                  {summary !== null && (
                    <>
                      <span className="pool-picker__pack-name">{summary.name}</span>
                      <span className="pool-picker__pack-kind">{summary.kind}</span>
                    </>
                  )}
                </label>
              );
            }}
          />

          {leader && (
            <div className="pool-picker__presets">
              {presets.map((preset) => (
                <PresetRow key={preset.id} preset={preset} myId={myId} busy={busy} onLoad={onLoadPreset} onDelete={onDeletePreset} />
              ))}
              <form
                className="pool-picker__preset-save"
                onSubmit={(e) => {
                  e.preventDefault();
                  const trimmed = presetName.trim();
                  if (trimmed === '') return;
                  onSavePreset(trimmed);
                  setPresetName('');
                }}
              >
                <label htmlFor="pool-picker-preset-name">Save as preset</label>
                <input
                  id="pool-picker-preset-name"
                  type="text"
                  data-testid="pool-picker-preset-name"
                  value={presetName}
                  disabled={busy}
                  onChange={(e) => setPresetName(e.target.value)}
                />
                <button type="submit" data-testid="pool-picker-preset-save" disabled={busy || presetName.trim() === ''}>
                  Save
                </button>
              </form>
              {presetsError !== null && (
                <p className="lobby__error" role="alert" data-testid="pool-picker-presets-error">
                  {presetsError}
                </p>
              )}
            </div>
          )}

          <CustomActivePicker
            round={activeRound}
            source={customRounds[activeRound]}
            type={typeOf(activeRound)}
            cubes={cubes}
            sets={sets}
            disabled={disabled}
            leader={leader}
            busy={busy}
            myId={myId}
            onTypeChange={setRoundType}
            onPick={onPickCustomRound}
            onRefresh={onRefresh}
            onDelete={onDelete}
          />
        </>
      )}

      <p className="pool-picker__verdict" data-testid="pool-picker-verdict" data-state={verdictState}>
        {verdictState === 'checking' && 'Checking…'}
        {verdictState === 'ready' && readyCards !== null && `${readyCards} cards`}
        {verdictState === 'refused' && refusal !== null && [...refusal.unplayable, ...refusal.missingText].join(', ')}
      </p>
    </div>
  );
}
