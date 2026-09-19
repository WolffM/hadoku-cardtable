# Wave 12 lane D — can `@wolffm/watchparty-ui` give us room chrome?

The question D17 left open: the operator wants cardtable connected to *"my room
and network system"*, and D17 settled the shape — cardtable is its own app and
**imports** watchparty's room chrome. This spike reads what the package actually
ships and tries to use it without handing it our app.

**Answer: no, not in any form we can ship.** Three independent reasons, each
enough on its own, every one of them measured below:

1. **Importing it at all fails our own CI.** A Vite build whose only line is
   `import { mount } from '@wolffm/watchparty-ui'` emits **6.76 MB** and
   **three chunks carrying inlined `data:image/png` bytes**, and
   `scripts/d13-gate.sh` — the gate CI runs on `apps/ui/dist` — exits **1** on
   it. Our origin would be serving image bytes. That is the one half of D13 that
   D15 kept. (§4)
2. **`mount()` is the whole watchparty app, not chrome.** It creates its own
   React root and a *browser* router, renders watchparty's home page or its full
   room (starfield, media player, drawers, games), and there is no slot for our
   draft. On our real URL (`/cardtable/#/draft/<id>`) it renders *"Watch Party ·
   Rooms · No rooms available."* (§3)
3. **It does not stay in its box.** It writes to `<html>`, adds seven `window`
   globals and four `localStorage` keys, registers fifteen window/document
   listeners, can `location.replace` the whole page to `/auth`, and its socket
   is **still active after `unmount()`**, with zero close calls. (§3)

So this lane takes the brief's branch (b): the request is
`docs/requests/WATCHPARTY_ROOM_CHROME.md`, naming the export, signature and
version we need.

Everything here is read from the **published tarball** and exercised against
its `dist/`. Where a claim comes from watchparty's *source tree* instead, it
says so — the local checkout was read for context only, and it is not what we
would install.

---

## 1. What we fetched

```sh
npm view @wolffm/watchparty-ui versions --json   # exit 0; newest is 0.38.115
npm view @wolffm/watchparty-ui dist-tags --json  # { "latest": "0.38.115" }
npm pack @wolffm/watchparty-ui@0.38.115          # exit 0
#   shasum    345cd645d8c5e6873c60e375bcc7688c6e08b14a   (npm's sha1)
#   sha256    075e43001fcf67cba197bbb20e46db8e06385ce76efa2549e07b3289a53ae638
#   26 files · 9,799,307 bytes packed · 14,900,253 bytes unpacked
```

**Nothing newer than 0.38.115 exists** (checked 2026-09-18). It is the same
artifact D17 and `WATCHPARTY_UI_COMPOSABLE.md` read on 2026-09-16 — same
shasum — so that request has had no answer in a published version.

### 1.1 `package/package.json`, verbatim fields

| field | value | what it means for us |
| --- | --- | --- |
| `main` | `./dist/index.js` | the only entry |
| `types` | `./dist/index.d.ts` | **the file does not exist** — `find package -name '*.d.ts'` returns 0 |
| `exports` | *absent* | no subpath entries; nothing encapsulated |
| `peerDependencies` | *absent* | **`react` and `react-dom` are plain `dependencies`** (`^19.2.3`) |
| `sideEffects` | `["*.css"]` | declares the JS side-effect-free; `dist/index.js:4` is a bare side-effect `import "@wolffm/themes"` |
| `dependencies` | `@wolffm/cdn-client ^1.0.5`, `@wolffm/prefs-client ^1.0.12`, `@wolffm/task-ui-components ^4.8.1`, `@wolffm/themes ^5.8.3`, `react ^19.2.3`, `react-dom ^19.2.3`, `react-router-dom ^7.12.0`, `socket.io-client ^4.8.3`, `zod ^4.0.0`, `zustand ^5.0.10`, `@wolffm/rooms-protocol 0.38.115` | see §2.2 — several of these are bundled anyway |

React as a dependency rather than a peer is not academic: installing the
tarball into an empty directory resolved **`react@19.3.0`**, and `apps/ui` pins
**`19.2.8`**. A component (as opposed to a separate root) rendered inside our
tree from a second React copy is an *invalid hook call*. Whether pnpm would
dedupe it in our workspace was **not** tested — `apps/ui/package.json` and the
lockfile are not this lane's.

### 1.2 The entry, in full — `dist/index.js` (246 bytes)

```js
import { a6 as p, a4 as e, a5 as u } from "./chunks/entry-M6_mYpr5.js";
import "react";
import "react-dom/client";
import "@wolffm/themes";
export {
  p as createWatchpartyRouter,
  e as mount,
  u as unmount
};
```

Three named exports, no default. The export map of the chunk they come from is
`dist/chunks/entry-M6_mYpr5.js:6840-6903`: `Pc as a4` (`mount`), `Mc as a5`
(`unmount`), `Ju as a6` (`createWatchpartyRouter`), plus 58 single-letter
internal exports for the other chunks.

### 1.3 The sourcemaps carry the original source

Every `*.js.map` in the tarball has `sourcesContent`. So "what does `mount`
do" does not need de-minifying — the TypeScript that built these bytes is *in
the bytes we downloaded*. Extracted (151 files) with:

```sh
node -e '
const fs=require("fs"),path=require("path");
for (const f of fs.readdirSync("package/dist/chunks").filter(f=>f.endsWith(".map"))) {
  const m=JSON.parse(fs.readFileSync("package/dist/chunks/"+f,"utf8"));
  m.sources.forEach((s,i)=>{ if(!s.includes("node_modules") && m.sourcesContent[i]!=null){
    const out="src-extract/"+s.replace(/^(\.\.\/)+/,"");
    fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out,m.sourcesContent[i]); }});
}'
```

Citations below of the form `src/entry.tsx:56` are line numbers in that
extracted source; citations of the form `entry-M6_mYpr5.js:6797` are lines in
the shipped minified chunk. Both come from the tarball.

---

## 2. What the three exports do

### 2.1 `mount(el, props)` — `entry-M6_mYpr5.js:6797-6835`, source `src/entry.tsx:56-182`

`props` is `AppProps & { basename?, strictMode? }` (`src/entry.tsx:24-27`), where
`AppProps` is `{ serverOrigin?, defaultRoomKey?, userType?, userId?, sessionId?,
theme?, cdnBase?, onAuthRequest? }` (`src/App.tsx:71-85`). In order, it:

1. writes module-global runtime config (`setRuntimeConfig`, `:60-64`) and auth
   identity (`setAuth`, `:75-79`) — **process singletons**, so a second
   `mount` anywhere on the page overwrites the first's;
2. mints a device id into `localStorage` (`primeDeviceId`, `:70`);
3. fires `GET /session/whoami` at the page's own origin (`loadWhoami`, `:129`;
   `src/lib/auth.ts:92`) and a cross-device prefs sync (`:135`);
4. registers a **window-wide** `unhandledrejection` handler, once per page
   (`:143-148`; `entry-M6_mYpr5.js:6825`);
5. appends a `<link rel="preconnect">` to **`document.head`** (`:151-153`;
   `injectPreconnect`, `:33-41`);
6. calls `saveTheme` from `@wolffm/themes`, which mirrors the theme into
   `sessionStorage` and the DOM (`:164-167`);
7. builds `createWatchpartyRouter({ basename, appProps })` (`:174-177`),
   `createRoot(el)` and renders `<RouterProvider router>` into it (`:178`),
   stashes the root at `el.__watchparty` (`:180`), and **returns the router**.

### 2.2 `createWatchpartyRouter({ basename = '/watchparty', appProps })` — `entry-M6_mYpr5.js:6755-6766`, source `src/router.tsx:33-52`

Four routes — `/`, `/editor`, `/room/:roomKey`, `/:roomKey` — every one of
which renders the whole `App` (or the map editor), handed to
**`createBrowserRouter`** (`src/router.tsx:51`; bundled react-router's `is()` at
`entry-M6_mYpr5.js:4485`, which builds a `window.history`-backed history). That
router owns `window.history` and listens on `popstate`.

`App` (`src/App.tsx`, `entry-M6_mYpr5.js:6683-6744`) wraps everything in
`HadokuThemeRoot` inside a `h-screen` div, health-checks
`${serverOrigin}/healthz` and swaps the whole view for `APIDownFallback` if it
fails, preloads every character sprite, and routes to `Home` (watchparty's room
list) or `Room`.

**What is bundled, not imported.** The sourcemaps name the packages compiled
*into* the chunks: `react-router`, `zustand`, `socket.io-client` (+
`engine.io-client`, parsers), `@wolffm/cdn-client`, the react JSX runtime, and
watchparty's own `packages/shared` and `packages/rooms-protocol/dist/resync.js`.
So the declared `react-router-dom`, `socket.io-client`, `zustand` and
`@wolffm/rooms-protocol` dependencies are installed but the running code uses
its private copies. External at runtime: `react`, `react-dom`,
`react-dom/client`, `@wolffm/themes`, `@wolffm/prefs-client`,
`@wolffm/task-ui-components`, `zod` (the `^import` lines of each chunk).

### 2.3 `unmount(el)` — `entry-M6_mYpr5.js:6836-6839`, source `src/entry.tsx:184-190`

`el.__watchparty.root.unmount()` and deletes the stash. **That is all.** React
runs the components' own effect cleanups, but nothing `mount()` did outside
React is undone — the `unhandledrejection` handler, the `<head>` link, the
`<html>` attribute, the globals, the storage keys — and the socket, a module
singleton, is not disconnected. §3 measures the socket and the `<html>`
attribute after `unmount()`; the rest follows from the source above.

### 2.4 The room, and why a slot is not there to find

`Room` (`src/routes/Room.tsx:169-224`) is a fixed layout: a centre region that
renders `MediaPlayer` or `StarfieldCanvas`, optionally overlaid by
`GameModule`; `FloatingChat`, `ClientStatusOverlay` and `TierlistModal`
portalled; `ChatPanel` as the sidebar; media/game drawers and a character
modal. It takes **no props and no children** — the centre is not a slot.

`ChatPanel` and `Roster` — the pieces we want — read everything from a
module-singleton zustand store (`useAppStore`, `src/components/ChatPanel.tsx:22-35`,
`src/components/Roster.tsx:10`) that is fed by a module-singleton socket
(`src/lib/socket.ts:24,76-95`). `ChatPanel` also imports react-router's `Link`
(`:2`), which needs a router context (not exercised outside one here), and carries watchparty-product
controls: media drawer, games, tierlist, playlist, admin panel (`:3-16`).

The socket: `io(origin, { path: DEFAULT_WS_PATH })` (`src/lib/socket.ts:89`;
`Room-B93sVpM9.js:2701`) with `DEFAULT_WS_PATH = "/watchparty/ws"`
(`entry-M6_mYpr5.js:4831`). The origin's *path* is stripped (`socket.ts:87-88`),
so whatever `serverOrigin` we pass, the socket goes to `wss://<host>/watchparty/ws`
— **watchparty's own server**, speaking watchparty's own join protocol
(`CORE_EVENTS.JOIN` with `room_key`, `name`, `sprite`; `socket.ts:38-74`).

**Deep-importing a component is not an option either.** `Room-B93sVpM9.js`
exports 24 single-letter bindings (`B`, `D`, `F`, `R`, `a`…`u`); `R` is the
lazy `Room` module namespace (`:8344-8347`), and the chrome components are not
among the exports at all. A content-hashed filename with minified export names
is not an API.

---

## 3. Spike A — mount it next to our app and record what it touches

`probe.mjs` (Appendix A) builds a jsdom page with **our own React root rendered
first** in `#host`, then calls the published `mount()` on a sibling `#wp` div,
waits 1.5 s, records every side effect, then calls `unmount()` and records what
is left. `fetch`, `sendBeacon`, `WebSocket` and `XMLHttpRequest` are recording
stubs, so nothing left the machine. Setup, outside the repo:

```sh
cd "$(mktemp -d)" && echo '{"name":"wp-mount-probe","private":true,"type":"module"}' > package.json
npm install ./wolffm-watchparty-ui-0.38.115.tgz jsdom@26      # exit 0, 60 packages
node probe.mjs <url> <userType> <serverOrigin> > out.json      # exit 0 in all four runs
```

| run | URL | userType | serverOrigin |
| --- | --- | --- | --- |
| **lobby** | `https://hadoku.me/cardtable/#/draft/abc` — our real route shape | friend | `https://hadoku.me/cardtable` |
| **room** | `https://hadoku.me/cardtable/room/cardtable-abc` | friend | `https://hadoku.me/cardtable` |
| **room-wporigin** | same | friend | `https://hadoku.me/watchparty` |
| **room-public** | same | public | `https://hadoku.me/cardtable` |

### 3.1 Results

| observed | lobby | room | room-wporigin | room-public |
| --- | --- | --- | --- | --- |
| `mount` threw | no | no | no | no |
| router matched | `/` | `/room/:roomKey` | `/room/:roomKey` | `/room/:roomKey` |
| rendered (first 50 chars of text) | *"Watch PartyRoomsNo rooms available."* | *"0No messages yet. Be the first to say something!"* | same as room | *(nothing — see below)* |
| `<html>` attributes added | `data-theme-mode="simple"` | same | same | same |
| `window` globals added | 4 | 7 | 7 | 4 |
| `localStorage` keys added | 3 | 4 | 4 | — |
| HTTP requests | 5 | 7 | 7 | 4 |
| WebSockets opened | 0 | 1 → `wss://hadoku.me:443/watchparty/ws/` | 1 → same | 0 |
| full-page navigation | — | — | — | **`location.replace('/auth?return=…')`** (jsdom: *"Not implemented: navigation"*) |
| our `#host` root after mount + unmount | intact | intact | intact | intact |
| socket `active` **after `unmount()`** | — | **true** | **true** | — |
| `WebSocket.close()` calls on unmount | — | **0** | **0** | — |

The seven globals: `__reactRouterVersion`, `__wpDebug`, `__ZUSTAND_STORE__`,
`__DISPLAY_NAMES__`, `__WP_PERF__`, `__WP_SOUNDS__`, `__SOCKET__`. The four
storage keys: `hadoku_device_id`, `prefs-cache:<uid>:portfolio`,
`prefs-cache:<uid>:watchparty`, `watchparty_delivery_client_id`. Listeners
registered on the room run: `document:click|fullscreenchange|keydown|mouseout|mouseover|selectionchange|touchend`,
`window:pagehide|popstate|storage|unhandledrejection|watchparty:focus-chat-input|watchparty:open-game-drawer|watchparty:open-media-drawer`
(plus `window:test`, a passive-support probe). Router called
`history.replaceState` once on every run.

The requests on the **room** run, all derived from `serverOrigin`:

```
GET  https://hadoku.me/session/whoami
GET  https://hadoku.me/cardtable/media/sprites/names.json
GET  https://hadoku.me/cardtable/healthz
GET  https://hadoku.me/cardtable/api/flags
GET  https://hadoku.me/cardtable/api/tierlist
GET  https://hadoku.me/cardtable/api/rooms/validate/cardtable-abc
POST https://hadoku.me/cardtable/api/client-log
```

With `serverOrigin` = `/cardtable`, **HTTP goes to our server and the socket
goes to theirs** — split-brain. With `serverOrigin` = `/watchparty`, both go to
watchparty (`room-wporigin`: every request above moved to `/watchparty/…`), and
the component is then simply watchparty's room running in a div on our page.

### 3.2 What that means

- **Coexistence is possible; composition is not.** Our root survived every
  run, so a second root on the page does not crash anything. But what renders
  in `#wp` is watchparty's product — its home page on our real URL, or its full
  room (starfield, chat sidebar, media/games/tierlist controls) on a
  `/room/<key>` path — and our draft cannot be put *inside* it.
- **To get the room at all we would hand it the path.** Our routes are hash
  routes under `/cardtable/` (`apps/ui/src/screens/route.ts`); their router
  only renders `Room` for `<basename>/room/<key>`. Two routers on one
  `window.history` is the thing D17's "we import their room UI, not a payload
  inside their router" excludes.
- **It leaks past `unmount()`.** Leaving a draft would leave a live socket in a
  watchparty room, a presence entry for the user, and every listener above.
- **It owns the page's auth.** A `public` user on a room path is sent to
  `/auth` by `shouldRedirectToAuth` (`src/lib/authGate.ts:30-53`, called at
  `entry-M6_mYpr5.js:6681`). The friend gate at our edge means a public user
  never reaches us, so this does not fire in production — but it is a
  whole-page navigation made by an imported component.
- **The socket joins watchparty's server, which only knows its own room keys.**
  Read from *watchparty's source* at `main` `bd564b0b`, not the tarball: a join
  whose `room_key` is not in the configured key map is rejected
  (`apps/server/src/ws/join.ts:63-68`), and the only way to add a key is
  `POST /api/rooms`, behind `serviceAuth`, which lists the room publicly
  (`public: true`) and counts it against `MAX_ROOMS`
  (`apps/server/src/http/routes/rooms.ts:109-147`). So `cardtable-<draftId>`
  would be refused at join today, even with everything else solved.

---

## 4. Spike B — the smallest consumer, built, through our own gate

This is the result that settles it. `host/main.js` (Appendix B) is the whole
app: import `mount`, call it on a div. Built with the same Vite major
`apps/ui` uses:

```sh
npm install vite@8.2.2                                         # exit 0
npx vite build host --outDir ../host-dist --emptyOutDir        # exit 0
bash scripts/d13-gate.sh <spike>/host-dist                     # exit 1
```

Output of the build (`host-dist/assets`, bytes):

```
 5850490 cover-Cz1zW-2X-Deo3hdR2.js
  485169 index-Bkh9B40o.js
  210706 Room-B93sVpM9-DG22q7wH.js
  144417 GameModule-U6t7Wu5n-CF_ynuhu.js
   43998 MapEditor-SyciQPqm-BfsLv0sb.js
    9229 PlaylistPanel-C6SOYvMP-BvgyyiPO.js
    7687 MediaDrawer-BD-fkNmG-rMbKe9cd.js
    4269 CharacterModal-BdnDbOF2-Cl9XFW_8.js
    3476 AdminPanel-V4Pnrnbr-DYiJbFUR.js
    1670 GameDrawer-lgdBwe4N-D6A6MGB0.js
                                         total 6,761,330 bytes for the directory
```

Our gate, verbatim (paths shortened):

```
::error::D13/D15 — 3 file(s) inline image bytes as a data: URI. That is still us serving the bytes.
  <spike>/host-dist/assets/cover-Cz1zW-2X-Deo3hdR2.js
  <spike>/host-dist/assets/GameModule-U6t7Wu5n-CF_ynuhu.js
  <spike>/host-dist/assets/MapEditor-SyciQPqm-BfsLv0sb.js
```

The same gate on the tarball's own `package/dist` exits **1** with the same
three chunks. Counting `data:image/` occurrences in the shipped chunks:
`cover` 1 (a single 5.85 MB base64 PNG), `GameModule` 7, `MapEditor` 26.

Why a one-line import drags them in: `mount` → `createWatchpartyRouter` →
`lazy(() => import('./routes/MapEditor'))` (`src/router.tsx:8`) and `App` →
`lazy(Room)` (`src/App.tsx:16`) → `lazy(GameModule)` / `lazy(GameDrawer)`
(`src/routes/Room.tsx:11-12`) → `cover` (the `import { b } from "./cover-…"` in
both). A bundler emits every dynamically imported chunk whether or not the
route is ever visited. **There is no import of this package that does not put
those bytes in `apps/ui/dist`**, and CI runs exactly this gate on exactly that
directory (`.github/workflows/ci.yml:145`).

So even a team willing to accept §3's side effects could not ship it: the
first CI run after `pnpm add @wolffm/watchparty-ui` goes red, correctly.

---

## 5. Conclusion, and the costed plan for when the request lands

**Room chrome cannot be used from `@wolffm/watchparty-ui@0.38.115` without
handing over our whole app — and not even then, because importing it breaks
the D13/D15 gate.** No working-integration spike is possible; this lane files
the request instead: `docs/requests/WATCHPARTY_ROOM_CHROME.md`.

If watchparty ships what that request names (a `RoomChrome` component on its
own subpath entry, plus a way to join an unprovisioned `cardtable-*` room),
adopting it costs roughly **one lane**. The files it would touch — none of
which this lane owns, so none were touched:

| file | change | est. |
| --- | --- | --- |
| `apps/ui/package.json`, `pnpm-lock.yaml` | add `@wolffm/watchparty-ui@^0.39.0` | 1 line + lock |
| `apps/ui/src/main.tsx` | import the chrome's scoped stylesheet | 1 line |
| `apps/ui/src/App.tsx` | wrap the `draft`, `deck` and `match` routes in `<RoomChrome roomKey=… serverOrigin="https://hadoku.me/watchparty" …>` | ~20 lines |
| `apps/ui/src/screens/route.ts` | one pure `roomKeyFor(route)` → `cardtable-<draftId>` / `cardtable-<matchId>`, unit-tested with the others | ~15 lines + tests |
| `apps/ui/src/screens/PodScreen.tsx`, `MatchScreen.tsx` | nothing, if the chrome is a wrapper — that is the point of the seam | 0 |
| `apps/server/src/http/**` | **nothing** if watchparty accepts unprovisioned `cardtable-*` keys (request §3, option 1). If they instead require `POST /api/rooms` (option 2), one route that provisions a key with a service credential from the vault broker, plus a secret-distribution request to hadoku_site in the shape of `HADOKU_SITE_SECRET_DISTRIBUTION.md` | 0, or ~80 lines + a cross-repo ask |
| `e2e/**` | one spec: chat panel present around a live draft; our seat bar still ours | ~60 lines |
| `scripts/d13-gate.sh` | **nothing** — the chrome must pass it unmodified; that is a requirement in the request, not something we loosen | 0 |
| `docs/DECISIONS.md` | D17's "known blocker" paragraph closes (tracker) | — |

**One question for the operator, not decided here.** The chrome renders
watchparty's character sprites as `<img>` from
`${serverOrigin}/media/sprites/square_<id>.png` (`src/lib/characters.ts:39-41`)
— i.e. from `hadoku.me/watchparty/…`, watchparty's server, on the same web
origin as ours. The gate checks *our* bundle for image URLs and bytes, and
these URLs are built at run time from a prop, so it would not see them; and
D15's surviving rule is written about *our app server*. Whether "our own
origin never serves an image" means the app server (fine) or the host
`hadoku.me` (not fine) is D15's to answer, and it is flagged in the request so
watchparty can offer a `cdn.hadoku.me` sprite base if the answer is the latter.

---

## 6. `packages/room-ask`

**This work gives it no consumer.** Room chrome is chat, roster and presence
over watchparty's socket; it never asks a seat a question and waits. The one
consumer `room-ask` was built for — correlating Forge's blocking prompts to a
seat's reply, with timeout and reconnect — shipped without it:
`apps/server/src/play/match.ts` keeps its own asks by `callId` (`:109-110`,
`:483`), re-sends them on reconnect (`:293`) and aborts them after a grace
(`:334-363`), and nothing in `apps/` or `packages/` other than `room-ask` itself
imports `@hadoku/room-ask` (grep over `*.ts`, `*.tsx`, `package.json`: only
its own files and two doc comments in `packages/forge-wire`). It was specified
as watchparty's P4 and licensed MIT so it could go upstream; the request offers
it to them (§6 there). Recommendation: hand it over, and delete it here if they
decline. No file under `packages/room-ask` or `packages/room-store` was
changed, so neither needs a version bump.

---

## Appendix A — `probe.mjs`

Run from a directory where `npm install <tarball> jsdom@26` succeeded. The raw
JSON of all four runs is summarised in §3.1; the room run's is reproduced in
Appendix C.

```js
// Probe: what does @wolffm/watchparty-ui@0.38.115's mount() do to a page it
// shares with a host app? Runs the PUBLISHED tarball's dist/ under jsdom.
//
// usage: node probe.mjs <url> [userType] [origin]
//   url       the page URL the host is at, e.g. https://hadoku.me/cardtable/#/draft/abc
//   userType  mount's userType prop (default: friend)
//   origin    mount's serverOrigin prop (default: https://hadoku.me/cardtable)
import { JSDOM } from 'jsdom';

const url = process.argv[2] ?? 'https://hadoku.me/cardtable/#/draft/abc';
const userType = process.argv[3] ?? 'friend';
const serverOrigin = process.argv[4] ?? 'https://hadoku.me/cardtable';

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="host"></div><div id="wp"></div></body></html>', {
  url,
  pretendToBeVisual: true,
});
const { window } = dom;

// ---- record every side effect the package could have -----------------------
const fetches = [];
window.fetch = globalThis.fetch = async (input, init) => {
  const u = typeof input === 'string' ? input : input.url ?? String(input);
  fetches.push({ url: u, method: init?.method ?? 'GET' });
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
window.navigator.sendBeacon = (u) => { fetches.push({ url: String(u), method: 'BEACON' }); return true; };

const sockets = [];
const socketCloses = [];
class RecordingWebSocket {
  constructor(u) { sockets.push(String(u)); this.url = String(u); this.readyState = 0; }
  send() {} close() { socketCloses.push(this.url); } addEventListener() {} removeEventListener() {}
}
RecordingWebSocket.CONNECTING = 0; RecordingWebSocket.OPEN = 1; RecordingWebSocket.CLOSING = 2; RecordingWebSocket.CLOSED = 3;
window.WebSocket = RecordingWebSocket;
window.XMLHttpRequest = class { open(m, u) { sockets.push(`XHR ${m} ${u}`); } send() {} setRequestHeader() {} abort() {} addEventListener() {} };

const navigations = [];
// jsdom's location.replace is unforgeable, so a full-page navigation is not
// trapped here: jsdom prints "Not implemented: navigation" to stderr instead,
// and that line is the record of it. History calls ARE trapped.
for (const m of ['pushState', 'replaceState']) {
  const orig = window.history[m].bind(window.history);
  window.history[m] = (s, t, u) => { navigations.push(`history.${m}(${u})`); return orig(s, t, u); };
}
const listeners = [];
const origAdd = window.addEventListener.bind(window);
window.addEventListener = (type, fn, opts) => { listeners.push(`window:${type}`); return origAdd(type, fn, opts); };
const docAdd = window.document.addEventListener.bind(window.document);
window.document.addEventListener = (type, fn, opts) => { listeners.push(`document:${type}`); return docAdd(type, fn, opts); };

// expose the DOM as globals the bundle expects
const keys = ['window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'HTMLElement', 'Element', 'Node', 'Image', 'CustomEvent', 'Event', 'MutationObserver', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'WebSocket', 'XMLHttpRequest', 'DOMParser',
  'HTMLCanvasElement', 'ResizeObserver', 'IntersectionObserver', 'self'];
for (const k of keys) {
  if (k === 'navigator') { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }); continue; }
  if (k === 'self') { globalThis.self = window; continue; }
  if (window[k] !== undefined) globalThis[k] = window[k];
}
window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = window.matchMedia;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = false;

const snapshotGlobals = () => new Set(Object.getOwnPropertyNames(window));
const htmlAttrs = () => Object.fromEntries([...window.document.documentElement.attributes].map((a) => [a.name, a.value]));
const lsKeys = () => Object.keys(window.localStorage).sort();
const ssKeys = () => Object.keys(window.sessionStorage).sort();

// ---- the host app: a React root of our own, rendered FIRST ------------------
const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const hostEl = window.document.getElementById('host');
createRoot(hostEl).render(React.createElement('main', { id: 'cardtable' }, 'our draft'));
await new Promise((r) => setTimeout(r, 50));

const before = { globals: snapshotGlobals(), html: htmlAttrs(), ls: lsKeys(), ss: ssKeys(), head: window.document.head.innerHTML, href: window.location.href };

// ---- the package, from the published dist -----------------------------------
const wp = await import('@wolffm/watchparty-ui');

const el = window.document.getElementById('wp');
let router, threw = null;
try {
  router = wp.mount(el, { basename: '/cardtable', serverOrigin, userType, userId: 'probe-user', sessionId: null });
} catch (e) { threw = e.stack ?? String(e); }
await new Promise((r) => setTimeout(r, 1500));

const after = { globals: snapshotGlobals(), html: htmlAttrs(), ls: lsKeys(), ss: ssKeys(), head: window.document.head.innerHTML, href: window.location.href };

const result = {
  url, userType, serverOrigin,
  threw,
  exports: Object.keys(wp).sort(),
  mountReturned: router ? Object.keys(router).sort() : null,
  routerLocation: router?.state?.location ?? null,
  routerMatches: router?.state?.matches?.map((m) => m.route.path) ?? null,
  htmlBefore: before.html, htmlAfter: after.html,
  globalsAdded: [...after.globals].filter((g) => !before.globals.has(g)),
  localStorageAdded: after.ls.filter((k) => !before.ls.includes(k)),
  sessionStorageAdded: after.ss.filter((k) => !before.ss.includes(k)),
  headAdded: after.head.replace(before.head, ''),
  hrefBefore: before.href, hrefAfter: after.href,
  navigations,
  listeners: [...new Set(listeners)].sort(),
  fetches,
  sockets,
  hostStillRendered: hostEl.innerHTML,
  wpRenderedText: el.textContent.slice(0, 200),
  wpRenderedHtmlHead: el.innerHTML.slice(0, 300),
  bodyChildren: [...window.document.body.children].map((c) => `${c.tagName.toLowerCase()}#${c.id}`),
};

wp.unmount(el);
await new Promise((r) => setTimeout(r, 100));
result.afterUnmount = {
  wpHtml: el.innerHTML,
  htmlAttrs: htmlAttrs(),
  socketGlobalStillThere: '__SOCKET__' in window,
  socketStillConnectedFlag: window.__SOCKET__ ? window.__SOCKET__.active : null,
  websocketCloseCalls: socketCloses.length,
  hostStillRendered: hostEl.innerHTML,
};

process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exit(0);
```

## Appendix B — the minimal host (`host/index.html`, `host/main.js`)

```html
<!doctype html>
<html><head><meta charset="utf-8"><title>host</title></head>
<body><div id="app"></div><div id="chrome"></div><script type="module" src="./main.js"></script></body></html>
```

```js
// The smallest possible consumer: import the one function we would call and
// call it on a div of our own. Nothing else from the package is referenced.
import { mount } from '@wolffm/watchparty-ui';
mount(document.getElementById('chrome'), { basename: '/cardtable', serverOrigin: 'https://hadoku.me/watchparty' });
```

## Appendix C — raw output of the `room` run

```json
{
  "url": "https://hadoku.me/cardtable/room/cardtable-abc",
  "userType": "friend",
  "serverOrigin": "https://hadoku.me/cardtable",
  "threw": null,
  "exports": [
    "createWatchpartyRouter",
    "mount",
    "unmount"
  ],
  "mountReturned": [
    "_internalFetchControllers",
    "_internalSetRoutes",
    "_internalSetStateDoNotUseOrYouWillBreakYourApp",
    "basename",
    "createHref",
    "deleteBlocker",
    "deleteFetcher",
    "dispose",
    "enableScrollRestoration",
    "encodeLocation",
    "fetch",
    "future",
    "getBlocker",
    "getFetcher",
    "initialize",
    "navigate",
    "patchRoutes",
    "resetFetcher",
    "revalidate",
    "routes",
    "state",
    "subscribe",
    "window"
  ],
  "routerLocation": {
    "pathname": "/cardtable/room/cardtable-abc",
    "search": "",
    "hash": "",
    "state": null,
    "key": "default"
  },
  "routerMatches": [
    "/room/:roomKey"
  ],
  "htmlBefore": {},
  "htmlAfter": {
    "data-theme-mode": "simple"
  },
  "globalsAdded": [
    "__reactRouterVersion",
    "__wpDebug",
    "__ZUSTAND_STORE__",
    "__DISPLAY_NAMES__",
    "__WP_PERF__",
    "__WP_SOUNDS__",
    "__SOCKET__"
  ],
  "localStorageAdded": [
    "hadoku_device_id",
    "prefs-cache:probe-user:portfolio",
    "prefs-cache:probe-user:watchparty",
    "watchparty_delivery_client_id"
  ],
  "sessionStorageAdded": [],
  "headAdded": "<link rel=\"preconnect\" href=\"https://hadoku.me/cardtable\" crossorigin=\"anonymous\">",
  "hrefBefore": "https://hadoku.me/cardtable/room/cardtable-abc",
  "hrefAfter": "https://hadoku.me/cardtable/room/cardtable-abc",
  "navigations": [
    "history.replaceState(undefined)"
  ],
  "listeners": [
    "document:click",
    "document:fullscreenchange",
    "document:keydown",
    "document:mouseout",
    "document:mouseover",
    "document:selectionchange",
    "document:touchend",
    "window:pagehide",
    "window:popstate",
    "window:storage",
    "window:test",
    "window:unhandledrejection",
    "window:watchparty:focus-chat-input",
    "window:watchparty:open-game-drawer",
    "window:watchparty:open-media-drawer"
  ],
  "fetches": [
    {
      "url": "https://hadoku.me/session/whoami",
      "method": "GET"
    },
    {
      "url": "https://hadoku.me/cardtable/media/sprites/names.json",
      "method": "GET"
    },
    {
      "url": "https://hadoku.me/cardtable/healthz",
      "method": "GET"
    },
    {
      "url": "https://hadoku.me/cardtable/api/flags",
      "method": "GET"
    },
    {
      "url": "https://hadoku.me/cardtable/api/tierlist",
      "method": "GET"
    },
    {
      "url": "https://hadoku.me/cardtable/api/rooms/validate/cardtable-abc",
      "method": "GET"
    },
    {
      "url": "https://hadoku.me/cardtable/api/client-log",
      "method": "POST"
    }
  ],
  "sockets": [
    "wss://hadoku.me:443/watchparty/ws/?EIO=4&transport=websocket"
  ],
  "hostStillRendered": "<main id=\"cardtable\">our draft</main>",
  "wpRenderedText": "0No messages yet. Be the first to say something!",
  "wpRenderedHtmlHead": "<div class=\"h-screen flex flex-col bg-bg\"><main class=\"flex-1 w-full overflow-hidden min-h-0 flex flex-col\"><div class=\"relative flex-1 flex overflow-hidden min-h-0\"><div class=\"flex-1 relative bg-black overflow-hidden min-w-0\"><canvas data-darkreader-ignore=\"true\" class=\"absolute inset-0 z-0 bg-bla",
  "bodyChildren": [
    "div#host",
    "div#wp"
  ],
  "afterUnmount": {
    "wpHtml": "",
    "htmlAttrs": {
      "data-theme-mode": "simple"
    },
    "socketGlobalStillThere": true,
    "socketStillConnectedFlag": true,
    "websocketCloseCalls": 0,
    "hostStillRendered": "<main id=\"cardtable\">our draft</main>"
  }
}
```
