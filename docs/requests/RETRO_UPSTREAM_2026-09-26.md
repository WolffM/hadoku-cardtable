# Retrospective: what cardtable band-aided, and where the real fix lives

Four waves (17–20) built a Magic client on the fleet's packages. Several
fixes we shipped are **compensations for something upstream**, and a
compensation that lives in one consumer is a bug the next consumer will find
again. Each item below says what we did, what the real fix is, and how we
verified the gap — nothing here is inferred from behaviour alone.

Written 2026-09-26, against `@wolffm/themes@5.8.6`,
`@wolffm/watchparty-ui@0.39.5`, hadoku_site `main`.

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

### 3. `name` on `RoomChrome` — accepted, noted here for completeness

Already agreed with your session on 2026-09-25 (precedence: in-room custom
name > host prop > auto identity). Our one-liner is staged. Not a complaint —
recorded so this document is the whole picture.

### 4. `whoami()`'s default origin is a trap for prefix-served apps

**Our band-aid:** `hadokuWhoami({ whoamiUrl: \`${globalThis.location.origin}/session/whoami\` })`
— an explicit same-origin URL.

**The gap:** `@wolffm/prefs-client`'s `whoami()` defaults to the edge-router
origin. An app served under a path prefix on the same host then makes an
**off-host request** for its own identity. Ours was caught by an e2e that
blocks every non-127.0.0.1 request (`8d71303`), which is the only reason we
found it rather than shipping it.

**The real fix:** default to same-origin `/session/whoami`, or document the
default as "the edge origin, which is wrong for any app that is not served
from it." A default that is right for one deployment shape and silently wrong
for another is the expensive kind.

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
