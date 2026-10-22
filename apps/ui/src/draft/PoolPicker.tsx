/*
 * The draft room's pool picker — Cube (wave 73 §B), Set and Custom (wave 74
 * §F). Three tabs build the same `DraftPlan` (`packages/shared/src/pool.ts`):
 * Cube and Set each fill all three rounds with one source, Custom fills each
 * round with its own (ruling 5: "shards of alara + alara reborn in one
 * draft" — one source per pack round, cube or set, mixed freely).
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
 * The leader edits; everyone else sees the same list, read-only and live —
 * the picker draws straight off the room's own feed (`pod.plan`), so a
 * change lands on every seated screen without a reload.
 *
 * Draws the room's own `RadioCards` component for every choice — its
 * `renderRow` is what lets one row carry a size, an importer and its own
 * refresh/delete buttons beside the radio (the Cube tab, and the compact
 * cube picker a Custom round reuses verbatim: one list implementation, two
 * call sites).
 *
 * ## Set, Custom and their shared verdict
 *
 * Cube and Set both write the SAME whole-plan attempt the Cube tab always
 * has (`selected`/`checking`/`refusal`/`readyCards`), because both fill every
 * round identically — picking a set-and-style is exactly as atomic as
 * picking a cube.
 *
 * Custom is different: its three rounds are independent, and `PoolSource`
 * carries no per-round verdict of its own. Rather than guess which of three
 * rounds a combined-plan refusal names, each round shows ITS OWN chosen
 * source's cached verdict — `CubeSummary.verdict` / `SetSummary.verdict`, the
 * same cache the contract already keeps per source at this Forge pin,
 * "listing never triggers a check" — right under that round's own picker
 * (`pool-picker-custom-round-<n>-verdict`), independent of the shared
 * verdict line at the foot of the card (which still gates Ready off the real
 * `PUT …/pod/plan` round trip for the combined plan, same as every tab).
 */
import { useState, type ReactNode } from 'react';

import type { CubeSummary, DraftPreset, PoolSource, PoolVerdict, SetSummary } from '@hadoku/shared';

import { RadioCards, type RadioCard } from '../components/RadioCards.tsx';
import './PoolPicker.css';

/** A refused verdict only — the arm this picker ever shows the names of. */
export type Refusal = Extract<PoolVerdict, { ok: false }>;
export type PoolTab = 'cube' | 'set' | 'custom';
export type SourceStyle = Extract<PoolSource, { kind: 'set' }>['style'];

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

/** One cube's row: name, size, and — imported only — who imported it plus its own refresh/delete. `compact` (a Custom round) drops the importer actions. */
function CubeRow({
  cube,
  input,
  leader,
  busy,
  myId,
  compact,
  onRefresh,
  onDelete,
}: {
  cube: CubeSummary;
  input: ReactNode;
  leader: boolean;
  busy: boolean;
  myId: string;
  compact: boolean;
  onRefresh: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div key={cube.id} className="pool-picker__row">
      <label className="radio-cards__card pool-picker__card">
        {input}
        <span className="pool-picker__name">{cube.name}</span>
        <span className="pool-picker__size">{cube.size}</span>
        {!compact && cube.origin === 'cubecobra' && (
          <span className="pool-picker__meta" data-testid={`pool-picker-meta-${cube.id}`}>
            {cube.importedBy}
            {cube.refreshedAt !== null ? ` · refreshed ${cube.refreshedAt}` : ''}
          </span>
        )}
      </label>
      {!compact && cube.origin === 'cubecobra' && leader && (
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

/** The cube list, reused by the Cube tab (full rows) and a Custom round (compact rows) — one implementation, per the file header. */
function CubeList({
  name,
  testId,
  cubes,
  value,
  disabled,
  leader,
  busy,
  myId,
  compact,
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
  compact: boolean;
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
    <RadioCards
      name={name}
      label="Cube"
      testId={testId}
      className="pool-picker__list"
      options={ordered.map((c) => ({ value: c.id, label: c.name }))}
      value={value}
      disabled={disabled}
      onChange={onChange}
      renderRow={(option, input) => {
        const cube = byId.get(option.value)!;
        return <CubeRow key={cube.id} cube={cube} input={input} leader={leader} busy={busy} myId={myId} compact={compact} onRefresh={onRefresh} onDelete={onDelete} />;
      }}
    />
  );
}

/** The set list (searchable, newest first) plus the Realistic/Set-cube style toggle — reused by the Set tab and a Custom round. */
function SetList({
  namePrefix,
  testId,
  sets,
  code,
  style,
  disabled,
  onPick,
}: {
  namePrefix: string;
  testId: string;
  sets: readonly SetSummary[];
  code: string | null;
  style: SourceStyle | null;
  disabled: boolean;
  onPick: (code: string, style: SourceStyle) => void;
}) {
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const filtered = q === '' ? sets : sets.filter((s) => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q));

  return (
    <div className="pool-picker__set-list">
      <input
        type="search"
        className="pool-picker__search"
        data-testid={`${testId}-search`}
        placeholder="Search sets"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <RadioCards
        name={`${namePrefix}-set`}
        label="Set"
        testId={testId}
        className="pool-picker__list"
        options={filtered.map((s) => ({ value: s.code, label: s.name }))}
        value={code}
        disabled={disabled}
        onChange={(picked) => onPick(picked, style ?? 'realistic')}
        renderRow={(option, input) => {
          const set = filtered.find((s) => s.code === option.value)!;
          return (
            <div key={set.code} className="pool-picker__row">
              <label className="radio-cards__card pool-picker__card">
                {input}
                <span className="pool-picker__name">{set.name}</span>
                <span className="pool-picker__size">{set.date.slice(0, 4)}</span>
              </label>
            </div>
          );
        }}
      />
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

/** One Custom round: a Cube/Set type toggle, then whichever list is active, and that round's own cached verdict. */
function CustomRound({
  round,
  source,
  cubes,
  sets,
  disabled,
  onPick,
}: {
  round: 0 | 1 | 2;
  source: PoolSource | null;
  cubes: readonly CubeSummary[];
  sets: readonly SetSummary[];
  disabled: boolean;
  onPick: (round: 0 | 1 | 2, source: PoolSource) => void;
}) {
  const [type, setType] = useState<'cube' | 'set'>(source?.kind ?? 'cube');
  const testId = `pool-picker-custom-round-${round}`;

  return (
    <div className="pool-picker__round" data-testid={testId}>
      <h3 className="pool-picker__round-title">{`Round ${round + 1}`}</h3>
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
        onChange={setType}
      />
      {type === 'cube' ? (
        <CubeList
          name={`${testId}-cube`}
          testId={`${testId}-cubes`}
          cubes={cubes}
          value={source?.kind === 'cube' ? source.cubeId : null}
          disabled={disabled}
          leader={false}
          busy={disabled}
          myId=""
          compact
          onChange={(cubeId) => onPick(round, { kind: 'cube', cubeId })}
          onRefresh={() => undefined}
          onDelete={() => undefined}
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
    <div className="pool-picker__row" data-testid={`pool-picker-preset-${preset.id}`}>
      <span className="pool-picker__name">{preset.name}</span>
      <span className="pool-picker__actions">
        <button type="button" className="pool-picker__action" data-testid={`pool-picker-preset-${preset.id}-load`} disabled={busy} onClick={() => onLoad(preset)}>
          Load
        </button>
        {preset.createdBy === myId && (
          <button type="button" className="pool-picker__action" data-testid={`pool-picker-preset-${preset.id}-delete`} disabled={busy} onClick={() => onDelete(preset.id)}>
            Delete
          </button>
        )}
      </span>
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
  const verdictState = checking ? 'checking' : refusal !== null ? 'refused' : 'ready';

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
            compact={false}
            onChange={onPickCube}
            onRefresh={onRefresh}
            onDelete={onDelete}
          />
          {cubesError !== null && (
            <p className="lobby__error" role="alert" data-testid="pool-picker-list-error">
              {cubesError}
            </p>
          )}
          {leader && (
            <form
              className="lobby__form pool-picker__import"
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = link.trim();
                if (trimmed === '') return;
                onImport(trimmed);
                setLink('');
              }}
            >
              <label htmlFor="pool-picker-import-link">Cube Cobra link</label>
              <input
                id="pool-picker-import-link"
                type="text"
                data-testid="pool-picker-import-link"
                value={link}
                disabled={busy}
                onChange={(e) => setLink(e.target.value)}
              />
              <button type="submit" data-testid="pool-picker-import-go" disabled={busy || link.trim() === ''}>
                Import
              </button>
            </form>
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
          <div className="pool-picker__rounds">
            {([0, 1, 2] as const).map((round) => (
              <CustomRound key={round} round={round} source={customRounds[round]} cubes={cubes} sets={sets} disabled={disabled} onPick={onPickCustomRound} />
            ))}
          </div>
          {leader && (
            <div className="pool-picker__presets">
              <form
                className="lobby__form pool-picker__preset-save"
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
              {presets.map((preset) => (
                <PresetRow key={preset.id} preset={preset} myId={myId} busy={busy} onLoad={onLoadPreset} onDelete={onDeletePreset} />
              ))}
              {presetsError !== null && (
                <p className="lobby__error" role="alert" data-testid="pool-picker-presets-error">
                  {presetsError}
                </p>
              )}
            </div>
          )}
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
