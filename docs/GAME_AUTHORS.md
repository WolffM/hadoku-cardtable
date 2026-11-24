# Writing a game for cardtable rooms

For anyone building a game that runs inside a [cardtable](https://hadoku.me/cardtable/) room. You
write the game; cardtable seats the players, passes messages between them and shows the result.
You never run a server, and you ship a new build yourself by pushing a git tag.

The operator handles the rest (the route, the key, cardtable's entry for your game) on their side.
Nothing in this page needs access to anything private.

## What you build

One **ES module** that exports `mount(el, ctx)`. A cardtable room `import()`s it, hands it an empty
element and a context, and your game draws itself into that element. Everything else it needs (more
JavaScript, CSS, images, audio, `.wasm`) ships beside it and is loaded by relative URL.

The types are published on npm as `@hadoku/rooms-protocol` (`dist/game-bundle.d.ts`):

```sh
npm install --save-dev @hadoku/rooms-protocol
```

```ts
import type { GameBundleModule } from '@hadoku/rooms-protocol';

export const mount: GameBundleModule['mount'] = (el, ctx) => {
  const root = el.attachShadow({ mode: 'open' });
  // ... draw the game into root, wire ctx.channel ...
  return {
    update(next) {
      /* theme, identity or leadership changed */
    },
    unmount() {
      /* stop loops, remove listeners, clear root */
    },
  };
};
```

### What the context gives you

| Field             | What it is                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `ctx.roomKey`     | The room's id, the same for every player.                                                             |
| `ctx.identity`    | Who is looking: `userId`, `name` (may be null).                                                       |
| `ctx.isLeader`    | Whether this player leads the room. The leader is the one who ends the match.                         |
| `ctx.match.seat`  | This player's seat number, or `null` for a watcher.                                                   |
| `ctx.match.seats` | Every seat in order: `{ seat, userId, name }`. `userId` is null for an empty seat.                    |
| `ctx.channel`     | `send(msg)`, `on(handler)` (returns an unsubscribe), `close()`: messages to and from the other seats. |
| `ctx.theme`       | The site theme's name. The site's `--color-*` CSS custom properties reach your shadow root.           |
| `ctx.close()`     | Ask the room to close the game (for everyone when the leader asks).                                   |

`update(next)` is called with a new context when the theme, the viewer or the leadership changes.
Re-read `isLeader` there rather than caching it from `mount`.

### How messages travel

There is no game server. Each seat runs your code, and cardtable relays whatever one seat sends to
every other seat. Design for these rules:

- **Never back to the sender.** A seat does not hear its own `send`. Apply your own move locally.
- **In order, at most once.** One seat's messages arrive in the order they were sent, but a dropped
  connection loses what was in flight, and nothing is retried. If a message must arrive, add your
  own acknowledgement and resend.
- **Plain JSON.** Send objects that survive `JSON.stringify`.
- **Watchers listen only.** A watcher (`seat === null`) receives every message; its `send` does
  nothing.
- **One seat decides.** Seats can disagree after a drop. The simplest sound design: the leader runs
  the authoritative state and broadcasts it, and the others send only their inputs.
- **A seat can come back.** A player whose connection drops keeps their seat for a hold period
  (two minutes is typical). After a reload they return into a fresh `mount` with no game state, so
  have the leader send a full snapshot when a seat says it has (re)joined.

### Ending a match

The match ends when the **leader** sends:

```js
ctx.channel.send({ t: 'over', winners: [0] }); // the seat numbers that won
```

`winners` is an array of seat numbers: one seat for a single winner, several for a shared win, all
of them for a draw. Every other seat lost. cardtable shows the result in the room and records it to
the site's game stats from this same message, under your game's id: each seated player by their own
account, placement 1 for a winner and 2 for everyone else. A match with fewer than two seated
players is not recorded. Nothing more is needed from you. An `over` from any seat but the leader's is dropped, not relayed.
Do not use `t: 'over'` for anything else.

## What the page around you allows

- **Everything from your own folder.** The site's Content Security Policy only lets scripts, styles,
  fonts, audio and network requests come from hadoku.me itself. Bundle your fonts and assets; do not
  load anything from a CDN or call another host. `data:` and `blob:` images are fine, and
  WebAssembly works.
- **Relative URLs only.** Your files are served under `/games/<id>/`; resolve assets with
  `new URL('./sprite.png', import.meta.url)` or your bundler's equivalent, never an absolute path.
- **Styles inside your shadow root.** The room's styles do not reach your shadow root, and yours do
  not leak out. Put your CSS in a `<style>` in the root (with Vite: `import css from
'./game.css?inline'`).
- **File types.** `.js`, `.mjs`, `.css`, `.html`, `.json`, `.wasm`, `.png`, `.jpg`, `.webp`,
  `.gif`, `.svg`, `.wav`, `.mp3`, `.ogg`, `.mp4`, `.webm`, `.woff2`, `.woff`, `.ttf` and `.otf` are
  served with their real types; anything else is served as
  `application/octet-stream`, which a browser will not run, render or play. Ask for a type you need.
- Do not ship a top-level `lab/` or `telemetry/` folder; those paths are taken.
- Only the operator's friends can load your files or join your rooms. Anyone else is refused before
  a byte is sent.

## Building it

Any bundler that emits an ES module works. With Vite, a library build:

```js
// vite.config.js
export default {
  build: {
    outDir: 'dist',
    lib: { entry: 'src/embed.ts', formats: ['es'], fileName: () => 'embed.js' },
  },
};
```

`dist/` is exactly what gets served: `dist/embed.js` becomes `/games/<id>/embed.js`.

## Testing two seats locally

Save this as `harness.html` next to `dist/`, serve the folder (`npx serve .` or
`python3 -m http.server`) and open it. It mounts your game twice, as the leader in seat 0 and a
player in seat 1, joined by an in-memory relay that follows the rules above. The console prints the
winners when the leader ends the match.

```html
<!doctype html>
<meta charset="utf-8" />
<title>Two-seat harness</title>
<style>
  body {
    display: flex;
    gap: 16px;
    margin: 16px;
    font: 14px system-ui;
  }
  section {
    flex: 1;
    border: 1px solid #888;
    padding: 8px;
  }
</style>
<section>
  <h3>Seat 0 (leader)</h3>
  <div id="seat0"></div>
</section>
<section>
  <h3>Seat 1</h3>
  <div id="seat1"></div>
</section>
<script type="module">
  // Your built entry, relative to this page.
  const game = await import('./dist/embed.js');

  // One in-memory relay: a message goes to every OTHER seat, never back to its sender,
  // the way cardtable's relay delivers it.
  const handlers = [new Set(), new Set()];
  const channelFor = (seat) => ({
    send: (msg) => {
      const copy = JSON.parse(JSON.stringify(msg));
      handlers.forEach((hs, other) => {
        if (other !== seat) setTimeout(() => hs.forEach((h) => h(copy)));
      });
      if (msg && msg.t === 'over')
        console.log('match over, winners:', msg.winners);
    },
    on: (h) => (handlers[seat].add(h), () => handlers[seat].delete(h)),
    close: () => handlers.forEach((hs) => hs.clear()),
  });

  const seats = [
    { seat: 0, userId: 'u-alice', name: 'Alice' },
    { seat: 1, userId: 'u-bob', name: 'Bob' },
  ];
  for (const s of seats) {
    await game.mount(document.getElementById(`seat${s.seat}`), {
      roomKey: 'r-local-test',
      identity: { userId: s.userId, userType: 'friend', name: s.name },
      theme: 'default',
      isLeader: s.seat === 0,
      close: () => console.log(`seat ${s.seat} asked to close`),
      match: { id: 'r-local-test', seat: s.seat, seats },
      channel: channelFor(s.seat),
    });
  }
</script>
```

A complete, minimal game to compare against is cardtable's own test bundle,
[`e2e/fixtures/relay-bundle/relay-test-embed.fixture.js`](../e2e/fixtures/relay-bundle/relay-test-embed.fixture.js):
it sends a message, shows what it receives and ends the match.

## Before your first release: tell the operator

1. **An id** for the game: lowercase letters, digits and `-`, starting with a letter, at most 32
   characters (`^[a-z][a-z0-9-]{0,31}$`). It becomes the room type, the URL `/games/<id>/` and the
   stats name, so pick one you will keep.
2. **A label** for the create-room form, and the **seat range** (minimum and maximum players).
3. **The entry file's name** inside `dist/` (`embed.js` above).
4. **Where the repo lives**, one of:
   - a repo on the operator's GitHub account with you as a collaborator (private is fine, and the
     publishing key is set up on the repo for you), or
   - a **public** repo on your own account. The operator then hands you a key once, which you save
     as a repository secret, or
   - a **private** repo on your own account. As above, plus a read-only token you make for it: a
     fine-grained token on your account with access to that one repository and only **Contents:
     Read-only** (Metadata is added for you). The operator sends you a link that fills in the form.
     The site reads your releases with it, nothing else; renew it before it expires.

The operator sets up the route and the key (a few minutes) and tells you the secret's name,
`KEY_SERVICE_<ID>`: your id upper-cased, with `-` turned into `_`.

## Publishing a build

A build is a GitHub **release** of your repo with one asset, `game-bundle.tar.gz`, whose top level
is the contents of `dist/`. One workflow, `release.yml` in your repo's `.github/workflows`, makes
the release and tells the site:

```yaml
name: release
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  release:
    # On the operator's account this is ${{ fromJSON(vars.CI_RUNNER) }}; on your own, your runner.
    runs-on: ${{ fromJSON(vars.CI_RUNNER) }}
    steps:
      - uses: actions/checkout@v6
      - run: npm ci && npm run build
      - run: tar -czf game-bundle.tar.gz -C dist .
      - env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" game-bundle.tar.gz --latest --title "$GITHUB_REF_NAME"
      - uses: WolffM/hadoku-actions/repo-action@v1
        with:
          verb: notify
          body: '{"event_type":"game_bundle_updated","client_payload":{}}'
          service-key: ${{ secrets.KEY_SERVICE_<ID> }}
```

Then, for every build:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

A few minutes later `https://hadoku.me/games/<id>/embed.js` serves it, and the next room that
opens loads it. The site switches to a release only once all its files are uploaded, so a player
never gets half a build. Every release is kept: if one is broken, ask the operator to switch back to
an earlier tag, or tag a fixed one.

## Checklist

- [ ] `dist/embed.js` exports `mount(el, ctx)` and returns `{ update, unmount }`.
- [ ] It draws inside a shadow root and loads every asset by relative URL from its own folder.
- [ ] It works in the two-seat harness, including a seat reloading mid-game.
- [ ] Only the leader sends `{ t: 'over', winners }`, once, at the end.
- [ ] The operator has the id, label, seat range, entry name and repo.
- [ ] `release.yml` is in the repo and the key secret is saved.
