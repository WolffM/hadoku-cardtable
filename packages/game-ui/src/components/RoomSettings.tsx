/*
 * A room's settings, behind a Room settings button: one popover, a row per setting, drawn from the
 * game's own declaration (`@hadoku/platform-wire/room-settings`). The leader edits; everybody else
 * opens the same popover and reads it, disabled. A field locked `LIVE` is disabled while a match is
 * live, and wears the lock.
 *
 *   <RoomSettingsPanel spec={BOMBERMAN_SETTINGS} value={room.settings} leader={room.you.leader}
 *     live={matchLive} onChange={(patch) => client.setSettings(room.id, patch)} />
 *
 * A game with rows the declaration cannot draw (a `custom` field, a rule that is not a setting at
 * all) builds the same popover from the pieces: `RoomSettingsPopover` around `SettingRow`s, each
 * holding a `SettingControl` (a declared field) or a `SettingToggle` of its own (Magic's
 * `MatchRules.tsx`).
 *
 * ## The rows, label | control
 *
 * Each row is TWO direct children of the grid — a plain `<span>` naming the setting, then its
 * control — never a wrapper around the pair: a wrapper would be the grid's own item, one cell wide,
 * and every row's control would sit wherever that row's OWN label ended rather than lining up under
 * the others. `.room-settings__list`'s `max-content 1fr` puts every control's left edge at one x,
 * the widest label's.
 */

import type { ReactNode } from 'react';
import { Icon } from '@wolffm/themes';
import { LIVE, type AnyRoomSettings, type SettingField } from '@hadoku/platform-wire/room-settings';
import { uiLength } from '@hadoku/ui-shell/settings';

import { ActionButton } from './ActionButton.tsx';
import { Popover, usePopover } from './Popover.tsx';
import { RadioCards } from './RadioCards.tsx';
import './Button.css';
import './RoomSettings.css';

/** The Room settings button and its popover, holding `children` as its rows. */
export function RoomSettingsPopover({
  testId = 'room-settings',
  title = 'Room settings',
  triggerClassName = 'room-settings__trigger ct-action',
  children,
}: {
  /** The button's test id; the popover's is `<testId>-popover`. */
  testId?: string;
  title?: string;
  /** The button's look, for a game whose bar draws its buttons its own way. */
  triggerClassName?: string;
  children: ReactNode;
}) {
  const { trigger, toggle, close } = usePopover();
  return (
    <>
      <button type="button" className={triggerClassName} aria-expanded={trigger !== null} data-testid={testId} onClick={(event) => toggle(event.currentTarget)}>
        <Icon name="gear" size={uiLength('0.9rem')} />
        <span className="ct-action__label">{title}</span>
      </button>
      {trigger !== null && (
        <Popover trigger={trigger} onClose={close} title={title} testId={`${testId}-popover`} wide>
          <div className="room-settings__list">{children}</div>
        </Popover>
      )}
    </>
  );
}

/** One row's two grid cells: the setting's name (with the lock while it holds), then its control. */
export function SettingRow({ label, locked = false, children }: { label: string; locked?: boolean; children: ReactNode }) {
  return (
    <>
      <span className="room-settings__label" data-locked={locked ? 'true' : undefined}>
        {label}
        {locked && <Icon name="lock" size={uiLength('0.75rem')} className="room-settings__lock" />}
      </span>
      {children}
    </>
  );
}

/**
 * An on/off switch. Its press counts in the usage as `<testId>-on` or `<testId>-off`, or as
 * `actions` names them (what turning it on, and off, is called). `className` adds to its own.
 */
export function SettingToggle({
  on,
  onPress,
  disabled,
  testId,
  className,
  actions,
}: {
  on: boolean;
  onPress: () => void;
  disabled: boolean;
  testId: string;
  className?: string;
  actions?: { on: string; off: string };
}) {
  return (
    <ActionButton
      action={on ? (actions?.off ?? `${testId}-off`) : (actions?.on ?? `${testId}-on`)}
      className={['room-settings__toggle room-settings__switch', className].filter(Boolean).join(' ')}
      aria-pressed={on}
      data-testid={testId}
      disabled={disabled}
      onPress={onPress}
    >
      {on ? 'On' : 'Off'}
    </ActionButton>
  );
}

/**
 * A declared field's control: a toggle, a row of cards for a choice, a number input for a bounded
 * number. Null for a `custom` field, which its game draws itself. `toggleClassName` adds to a
 * toggle's classes.
 */
export function SettingControl({
  field,
  name,
  value,
  disabled,
  onChange,
  testId,
  toggleClassName,
}: {
  field: SettingField;
  /** The field's key: the radio group's name. */
  name: string;
  value: unknown;
  disabled: boolean;
  onChange: (next: unknown) => void;
  testId: string;
  toggleClassName?: string;
}) {
  if (field.kind === 'toggle') {
    const on = value === true;
    return <SettingToggle on={on} onPress={() => onChange(!on)} disabled={disabled} testId={testId} {...(toggleClassName === undefined ? {} : { className: toggleClassName })} />;
  }
  if (field.kind === 'choice') {
    return (
      <RadioCards
        name={name}
        label={field.label}
        options={field.choices}
        value={typeof value === 'string' ? value : null}
        disabled={disabled}
        onChange={onChange}
        testId={testId}
        className="room-settings__switch"
      />
    );
  }
  if (field.kind === 'number') {
    return (
      <input
        type="number"
        className="room-settings__number room-settings__switch"
        aria-label={field.label}
        data-testid={testId}
        min={field.min}
        max={field.max}
        step={field.step}
        value={typeof value === 'number' ? value : field.default}
        disabled={disabled}
        onChange={(event) => {
          const next = event.currentTarget.valueAsNumber;
          if (Number.isFinite(next) && next >= field.min && next <= field.max) onChange(next);
        }}
      />
    );
  }
  return null;
}

/** A key as a test id: `pickTimer` → `pick-timer`. */
export const settingTestId = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/**
 * Every field the declaration can draw, in its order, behind the Room settings button. Null when it
 * has none to draw.
 */
export function RoomSettingsPanel({
  spec,
  value,
  leader,
  live = false,
  busy = false,
  locked,
  onChange,
  only,
  testId,
}: {
  spec: AnyRoomSettings;
  /** The room body's `settings`. */
  value: Readonly<Record<string, unknown>>;
  /** Only the leader moves a setting; everybody else reads them. */
  leader: boolean;
  /** A match is live: every `LIVE` field is locked. */
  live?: boolean;
  /** A change is on its way: nothing moves until it lands. */
  busy?: boolean;
  /** Whether a lock of the game's own (any but `LIVE`) holds now. Default: none ever does. */
  locked?: (lock: string) => boolean;
  /** The leader's change: one field at a time, as `PATCH /:id { settings }` takes it. */
  onChange: (patch: Record<string, unknown>) => void;
  /** The fields to draw, in this order; default every field the declaration can draw. */
  only?: readonly string[];
  testId?: string;
}) {
  const keys = (only ?? spec.keys).filter((key) => Object.hasOwn(spec.fields, key) && spec.fields[key]!.kind !== 'custom');
  if (keys.length === 0) return null;
  const holds = (lock: string | undefined): boolean => lock !== undefined && (lock === LIVE ? live : (locked?.(lock) ?? false));
  return (
    <RoomSettingsPopover {...(testId === undefined ? {} : { testId })}>
      {keys.map((key) => {
        const field = spec.fields[key]!;
        const isLocked = holds(field.lock);
        return (
          <SettingRow key={key} label={field.label} locked={isLocked}>
            <SettingControl field={field} name={key} value={value[key]} disabled={!leader || busy || isLocked} onChange={(next) => onChange({ [key]: next })} testId={settingTestId(key)} />
          </SettingRow>
        );
      })}
    </RoomSettingsPopover>
  );
}
