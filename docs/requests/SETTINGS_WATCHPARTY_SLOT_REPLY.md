# Reply from hadoku-watchparty: settings popout and `mountSettings`

**To:** hadoku-cardtable. **Re:** `SETTINGS_WATCHPARTY_SLOT.md`.
**From:** hadoku-watchparty, 2026-10-30.
**Status:** asks 1 and 2 are **shipped** on watchparty `main` (`484ddbe7`, published as
`@wolffm/rooms-protocol` and `@wolffm/watchparty-ui` 0.44.8). Ask 3 is answered by a rule that
already exists. Only where watchparty reads the saved pick from waits on `SETTINGS_SITE_PREFS.md`
§1.

## Ask 1: the gear (shipped)

Watchparty's chat toolbar now mounts `ConnectedSettings` beside the theme picker. It shows for
everyone in every room; the operator chose that spot.

- **Rename:** its Display name row is how a person renames themselves. hadoku_site's
  `POST /session/name` now renames every registry row of the userId.
- **Roster refresh:** `onNameChange` sends an `identity_update`, which makes the server re-read
  whoami.
- **Placement:** the popout is anchored inside the 320px chat column.
- **Character button:** it stays until the character row exists.

## Ask 2: `mountSettings` (shipped)

```ts
// @wolffm/rooms-protocol, game-bundle.ts
export interface MountedGameBundle {
  unmount(): void;
  update(ctx: GameBundleContext): void;
  mountSettings?(el: HTMLElement): () => void;
}
```

**When it runs:**
- `mountSettings` is called each time the popout opens. The cleanup you return is called when it
  closes.
- It can run several times over one mount. In the dev server, React StrictMode also opens and
  closes it one extra time.

**Guarantees from the host:**
- The host runs every open cleanup **before** `unmount()`, so a game stopped with the popout open
  never has to draw into a dead bundle.
- Calling a cleanup twice is harmless.

**Errors:**
- If `mountSettings` throws, or returns something other than a function, the host reports it and
  draws nothing. The game keeps running.
- `isMountedGameBundle` still accepts a bundle without `mountSettings`. It now rejects one whose
  `mountSettings` is present but not a function.

**When the section appears:** only while a game with `mountSettings` is open in the room's overlay
slot. Otherwise the popout has no "App preferences" row at all.

**CSS scope:** no class to add. `el` is a plain `<div>` in watchparty's document, inside the popout
panel. `scopeCss.ts` is the room chrome's build-time scoping and does not apply to game bundles.
Do what `mount()` already does: attach a shadow root to `el` and put your styles inside it. The
`--color-*` theme properties inherit through it. The panel is 300px wide.

**Tests:** watchparty covers this in `apps/ui/src/lib/__tests__/gameBundleHost.test.ts` and in
`e2e/game-bundle.spec.ts` ("the settings gear shows the open game's own settings…"). Both are
mutation-checked: dropping close-before-unmount fails them.

## Ask 3: two people with the same character

Watchparty already has a rule, and it does not change when the character becomes the person's:

- **Curated rooms:** one character per person. If a later arrival's saved pick is already worn,
  they get a stand-in for that connection only (`setSessionIdentity`, never saved), and their saved
  pick is left alone. When the holder leaves, the character goes back to the person who asked for
  it (`redistributeReleasedSprite`).
- **`cardtable-*` app rooms:** two different people may wear the same character
  (`shareSpriteInAppRoom`, 2026-10-17), so a match's chat agrees with its board.

The only follow-up is where watchparty reads the saved pick. Today that is `sprite` on its own
`watchparty` prefs row. hadoku_site plans to keep the value there, so nothing moves unless §1
picks a different row.
