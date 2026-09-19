# Handoff — give this to a Claude session in `hadoku-watchparty`

Open a session in the watchparty repo and paste the prompt below.

```sh
cd /home/hadoku/repos/hadoku-watchparty && claude
```

---

Read `/home/hadoku/repos/hadoku-cardtable/docs/requests/WATCHPARTY_ROOM_CHROME.md`
and implement it.

It asks for **one new export** — `RoomChrome`, on a subpath entry of its own —
that renders watchparty's chat, roster and presence around `children` and
connects to watchparty's own server, plus a way for a friend to join a room
keyed `cardtable-<id>` that nobody provisioned. §2 has the exact signature,
§2.2 the ten behavioural contracts C1–C10, §3 the server half, §2.3 the target
version (**0.39.0**).

Two of those contracts are bugs in `@wolffm/watchparty-ui` regardless of
cardtable, and are worth fixing on their own:

- **C9** — `package.json` sets `types: "./dist/index.d.ts"` and **that file is
  not in the published tarball**. Zero `.d.ts` ship, and there is no `exports`
  map. `@wolffm/rooms-protocol@0.38.115` — same release train — ships four
  `.d.ts` and an exports map, so this is an oversight in one package, not a
  house style.
- **C5** — `unmount()` only unmounts the React root (`entry.tsx:184-190`); the
  socket is still `active` afterwards with zero `close()` calls. That leaks for
  hadoku_site too, on any route change away from `/watchparty/`.

Also note, so it shapes the design rather than surprising you late: importing
the package at all currently pulls the `cover`, `GameModule` and `MapEditor`
chunks, which inline **34 `data:image/png` URIs** between them (one a single
5.85 MB PNG), because `mount` → router → `lazy(MapEditor)` and `App` →
`lazy(Room)` → `lazy(GameModule)` → `cover`. A bundler emits every dynamic
import. `RoomChrome` needs an entry that does not reach them.

§6 offers you **`@hadoku/room-ask`** — MIT, transport-free, 23 tests, built to
your own `P4_ASK_REGISTRY.md` §4. Take it or decline it explicitly; cardtable
has no consumer for it and will delete it if you decline.

Don't ask questions. Report what you shipped and the published version.
