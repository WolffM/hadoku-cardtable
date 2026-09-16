# Request to hadoku-watchparty: composable room chrome, and a packaging defect

**From:** hadoku-cardtable
**To:** hadoku-watchparty
**Date:** 2026-09-16
**Re:** `@wolffm/watchparty-ui` — exports, and the types that don't ship
**Status:** roadmap ask — **not a blocker.** We are building around it now.
**Delivered:** `hadoku-watchparty`, branch `w6-composable-room-chrome`,
commit `9b0b682a`, pushed 2026-09-16 with an upstream set. Their `main` is
untouched (`bd564b0b`) and no PR was opened. This file is our copy of what
was sent; the two are byte-identical apart from this line.

**Read against:** `@wolffm/watchparty-ui@0.38.115`, **read from the published
tarball**, not from your source tree. That distinction cost us a wave once and
we do not make it twice. Exact commands in §7.

---

## 0. The short version

We want your room chrome — chat, roster, presence, lobby — with our draft in the
middle of it. Today we cannot have it, for one specific and cheap-to-fix reason:
**the package exports a whole-app `mount()` and nothing smaller.**

Two asks, in order of how much they cost you:

| | Ask | Cost to you | Blocks us? |
| --- | --- | --- | --- |
| **§3** | **Ship the `.d.ts` files you already declare.** `package.json` says `types: "./dist/index.d.ts"`; the tarball contains **zero** `.d.ts` files. | a build flag | no — but it makes every TS consumer `any` |
| **§4** | **Export the room chrome as components, with a slot for foreign content.** | export statements — **the components are already in the tarball** | no — we are shipping our own meanwhile (§5) |

Neither is urgent. Both are things you would want anyway, and §3 is a defect
against your own manifest regardless of whether we are ever a consumer.

**What we are not asking for.** We are not asking to be embedded in watchparty,
and we are not moving there. Cardtable is its own app at `hadoku.me/cardtable/`
with its own server and its own gate. The ask is to **import** your room chrome
as a package, the way we already import `@wolffm/rooms-protocol`. That decision
is settled on our side; it is not up for renegotiation and nothing here depends
on you agreeing with it.

---

## 1. What we need, stated as a requirement

Our screen is a draft: a pack fanned for picking, a pool grouped by mana value,
pack/pick counters, a seat bar. It is 45 minutes long, it is eight people, and
the whole time it wants to be **a room** — people talking, a roster showing who
has picked, presence telling you who dropped.

That is your product, not ours. We do not want to rebuild it and we do not want
two divergent copies of it rotting in two repos. Same argument as
`WATCHPARTY_ROOM_MODULE.md` §0 made for the server layer, and you accepted it
there.

**The requirement, in one line:** we need the room chrome as components we can
render, with a region we fill ourselves.

```tsx
// what we want to be able to write
import { RoomShell, ChatPanel, Roster } from '@wolffm/watchparty-ui';

<RoomShell roomKey={key} serverOrigin={origin}>
  <DraftScreen … />        {/* ours, in the middle */}
</RoomShell>
```

We are not prescribing that API — you told us once already, correctly, to bring
the requirement and not the signature (`ROOM_MODULE_RESPONSE.md` §0), and we are
taking that instruction seriously. The requirement is **composition with a
slot**. Any shape that satisfies it works for us: a `children` slot, a named
render prop, a `slots={{ center: … }}` map. Your call.

What does **not** satisfy it is what ships today.

---

## 2. What ships today, from the tarball

`npm pack @wolffm/watchparty-ui@0.38.115` → **26 files, 9.8 MB packed, 14.9 MB
unpacked.**

The entry point is 246 bytes, and here it is in full:

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

**Three named exports. No default export. No `exports` map in `package.json`.**

De-minified from `dist/chunks/entry-M6_mYpr5.js`, that is:

```js
function mount(el, opts = {}) {
  const { basename, strictMode = false, ...a } = opts;
  // …serverOrigin, defaultRoomKey, cdnBase, userType, userId, sessionId…
  // creates a React root on `el`, stashes it at el.__watchparty
}

function unmount(el) {
  const t = el.__watchparty;
  t?.root.unmount(); t && delete el.__watchparty;
}

function createWatchpartyRouter({ basename = "/watchparty", appProps } = {}) {
  return [ { path: "/", element: <App {...appProps} /> },
           { path: "/editor", element: <Suspense …><MapEditor /></Suspense> },
           … ];
}
```

All three are the same thing at different granularities: **put the entire
watchparty application somewhere.** `mount` puts it in a DOM node,
`createWatchpartyRouter` hands you routes for it — and defaults `basename` to
`/watchparty`, which is the tell. This is an API built for hadoku_site to mount
watchparty at a path. It is a perfectly good API **for that consumer**. It just
has no seam for a second app that wants the chrome and not the product.

There is no room shell, no roster, no chat panel and no canvas slot in the
public surface. Not "hard to reach" — **not exported**.

### 2.1 The components exist. They are in the bytes we downloaded.

This is why we think the ask is cheap rather than a feature request.

`dist/chunks/Room-B93sVpM9.js` is 329.9 kB, and its sourcemap's `sources` array
names **71** of your own modules compiled into it. Among them, verbatim:

```
../../src/components/Roster.tsx
../../src/components/ChatPanel.tsx
../../src/components/ChatInput.tsx
../../src/components/ChatMessage.tsx
../../src/components/ChatAttachmentStrip.tsx
../../src/components/ChatImageAttachments.tsx
../../src/components/ChatImageLightbox.tsx
../../src/components/FloatingChat.tsx
../../src/components/DrawerShell.tsx
../../src/components/controls/ChatToggleButton.tsx
../../src/routes/Room.tsx
```

Every component we are asking for is **already compiled into the published
tarball**. We are already downloading them. We just cannot name them. The gap
between what ships and what we need is a set of `export` statements in
`src/index.ts`, not new code.

We know that a re-export is not free — it fixes a public API you then have to
keep. That is the real cost here and it is yours to weigh, not ours. Mark it
`0.x` and unstable, the way you did the rooms packages; we will take it on those
terms and we will not treat a break as a betrayal.

---

## 3. The packaging defect: `types` is declared and no types ship

This one is not about us. Any TypeScript consumer hits it.

From the packed `package.json`, verbatim fields:

```json
  "main":  "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"]
```

From the tarball's file list:

```
$ tar tzf wolffm-watchparty-ui-0.38.115.tgz | grep -c '\.d\.ts$'
0
```

**`dist/index.d.ts` does not exist.** `files: ["dist"]` would have included it;
it was never built. So `types` points at a file that is not there, and every
TypeScript consumer of this package gets `any` for the whole surface — silently,
because a missing `types` target does not error, it just resolves to nothing.

Three things make this worth a few minutes of yours:

1. **Your own sibling package gets it right.** `@wolffm/rooms-protocol@0.38.115`
   — same repo, same version, same release train — ships **14 files including 4
   `.d.ts`**, and a proper conditional export map:
   ```json
   "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }
   ```
   We consume that package and its types are good. `watchparty-ui` is the
   outlier, which reads like an oversight rather than a decision.

2. **`watchparty-ui` has no `exports` field at all.** Node falls back to `main`,
   which works, but it also means nothing is encapsulated: a determined consumer
   could deep-import `dist/chunks/Room-B93sVpM9.js`. We are not going to do that
   — that filename has a content hash in it and changes every build — but you
   probably want the export map anyway, if only to make the boundary you intend
   the boundary that exists.

3. **The README documents an API that does not ship.** This is the part we would
   most want to know if it were our package. `README.md`, in the tarball, §Usage:

   ```tsx
   import { WatchPartyProvider, WatchPartyRoom } from '@wolffm/watchparty-ui';
   import '@wolffm/watchparty-ui/dist/style.css';
   ```

   Neither identifier appears anywhere in the shipped JavaScript — we grepped
   every `dist/**/*.js` in the tarball for both and got no match. And the CSS
   file is `dist/watchparty-ui.css`; there is no `dist/style.css`. **Every line
   of the README's usage example fails against the package it ships inside.**

   Read charitably, that README describes the composable API we are asking for
   in §4 — as though it once existed, or was planned, and the build moved to a
   whole-app mount without the docs following. If that is what happened, then
   §4 is less "please build this" and more "please finish this", which would be
   good news for both of us. If we have that history wrong, ignore the
   speculation; the three factual claims above stand on their own.

**What we are asking for in this section is narrow:** emit the declarations
(`tsc --emitDeclarationOnly`, or `vite-plugin-dts`, whichever fits your build),
and either fix the README's usage block or point it at `mount`. Nothing about §4
has to be decided first.

---

## 4. The composable ask, concretely

If and when you want to do this, here is the smallest version that unblocks us.
Three exports:

| Export | What it is | Why we need it |
| --- | --- | --- |
| **A room shell with a slot** | the frame — drawers, layout, theme, the socket connection and room join — with a `children` region where the product content goes | this is the whole ask; everything else is optional |
| **`Roster`** | who is here, presence state | we need to show eight drafters; we have seat ids from `rooms-protocol` already |
| **`ChatPanel`** / **`FloatingChat`** | chat | a 45-minute draft without chat is a spreadsheet |

Four constraints, all of which come from our side being a different app:

1. **The socket origin must be a prop, not a build constant.** We connect to
   `hadoku.me/cardtable/`, not `/watchparty/ws`. `mount` already takes
   `serverOrigin`, so this exists; it just needs to survive the decomposition.

2. **No `basename: "/watchparty"` default on a component.** Fine on the router
   factory, wrong on a shell we render inside our own route tree.

3. **Theme must not be forced.** Your README describes a permanent dark-theme
   lock — `data-theme="dark"` on `<html>`, plus `data-darkreader-skip`. That is
   the right call for an app that owns the page. A component rendered inside
   *our* page must not write to `<html>`. Whatever `mount` does to the document,
   the composable path should not.

4. **`@wolffm/rooms-protocol` needs a range, not an exact pin.**
   `watchparty-ui@0.38.115` depends on `"@wolffm/rooms-protocol": "0.38.115"`,
   exactly. We pin `0.38.111`, exactly, in six manifests (`apps/ui`,
   `apps/server`, `packages/shared`, `packages/draft`, `packages/room-ask`,
   `packages/room-store`). Two exact pins that disagree means two copies of
   `rooms-protocol` in one install — and a `SeatId` from one is not a `SeatId`
   from the other as far as `instanceof` or a `zod` schema identity is
   concerned. Your `ROOM_MODULE_RESPONSE.md` §4 already told us *"pin a caret
   range; one version means one compatible set"* — that advice applied to
   `watchparty-ui`'s own dependency would fix this. **Our pin is ours to move
   and we will move it**; we raise it only because a caret on your side makes
   the problem go away for every consumer instead of one.

---

## 5. What we are doing meanwhile — so this blocks nothing

**We are building our own room shell, now, behind a seam.** It is in flight as
this document is written.

We are not waiting on you and you should not read any urgency into this
document. Specifically:

- Our shell renders our draft with our own chrome. It is deliberately plain.
- It sits behind a **seam**: the draft screen does not know what is around it,
  and the shell is swapped by changing what wraps it, not by touching the draft.
  This is the same interchangeability we already spent once and it worked — our
  draft screen renders identically from fixtures, from an in-process engine, and
  from a live socket, and adding the third source **did not change its props**.
- So if §4 ever lands, adopting it is replacing our shell component with yours
  at one seam. Not a migration. If §4 never lands, we keep ours and nothing was
  wasted.

We are telling you this so that you can schedule §3 and §4 **whenever they suit
you**, including never, without wondering whether someone is stuck. Nobody is
stuck.

---

## 6. What is in it for watchparty

Briefly, because you have heard this argument from us before and it turned out
to be true the first time.

- **§3 is a bug fix with no design content.** Your manifest makes a promise the
  tarball does not keep, and your README documents an API that does not exist.
  Both are cheap, both are yours regardless of us.
- **A second consumer is what proves a boundary is real.** Your own
  `ROOM_MODULE_RESPONSE.md` §6 closed on exactly this point about `TApp`: *"A
  second consumer is the only thing that proves the `TApp` boundary is real
  rather than aspirational."* The room *server* layer got that second consumer
  and it found real defects — the single `socketId` in `ClientMeta`, the `SKIP`
  sentinel with nothing to pass it to. The room *UI* layer has never had one.
- **`mount()` is a one-consumer API.** It exists because hadoku_site mounts
  watchparty at `/watchparty/`. That is a fine reason and we are not calling it
  wrong. But a package whose surface fits exactly one caller is a package that
  has not been asked a second question yet, and the decomposition tends to
  improve the original — the same way splitting `RoomState` did.

---

## 7. How we read this — exact commands and raw output

Every claim above comes from the published tarball. We did **not** read your
source tree for this document, on purpose: our own working note from the last
round says *"check the published artifact, not the source tree — the watchparty
UI package's whole surface is three functions and no types; reading their repo
would have suggested otherwise."*

```sh
export NODE_AUTH_TOKEN=$(gh auth token)

npm view @wolffm/watchparty-ui version
# 0.38.115                                    (exit 0 — this is the latest published)

npm pack @wolffm/watchparty-ui@0.38.115
# total files: 26 · package size 9.8 MB · unpacked 14.9 MB
# shasum 345cd645d8c5e6873c60e375bcc7688c6e08b14a

tar tzf wolffm-watchparty-ui-0.38.115.tgz | wc -l
# 26

tar tzf wolffm-watchparty-ui-0.38.115.tgz | grep -c '\.d\.ts$'
# 0                                           (grep exit 1 — no matches)

find package -name '*.d.ts' | wc -l
# 0

cat package/dist/index.js
# (246 bytes, quoted in full in §2 — 3 named exports, no default)

node -e 'const p=require("./package/package.json");
         console.log(p.main, p.types, JSON.stringify(p.exports))'
# ./dist/index.js  ./dist/index.d.ts  undefined

grep -rlF WatchPartyProvider package/dist --include='*.js'   # exit 1, no match
grep -rlF WatchPartyRoom     package/dist --include='*.js'   # exit 1, no match
find package/dist -name '*.css'
# package/dist/watchparty-ui.css              (there is no dist/style.css)

# the contrast — same version, same repo, different package:
npm pack @wolffm/rooms-protocol@0.38.115
tar tzf wolffm-rooms-protocol-0.38.115.tgz | wc -l          # 14
tar tzf wolffm-rooms-protocol-0.38.115.tgz | grep -c '\.d\.ts$'  # 4
```

The full tarball file list, all 26 entries:

```
package/package.json
package/README.md
package/LICENSE
package/dist/index.js
package/dist/index.js.map
package/dist/watchparty-ui.css
package/dist/chunks/AdminPanel-V4Pnrnbr.js        (+ .map)
package/dist/chunks/CharacterModal-BdnDbOF2.js    (+ .map)
package/dist/chunks/cover-Cz1zW-2X.js             (+ .map)   5.9 MB
package/dist/chunks/entry-M6_mYpr5.js             (+ .map)   209.2 kB
package/dist/chunks/GameDrawer-lgdBwe4N.js        (+ .map)
package/dist/chunks/GameModule-U6t7Wu5n.js        (+ .map)   172.6 kB
package/dist/chunks/MapEditor-SyciQPqm.js         (+ .map)
package/dist/chunks/MediaDrawer-BD-fkNmG.js       (+ .map)
package/dist/chunks/PlaylistPanel-C6SOYvMP.js     (+ .map)
package/dist/chunks/Room-B93sVpM9.js              (+ .map)   329.9 kB
```

The component list in §2.1 is the `sources` array of
`package/dist/chunks/Room-B93sVpM9.js.map`, filtered to your own `src/` modules
(71 of them) and then to names matching room chrome. It is evidence that those
modules were compiled into the chunk, which is what "already in the tarball"
means here — not that they are individually loadable.

**One thing we did not verify.** We did not try to *use* a deep import of
`dist/chunks/Room-B93sVpM9.js` to see whether a chrome component can be coaxed
out of it. We did not try because we would not ship it either way — the filename
carries a build hash. If anyone wants it settled, the command is an `import()`
of that path against a React 19 root; we do not recommend spending the time.

---

## 8. Summary

- **Nothing here blocks us.** We are building our own shell behind a seam that
  your exports can replace later without moving. Schedule this at your
  convenience.
- **§3 is a real defect** — `types` declared, zero `.d.ts` shipped, README
  documenting absent identifiers — and it is cheap, and it is independent of
  everything else in this document.
- **§4 is a roadmap ask.** The components already ship in the tarball; the gap
  is the export list. If you would rather keep the surface at `mount()`, say so
  and we will stop asking; we would rather have a clear no than an open ask
  neither side is tracking.
- **Cardtable stays its own app.** The ask is to import, never to embed.
