# Retrospective: what cardtable band-aided, and where the real fix lives

Four waves (17–20) built a Magic client on the fleet's packages. Several
fixes we shipped are **compensations for something upstream**, and a
compensation that lives in one consumer is a bug the next consumer will find
again. Each item below says what we did, what the real fix is, and how we
verified the gap — nothing here is inferred from behaviour alone.

Written 2026-09-26, against `@wolffm/themes@5.8.6`,
`@wolffm/watchparty-ui@0.39.5`, hadoku_site `main`.

**Delivered 2026-09-26 to both teams** (wave 21 lane E). A request is delivered
when the document lands in the target repo's `docs/requests/`; "the code for it
landed" is not delivery, and parts of this had already been acted on before the
file went out.

| Target | Landed as | Commit on their `main` |
| --- | --- | --- |
| hadoku-watchparty | `docs/requests/CARDTABLE_RETRO_UPSTREAM_2026-09-26.md` | `cb399bcf` |
| hadoku_site | `docs/requests/CARDTABLE_RETRO_UPSTREAM_2026-09-26.md` | `0ecbfaf1` |

Each copy carries a delivery header listing what that repo had *already* done,
so neither is asked twice. **No item in this file is blocking us, and answers
are not waited on.** State at delivery:

- **§1** — accepted as watchparty board **E2**, mini-wave w1.5 (their
  `2e8f2640`). Our `theme` prop stays until it lands.
- **§2** — **WolffM/hadoku-task#91**, open. `@wolffm/themes` lives in
  hadoku-task, a repo this lane was not given; **nothing was delivered there**
  because watchparty had already filed it. Our `matchMedia` shim stays.
- **§3** — accepted as watchparty board **E1** (their `edfbf3de`).
- **§4** — **WolffM/hadoku_site#419**, open, with our first framing corrected by
  watchparty and their version kept.
- **§5** — **already fixed** in hadoku_site before delivery: `7b9f6ebd`, test
  `e70cf2ac`, comment `3550cc65`, and `da7a2fa0` naming the wrong fix. Nothing
  owed.
- **§6** — credit only; verified before we wrote it.
- **§7** — the only thing still genuinely open on anyone's side, and it is a
  suggestion for `templates/game`, not a defect.

Answers arrive on their boards, not here. Nothing in this repo waits on them.

---

## For watchparty (`@wolffm/watchparty-ui`)

### 1. `RoomChrome` resolves its own theme, so every consumer must remember a prop

**Our band-aid:** `RoomShell` now passes `theme={asWatchpartyTheme(theme)}`,
threading the page's resolved `@wolffm/themes` value in by hand.

**The gap:** left unset, `RoomChrome` resolves a default from ITS OWN internal
store — `Do()` in `dist/room-chrome.js` returns the store's cached theme if one
has loaded, else hard-codes `'dark'` — with no reference to the
`HadokuThemeRoot` the host is already inside. Two independent defaults, so they
disagree whenever the host's differs from `dark`.

**Verified, not guessed:** measured live on a stub-`whoami` build with no saved
theme in either storage — the page resolved `data-theme="light"` on
`.cardtable-chrome` while `.wp-room-chrome` sat at `data-theme="dark"`. The
operator's report was *"why are the watchparty components loaded with a
different theme selection than the rest of the page? both use hadoku themes."*

**Why it matters beyond us:** hadoku_site's `templates/game` —
`apps/ui/src/room/RoomShell.tsx:67` — mounts `RoomChrome` with
`roomKey`/`serverOrigin`/`userType`/`userId` and **no `theme`**. Every game
hydrated from that template inherits this bug before anyone writes a line.

**The real fix, in preference order:**
1. Default to the host's resolved theme — read the same `@wolffm/themes`
   context the host provides, and fall back to the internal store only when
   there is no provider above.
2. Failing that, make the prop's absence loud: a dev-mode warning when a
   `HadokuThemeRoot` is present above and `theme` was not passed.

**Outcome:** confirmed by watchparty — `resolveTheme` (`RoomChrome.tsx:68-72`)
returns the prop, else their store's saved theme, else literal `'dark'`, and
the chrome consults no provider. Their board **E2**, taking option 1, riding
with the `name` prop since it is the same file. They noted the
`templates/game` evidence is what moved it from "cardtable passes a prop" to
"every game from that template is born wrong" — worth fixing rather than
documenting.

### 2. `@wolffm/themes` guards `matchMedia` in one place and not the other

**Our band-aid:** `apps/ui/src/chrome/matchMedia.ts`, a shim installed before
anything from the package runs an effect.

**The gap, still present in 5.8.6:** `prefersDark()` guards the call —
`dist/useTheme.js:43`, `typeof window !== 'undefined' && window.matchMedia ? …`
— but the OS light/dark effect does not: `dist/useTheme.js:216` is a bare
`window.matchMedia('(prefers-color-scheme: dark)')` inside a `useEffect`.

**Consequence:** jsdom has never implemented `matchMedia`, so any consumer that
renders a themed tree under jsdom throws `window.matchMedia is not a function`
in the passive-effect commit. For us that was 26 existing tests going red the
moment the chrome mounted — in files that had nothing to do with theming.

**The real fix:** one guard, the same shape as line 43, at line 216. Every
consumer testing under jsdom is otherwise writing our shim.

**Outcome:** confirmed by watchparty against source — `src/useTheme.tsx:57`
guards, `:249` is bare (the `dist:216` we cited), and `src/index.ts:107`
guards too, so `:249` is the ONLY unguarded site. The package lives in
hadoku-task; filed as **WolffM/hadoku-task#91**. Our shim stays until it
lands.

### 3. `name` on `RoomChrome` — accepted, noted here for completeness

Already agreed with your session on 2026-09-25 (precedence: in-room custom
name > host prop > auto identity). Our one-liner is staged. Not a complaint —
recorded so this document is the whole picture.

### 4. `whoami()`'s default origin is a trap for prefix-served apps

**Our band-aid:** `hadokuWhoami({ whoamiUrl: \`${globalThis.location.origin}/session/whoami\` })`
— an explicit same-origin URL.

**The gap — corrected 2026-09-26, our first framing was wrong.** We wrote
"defaults to the edge-router origin, so a prefix-served app makes an off-host
request." Watchparty checked the source and the mechanism is different:
`PREFS_API_BASE` is a hard-coded **absolute** `https://hadoku.me/prefs`
(`constants.ts:17` → `whoami.ts:174`; verified here in
`dist/index.js:2` and `:151`), so the whoami default is
`https://hadoku.me/session/whoami`. For an app served at `hadoku.me/<prefix>`
that IS same-host, and it works.

The defect is that the default is **pinned to one absolute origin at all**: it
is right on hadoku.me and silently wrong for local dev, any other hostname,
and the APK / service-to-service callers the file's own comments mention. Ours
surfaced only under e2e, where the app is on 127.0.0.1 and a block on every
non-local request caught it (`8d71303`) — "passes review and passes the prod
smoke while being wrong everywhere else" is exactly what makes this worth a
fix rather than a doc line.

**The real fix:** resolve the base from the serving origin, with the absolute
as a fallback for callers that genuinely have no origin (APK, s2s). Filed by
watchparty as **WolffM/hadoku_site#419**.

---

## For hadoku_site (`templates/game`, hydrator)

### 5. The template carries gap #1 forward — one line, before the next app

`templates/game/apps/ui/src/room/RoomShell.tsx:67` mounts `RoomChrome` without
a `theme`. Until watchparty fixes the default, the template should pass the
host's resolved theme explicitly, exactly as we now do. Otherwise the next
game is born with a chat panel on a different theme from its page, and finds
out when its operator opens it.

### 6. Credit where due: the chrome-warning gap is already closed

For the record, because this retro would otherwise read as one-sided: the
"loopback-ui apps get no chrome" hole — the one that left cardtable with no
theme picker for four days — **is fixed**, with the loopback arm added
2026-09-19 and cardtable named in the comment. We verified it in
`scripts/build/hydrate-child-app.mjs:2252-2280` before writing this. Nothing
is owed there.

### 7. Two e2e lessons your template could carry, from our own scars

Not gaps in your code — patterns worth scaffolding, since `templates/game` is
where the next game's tests come from:

- **A container-backed feature leaks docker NETWORKS, not just containers.**
  Our streamed rooms create a network per room; removing the container leaves
  it. Twenty-two accumulated until docker refused to create any more (`all
  predefined address pools have been fully subnetted`) — which breaks
  provisioning for **every service on the host**, and which a container census
  cannot see. If the template ever grows a docker-backed feature, its teardown
  wants a network census beside the container one.
- **An e2e that drives a real game must seed it.** Ours hunted for a castable
  spell to prove a behaviour, unseeded — so the shuffle decided whether the
  proof was reachable, and CI reddened a dependency-bump commit that could not
  have touched it. Seed the game AND make the assertion state what it can
  prove: "the scenario did not occur" is not the same as "the behaviour is
  broken", and only one of them should fail a build.

---

## What we are NOT asking

- Not asking anyone to take our code. Every fix above is ours to keep until
  the upstream one lands; each is small and none of them are blocking us.
- Not asking for timelines.
- Not reporting anything we have not verified in the shipped artifact — file
  and line for each, at the versions named at the top.

— hadoku-cardtable tracker
