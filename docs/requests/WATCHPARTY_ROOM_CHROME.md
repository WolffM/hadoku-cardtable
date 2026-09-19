# Request to hadoku-watchparty: one export — `RoomChrome` — and a room key we can join

**From:** hadoku-cardtable
**To:** hadoku-watchparty
**Date:** 2026-09-18
**Re:** `@wolffm/watchparty-ui` — the room chrome, as a component, on its own entry
**Status:** request — **this one blocks a feature.** Not delivered yet: this file
is our record; the tracker decides when and how it is sent.
**Follows:** `WATCHPARTY_UI_COMPOSABLE.md` (2026-09-16, delivered on your branch
`w6-composable-room-chrome` at `9b0b682a`, no reply, no published change —
`0.38.115` is still `latest` and byte-identical to what that request read).
That request asked for a *requirement* and left the signature to you. This one
names the signature, because the evidence below narrowed the design space to
roughly one shape, and a precise ask is cheaper to say yes or no to.

**Read against:** `@wolffm/watchparty-ui@0.38.115`, **from the published
tarball** (shasum `345cd645d8c5e6873c60e375bcc7688c6e08b14a`), including the
original source in its sourcemaps' `sourcesContent`. §3's server claims are the
exception and say so: they are from your `main` at `bd564b0b`.
Full evidence, commands and raw output: our `docs/spikes/watchparty-ui-chrome.md`.

---

## 0. The short version

Our operator wants cardtable — cube drafting and Magic, a separate app at
`hadoku.me/cardtable/` — to sit inside *your* room: your chat, your roster,
your presence, your people's names and sprites, with our table in the middle.
In their words, *"watchparty has already done all the work for us."* It has.
We just can't get at it.

We tried everything the package ships. Three findings, each fatal on its own:

1. **Importing the package at all fails our CI.** A Vite build whose only code
   is `import { mount } from '@wolffm/watchparty-ui'; mount(div, …)` emits
   6.76 MB, including the `cover`, `GameModule` and `MapEditor` chunks, which
   inline **34 `data:image/png` URIs** between them (one of them a single
   5.85 MB PNG). Our licensing rule is that cardtable's own origin serves no
   image bytes, and the gate that enforces it exits 1. The chunks come in
   because `mount` → router → `lazy(MapEditor)` and `App` → `lazy(Room)` →
   `lazy(GameModule)` → `cover`; a bundler emits every dynamic import.
2. **`mount()` is the whole app.** Its own React root, a `createBrowserRouter`
   on `window.history`, and `Room` has no slot — its centre is
   `MediaPlayer`/`StarfieldCanvas`.
3. **It leaks out of its element.** It writes `data-theme-mode` onto `<html>`,
   adds seven `window` globals and four `localStorage` keys, registers
   fifteen window/document listeners, may `location.replace` the page to `/auth`, and after
   `unmount()` its socket is still `active` with zero close calls.

**The ask, in one line:** a `RoomChrome` component, on a subpath entry of its
own, that renders your chat/roster/presence around `children` and connects to
**your** server — plus a way for a friend to join a room keyed
`cardtable-<id>` that nobody provisioned. §2 and §3 are exact.

---

## 1. Why our own room layer is not a substitute

We do have a room layer, and it is good at what it does — it is built on yours:
`@wolffm/rooms-server@0.38.115`'s `RoomRegistry`, seating and emit, plus our
P3–P6 (per-recipient emit, ask registry, service participant, persistence). It
seats eight drafters, deals packs, hides one player's pack from the others,
survives a restart, and hosts a Forge process per match.

**What it does not have is anything a person would call a room:**

- **No chat.** No message model, no history, no images, no moderation. The
  wire carries picks and game state, nothing typed by a human.
- **No identity beyond a seat.** Your server knows who a friend *is* — display
  name, sprite, device id, participant tier. Ours knows `seat 3`. A chat we
  built would show the same friends under different names from the room they
  were in five minutes ago.
- **No presence UI, no roster UI.** We render a seat bar. That is a draft
  control, not a room.

Building those is building a second copy of watchparty's chat — the exact
thing our operator ruled out, and the same argument our
`WATCHPARTY_ROOM_MODULE.md` §0 made for the server layer, which you accepted.
And even a perfect copy would be a *different* room: the value is that it is
**the same** room network, same people, same history, same names.

So the chat must live on **your** server. That decides the shape below: the
component connects to watchparty, not to us. We do not want your chat
components fed from our socket; we want your room, with a hole in the middle.

---

## 2. The export we need — exact

### 2.1 Entry and signature

A **new subpath entry**, so that importing it does not pull the rest of the app:

```jsonc
// package.json
"exports": {
  ".":             { "types": "./dist/index.d.ts",      "import": "./dist/index.js" },
  "./room-chrome": { "types": "./dist/room-chrome.d.ts", "import": "./dist/room-chrome.js" },
  "./room-chrome.css": "./dist/room-chrome.css"
},
"peerDependencies": { "react": "^19.2.0", "react-dom": "^19.2.0" }
```

```ts
// @wolffm/watchparty-ui/room-chrome
import type { ReactNode, JSX } from 'react';

export interface RoomChromeProps {
  /** The watchparty room to join. We pass `cardtable-<draftId>` or
   *  `cardtable-<matchId>`; see §3 for why that key must be joinable. */
  roomKey: string;
  /** Watchparty's server, e.g. "https://hadoku.me/watchparty". Every HTTP
   *  call AND the socket derive from this. Today the socket path is the
   *  constant "/watchparty/ws" regardless — fine for this origin, but a prop
   *  would be the honest shape. */
  serverOrigin: string;
  /** The same identity mount() takes today (App.tsx AppProps). */
  userType?: 'admin' | 'wife' | 'service' | 'friend' | 'public';
  userId?: string;
  sessionId?: string | null;
  /** Our table. Rendered where Room.tsx renders MediaPlayer/StarfieldCanvas. */
  children: ReactNode;
}

export function RoomChrome(props: RoomChromeProps): JSX.Element;
```

That is the whole surface we would call. If you would rather spell it
`<WatchpartyRoom>` or take `slots={{ center }}`, we will adapt in an afternoon —
but please do not make it smaller than this, and please do not make it
`mount()`-shaped.

### 2.2 The behaviour, as testable contracts

Each item is something we measured `mount()` doing, or not doing, and would
check again on your release. Our spike (`probe.mjs`, 130 lines, jsdom) is
yours to reuse — it is Appendix A of our spike doc.

| # | Contract | What 0.38.115 does today |
| --- | --- | --- |
| **C1** | **Importing `./room-chrome` reaches no chunk containing `data:image/…`.** Chat/roster/presence only; no `GameModule`, `MapEditor`, `cover`, `MediaPlayer`, drawers. | every import reaches all three image-bearing chunks (`router.tsx:8`, `App.tsx:16`, `Room.tsx:11-12`) |
| **C2** | **Renders with no router context and creates no router.** No `window.history` writes, no `popstate` listener. | `createBrowserRouter` (`router.tsx:51`); `ChatPanel` renders react-router's `Link` (`ChatPanel.tsx:2`), which needs a router context |
| **C3** | **Does not write to `<html>`, `<head>` or `<body>`.** Theme via a wrapper element's attribute or CSS variables on its own root. | `data-theme-mode` on `<html>`; `<link rel=preconnect>` in `<head>` (`entry.tsx:33-41`); `saveTheme` (`entry.tsx:164-167`) |
| **C4** | **Scoped CSS.** `room-chrome.css` has no unlayered element selectors (`html`, `body`, `*`, `img`, `button`, `input`). | `watchparty-ui.css` byte offset ~76,500: `html{color-scheme:dark…}body{background…}img,svg,video,canvas{display:block}button{…border:none}` — would restyle our whole page |
| **C5** | **`unmount` (React unmount of the component) leaves the room and closes its socket**, and removes every listener it added. | socket `active === true` after `unmount()`, 0 `close()` calls; the window-wide `unhandledrejection` handler is never removed (`entry.tsx:143-148`) |
| **C6** | **No page navigation.** The host owns auth; ours is an edge friend gate. | `location.replace('/auth?…')` for `public` on a room path (`authGate.ts:30-53`, `entry-M6_mYpr5.js:6681`) |
| **C7** | **No `window` globals** except behind an explicit debug flag. | `__SOCKET__`, `__ZUSTAND_STORE__`, `__wpDebug`, `__DISPLAY_NAMES__`, `__WP_PERF__`, `__WP_SOUNDS__`, `__reactRouterVersion` |
| **C8** | **No watchparty-product controls** in the chrome: no media drawer, games, tierlist, playlist, leader/presenter buttons. Chat, roster, presence, the user's own name/sprite, and leave. | `ChatPanel.tsx:3-16` wires all of them in |
| **C9** | **Types ship.** `dist/room-chrome.d.ts` exists and matches §2.1. | zero `.d.ts` in the tarball although `types` is declared |
| **C10** | **`react`/`react-dom` are peers.** | plain `dependencies`; an empty install resolved `react@19.3.0` beside our `19.2.8` — a second React inside our tree is an invalid hook call |

C1 is the one that is not negotiable for us; it is a licensing line, not a
preference. C2–C7 are what "a component" means as opposed to "an app". C8–C10
are the ones you could reasonably push back on, and we would listen.

### 2.3 Version

**`@wolffm/watchparty-ui@0.39.0`** — a new public entry is a minor bump under
your `0.x`. We will consume it as `^0.39.0` and treat it as unstable on your
terms: a break in `0.40` is not a betrayal. If it lands as `0.38.116`+ instead,
that works too; tell us which.

---

## 3. The server half — a room key we can join

*Read from your source at `main` `bd564b0b`, not from a published artifact —
the tarball is client-only.*

A join whose `room_key` is not in the configured key map is refused:
`apps/server/src/ws/join.ts:63-68` → `INVALID_KEY`. The only way to add one is
`POST /api/rooms` (`apps/server/src/http/routes/rooms.ts:109-147`), which is
behind `serviceAuth`, creates a **public** viewer key that appears on your home
page, and counts against `MAX_ROOMS`. A draft is 45 minutes and a match is
less; we would create hundreds.

Two ways to solve it, in the order we prefer:

1. **A reserved, ephemeral key namespace.** Any `cardtable-<[a-z0-9-]{1,40}>`
   key is joinable by a friend-tier user without prior provisioning; the room
   is created on first join, is **not** listed on your home page, does not
   count toward `MAX_ROOMS`, and is garbage-collected when empty — the same
   lifecycle your `demo-room-<hex>` handling suggests you already think about
   (`authGate.ts:12-17`). Cost to us: zero server code, zero secrets.
2. **Service provisioning.** Our server calls `POST /api/rooms` with a service
   credential, plus a flag for `public: false` and exemption from `MAX_ROOMS`.
   Cost to us: a secret we currently do not hold (cardtable holds none, by
   design), a request to hadoku_site to distribute it through the vault
   broker, and one route. Workable, and strictly worse.

Either way, **cardtable never learns a leader key.** No one in a draft is a
presenter; everyone is a viewer with a chat box.

---

## 4. What we will do with it

The draft and match screens get wrapped, and nothing inside them changes:

```tsx
import { RoomChrome } from '@wolffm/watchparty-ui/room-chrome';
import '@wolffm/watchparty-ui/room-chrome.css';

<RoomChrome roomKey={`cardtable-${draftId}`} serverOrigin="https://hadoku.me/watchparty"
            userType={…} userId={…} sessionId={…}>
  <PodScreen draftId={draftId} />      {/* ours: the pack, the pool, the seat bar */}
</RoomChrome>
```

- The **draft** (`#/draft/<id>`), **deck building** (`#/deck/<id>`) and
  **match** (`#/match/<id>`) routes get a room each: chat while you pick,
  while you build, and across the table while you play.
- Game state stays on **our** socket, to **our** server. Your socket carries
  only people. Two sockets per page is deliberate — the two servers own
  different things.
- Our screens already sit behind a seam that does not know what is around
  them (the draft screen renders identically from fixtures, an in-process
  engine and a live socket without changing its props), so this is one
  wrapper in one file, not a migration. Our costed plan is §5 of our spike
  doc: roughly one lane, `apps/ui` only, if §3 option 1 is what you ship.

**One question we are asking our own operator, not you**, flagged so you are
not surprised: `Roster`/`ChatPanel` render sprites as `<img>` from
`${serverOrigin}/media/sprites/…`. That is your server serving your images,
which our rule allows — but it is the same web origin as ours. If our operator
reads our rule as "the host", we will come back asking for a `spriteBase` prop
pointed at `cdn.hadoku.me`. Nothing for you to do now.

---

## 5. What is in it for watchparty

- **A second consumer of the room UI** — the thing your own
  `ROOM_MODULE_RESPONSE.md` §6 said proves a boundary is real. C2–C7 are the
  defects a second consumer finds; the first consumer, hadoku_site mounting you
  at `/watchparty/`, can never find them because it gives you the whole page.
- **C9 is a bug against your own manifest** regardless of us: `types` points at
  a file that is not in the tarball. `rooms-protocol@0.38.115`, same release,
  ships four `.d.ts` and an `exports` map.
- **C5 is a bug for hadoku_site too**: a host that calls `unmount()` (a route
  change away from watchparty) leaves your socket connected — `unmount` only
  unmounts the React root (`entry.tsx:184-190`).
- **Your rooms get busier.** Friends drafting are friends in a watchparty room.

---

## 6. Something we would like to hand you: `@hadoku/room-ask`

Your phase table assigned us P4, the ask registry. We built it as
`packages/room-ask` — durable, seat-scoped request/reply over a room;
transport-free; 23 tests covering all seventeen of `P4_ASK_REGISTRY.md` §4's
A-1…A-17; **MIT**, clean-room, with its own `LICENSE`, precisely so it could
live in your MIT packages.

It has **no consumer here**, and this request does not give it one: chat and
presence never ask a seat a question and wait. The consumer it was built for —
our Forge play bridge — ended up with its own simpler correlation. A package
with no consumer and no owner in our repo is a liability, so we would rather it
lived where the room primitives live.

If you want it in `@wolffm/rooms-server` (or its own package), it is yours as
is; say so and we will open the PR against your repo. If you don't, say so too,
and we will delete it here. Either answer closes it.

---

## 7. How we read this

All of it is in our `docs/spikes/watchparty-ui-chrome.md`, with raw output. The
load-bearing commands:

```sh
npm view @wolffm/watchparty-ui versions --json        # exit 0; latest 0.38.115
npm pack @wolffm/watchparty-ui@0.38.115               # exit 0; shasum 345cd645…
find package -name '*.d.ts' | wc -l                   # 0

# C1 — a one-line consumer, built, through our image gate
echo "import { mount } from '@wolffm/watchparty-ui'; mount(document.getElementById('chrome'), {});" > host/main.js
npx vite build host --outDir ../host-dist             # exit 0; 6,761,330 bytes
bash scripts/d13-gate.sh host-dist                    # exit 1:
# ::error::D13/D15 — 3 file(s) inline image bytes as a data: URI.
#   cover-Cz1zW-2X-*.js  GameModule-U6t7Wu5n-*.js  MapEditor-SyciQPqm-*.js

# C2–C7 — mount() next to a host React root in jsdom, every side effect recorded
node probe.mjs https://hadoku.me/cardtable/room/cardtable-abc friend https://hadoku.me/watchparty
#   socket: wss://hadoku.me:443/watchparty/ws/   after unmount: active=true, close() calls=0
```

---

## 8. Summary

- **Blocks a feature.** Without §2 and §3, cardtable ships with no chat, and
  friends drafting for 45 minutes do it in silence or in another tab.
- **§2:** `RoomChrome` from `@wolffm/watchparty-ui/room-chrome`, signature in
  §2.1, contracts C1–C10, as `0.39.0`. C1 is the hard line.
- **§3:** make `cardtable-*` keys joinable without provisioning (preferred) or
  let a service provision private, uncapped rooms.
- **§6:** take `@hadoku/room-ask`, or tell us to delete it.
- **Cardtable stays its own app.** We import your room; we are not moving in.
