# Request to hadoku-watchparty: a settings popout, and a way for a game bundle to fill it

**From:** hadoku-cardtable, 2026-10-30
**Owner of the change:** hadoku-watchparty (`apps/ui`, and `packages/rooms-protocol` for the
contract).
**Status:** request / not yet agreed.
**Companion:** `SETTINGS_SITE_PREFS.md` (hadoku_site's half).

## Why

The operator, 2026-10-30, after two players could not find cardtable's settings mid-match:
settings move into the fleet's one popout, `ConnectedSettings`. The person's settings (name, tier,
key, and soon the character) go on top, and the game's go under "App preferences". Standalone,
cardtable mounts that popout itself through `AppHeader`. Inside a watchparty room it can't:

> *"when watchparty loads a cardtable room i need a way to pipe through submodule settings as
> well."*

Today watchparty renders neither `AppHeader` nor `ConnectedSettings`. Its only fleet control is
`HadokuThemePicker`, in the chat panel (`apps/ui/src/components/ChatPanel.tsx:14`). So inside a
room there is no popout for the game's settings to go into.

## What the values need: nothing

Every cardtable setting is already in the fleet's prefs service, per user or per device, and not
in anything tied to the page that drew it:

| row | fields | scope |
| --- | --- | --- |
| `games` | `muted`, `volume` | device |
| `cardtable-sound` | `music` / `musicPicks` | device / user |
| `cardtable-play` | board layout, end-step stop, Fast Mode, "Say my mistakes", UI scale | user |

A change saved in watchparty's popout reaches a running match through the prefs client's own
subscription, including the cross-tab broadcast. So the ask is only about **drawing** the
controls.

## Ask 1: mount `ConnectedSettings` in watchparty's chrome

The fleet's gear popout, where a watchparty page's header controls are (beside the theme
picker). This also gives watchparty the character row once `SETTINGS_SITE_PREFS.md` §1 ships, and
that can replace the chat column's character button.

## Ask 2: `mountSettings` on the game-bundle contract

Watchparty and the game are separate bundles, so a React node shouldn't cross between them. The
contract already crosses by DOM element (`mount(el, ctx)`), and settings can cross the same way:

```ts
// packages/rooms-protocol/src/game-bundle.ts
export interface MountedGameBundle {
  unmount(): void;
  update(ctx: GameBundleContext): void;
  /**
   * Draw the game's own preferences into `el`, an element inside the host's settings popout.
   * Called when the popout opens; the returned function is called when it closes. Optional:
   * a game without preferences omits it, and the host draws no section.
   */
  mountSettings?(el: HTMLElement): () => void;
}
```

Host side, about ten lines. Pass a component as `ConnectedSettings`' `children` that renders a
`<div>`, calls `handle.mountSettings?.(div)` in an effect, and returns its cleanup.
`isMountedGameBundle` should keep accepting a bundle without it.

**CSS scope:** `apps/ui/src/tooling/scopeCss.ts` scopes a bundle's stylesheet to its mount
element. The settings element sits outside that scope, so either give it the same scope class or
tell us which class to put on it. Without one of those, the panel renders unstyled.

**Theme:** the element is inside your theme root, so `--color-*` tokens resolve as they do for
the game.

## Ask 3 (follows `SETTINGS_SITE_PREFS.md` §1): character collisions

Watchparty greys out characters other members of the room already hold
(`CharacterModal.tsx:43-60`, `/api/rooms/:key/sprites`). Once the character is the person's,
two people can arrive in one room wearing the same one. That needs a rule, such as the later
arrival getting a stand-in for that room only, with the saved pick left alone. The rule is yours
to choose.

## What cardtable does on its side

- **Standalone:** cardtable's panel goes into `AppHeader`'s `children`. Its own gear and the
  click-your-avatar way in are deleted.
- **Embedded:** `apps/ui/src/embed/index.tsx` implements `mountSettings` with the same component,
  as soon as the contract has it. Until watchparty draws a popout, the embed keeps its own gear
  in the room's head row, so settings stay reachable.
