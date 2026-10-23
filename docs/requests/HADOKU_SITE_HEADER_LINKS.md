# Request to hadoku_site (+ hadoku-task): a header links slot, first used for Discord

**From:** hadoku-cardtable, 2026-10-23
**Owner of the change:** `@wolffm/task-ui-components` (`hadoku-task/task-ui-components`)
and `@wolffm/themes` (`hadoku-task/themes`), with the fleet contract, templates,
audit and checklist in hadoku_site.

## What the operator asked for

> *"we need to expose a discord icon at the top of the page, let's put it
> between the theme and settings icons (let's make sure that hadoku_site knows
> about this and adjusts the child app templates accordingly so that our top
> bar is modular enough to allow putting stuff up there."* (2026-10-23)

cardtable is getting a Discord server for patch notes and tournament events. Its
invite belongs in the top bar, **between the theme picker and the settings
gear**. bomberman is expected to follow (`docs/planning/games-platform-vision.md`
has the two games running in parallel with shared stats), so this is a fleet
slot, not a cardtable special case.

## Why cardtable can't do it alone

`AppHeader` (`task-ui-components/src/components/AppHeader.tsx`) renders exactly
this:

```
[ title ] ——— [ status? · HadokuThemePicker · ConnectedSettings ]
```

The picker and gear are deliberately not props. Its docblock explains why: an
open `ReactNode` slot let apps drift. The only app slot on the bar is `status`,
and it renders *left* of the picker. So the operator's placement is impossible
today, and putting the icon in `status` would put it in the wrong place and
break the "status is a status" convention that `check-header-fleet` reads.

## Ask 1: `links` on `AppHeader` (hadoku-task)

A **typed** slot, not a node slot, so the "every app looks the same" property
the header exists for still holds:

```ts
export interface AppHeaderLink {
  /** Stable key + test hook: rendered as data-header-link={id}. */
  id: string
  /** Accessible name and tooltip ("Discord"). */
  label: string
  /** Absolute https URL. Opens in a new tab with rel="noopener noreferrer". */
  href: string
  /** A registry icon name from @wolffm/themes, not a node. */
  icon: IconName
}

interface AppHeaderProps {
  // ...existing
  /** Rendered between the theme picker and the settings gear, in order. */
  links?: readonly AppHeaderLink[]
}
```

Rendered as `<a>` elements that share the picker and gear's button chrome
(size, hit area, focus ring, hover token), so an app cannot restyle one. Order
on the bar becomes:

```
[ title ] ——— [ status? · ThemePicker · ...links · Settings ]
```

No links means no change in markup, so every existing app is unaffected.

## Ask 2: a Discord glyph in `@wolffm/themes`

`themes/src/icons/sources.json` is a Lucide-only allowlist, and Lucide ships no
brand marks. Adding `discord` therefore needs a second artwork source in
`generate-icons.mjs`. The suggestion is **simple-icons** (CC0-1.0), restricted
to brand marks under a separate `brands` block, so the "names describe the
pictograph" rule for the Lucide set stays intact. Discord's brand guidelines
allow the unmodified mark as a link to a server. Single colour via
`currentColor`, same as every other registry icon, not Blurple.

(cardtable licensing note: `AGENTS.md` forbids WotC marks, not third-party
service marks. A Discord link icon raises no issue on our side.)

## Ask 3: templates, audit, checklist (hadoku_site)

1. **Templates**: `templates/game/apps/ui/src/App.tsx`,
   `templates/ui-app/src/App.tsx` and `templates/tunnel-contained/.../App.tsx`
   pass `links` through. Preferably they don't hard-code it: they read it from
   the app's catalogue entry (`packages/catalogue`, e.g. a `headerLinks` field
   validated as `AppHeaderLink[]`). That way an invite URL is a **one-line data
   edit**, the same way cardtable treats card art (a lookup, not a URL), and a
   rotated invite never needs an app release.
2. **`check-header-fleet`**: a rule that a header control right of the title
   comes only through `links`. A `status` node containing an `<a>` with an icon
   is the drift this slot exists to prevent.
3. **`docs/child-apps/NEW_CHILD_APP_CHECKLIST.md`**: document the slot next to
   the existing header section (around line 282).

## What cardtable does once it lands

Bump `@wolffm/task-ui-components` and `@wolffm/themes`, then pass
`links={[{ id: 'discord', label: 'Discord', href: <invite>, icon: 'discord' }]}`
in `apps/ui/src/App.tsx` (or nothing, if the catalogue route in Ask 3.1 lands).
The invite URL comes from the server setup tracked in
`docs/planning/discord-integration.md`.

## Done when

- `AppHeader` with `links` renders them between picker and gear, with the
  picker's chrome, in a published `@wolffm/task-ui-components`.
- `@wolffm/themes` exports an `IconName` of `discord`.
- The game and ui-app templates carry the slot, and `check:header-fleet`
  knows about it.
- Reply in `hadoku-cardtable/docs/requests/` (or here) with the versions.
