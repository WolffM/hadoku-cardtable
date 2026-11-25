# Writing a game for cardtable rooms

For anyone building a game that runs inside a [cardtable](https://hadoku.me/cardtable/) room. You
write the game; cardtable seats the players, passes messages between them and shows the result.
You never run a server, and you ship a new build yourself by pushing a git tag.

The operator handles the rest (the route, your service grant, cardtable's entry for your game) on their side.
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
of them for a draw. Every other seat lost. An empty list, or one that names only seats nobody sits
in (your own bots, say), is a draw too: every seated player gets placement 1. cardtable shows the result in the room and records it to
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

## Describing your game: `manifest.json`

cardtable reads what it needs to know about your game from a `manifest.json` in the same folder as
your entry, so `dist/manifest.json`, served as `/games/<id>/manifest.json`:

```json
{
  "label": "Crossover Cards",
  "seats": { "min": 1, "max": 4 },
  "seatRejoinGraceMs": 120000
}
```

| Field               | What it is                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `label`             | Your game's name on the create-room form, 1 to 40 characters.                                                    |
| `seats.min`         | The fewest seated players a match starts with. `1` lets the leader play alone, against bots your bundle runs.   |
| `seats.max`         | The most seats a room of your game opens, at most 16.                                                            |
| `seatRejoinGraceMs` | Optional. How long a dropped player keeps their seat, in milliseconds, at most ten minutes. Default two minutes. |

These are yours to change: ship a new release with a different manifest and cardtable picks it up
within ten minutes, with no change on cardtable's side. A manifest cardtable cannot read (a missing
field, `min` above `max`) is ignored and the last good one stays in use, so check the server's
answer after a release that changes it. Whether your game is hosted, who may play it and where it
is served from are the operator's, and nothing in the manifest changes them.

With Vite, put it in `public/` (copied into `dist/` as is), or write it from your build script.

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
2. **The entry file's name** inside `dist/` (`embed.js` above). Your label and seat range go in
   [`manifest.json`](#describing-your-game-manifestjson), not to the operator.
3. **Where the repo lives.** Private on your own account is fine. You make the site a
   read-only token for it: a fine-grained token on your account with access to that one repository
   and only **Contents: Read-only** (Metadata is added for you). The site reads your releases with
   it and nothing else. A public repo needs no token.
4. **Your hadoku.me name** (the account you sign in with), so the operator can give you a
   **service grant** for the game. That grant is what lets you publish.

## Publishing a build

A build is a GitHub **release** of your repo with one asset, `game-bundle.tar.gz`, whose top level
is the contents of `dist/`. Publishing is two steps: your tag makes the release, and then you tell
the site it is there, from your own machine, with your own credential. Nothing of hadoku's is stored
in your repo.

### 1. The release: a workflow in your repo

`.github/workflows/release.yml`. It needs no secret beyond the `github.token` every workflow has:

```yaml
name: release
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: npm ci && npm run build
      - run: tar -czf game-bundle.tar.gz -C dist .
      - env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" game-bundle.tar.gz --latest --title "$GITHUB_REF_NAME"
```

### 2. Telling the site: your credential and one script

**Your credential.** From your repo's folder:

```sh
npx @hadoku/dev-vault login
```

It prints a code and a hadoku.me link. Open the link signed in to hadoku.me, set up an authenticator
app the first time (a QR code), then approve with your passkey and a code from the app. It writes
`.devvault.local.json` in the repo's folder. **Add that file to `.gitignore`**: it is your
credential. It lasts 7 days; run `login` again when it runs out.

**The script.** Save as `scripts/notify-hadoku.mjs`:

```js
// Tell hadoku.me that this repo's latest release is ready to serve.
import { readFileSync } from 'node:fs';

const file = new URL('../.devvault.local.json', import.meta.url);
const { key, expiresAt } = JSON.parse(readFileSync(file, 'utf8'));
if (!key) throw new Error('no credential: run `npx @hadoku/dev-vault login` first');
if (expiresAt !== undefined && expiresAt < Date.now()) {
  throw new Error('credential expired: run `npx @hadoku/dev-vault login` again');
}
const res = await fetch('https://hadoku.me/mgmt/api/repo/notify', {
  method: 'POST',
  headers: {
    'X-User-Key': key,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 game-release',
  },
  body: JSON.stringify({ event_type: 'game_bundle_updated', client_payload: {} }),
});
console.log(res.status, await res.text());
if (!res.ok) process.exit(1);
```

`200` with `"success":true` means the site is fetching your latest release.

### Every build

```sh
git tag v0.1.1 && git push origin v0.1.1
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
node scripts/notify-hadoku.mjs
```

Wait for the release workflow to finish before you notify: the site takes your **latest** release,
and one that does not exist yet is nothing to take. A few minutes after the notify,
`https://hadoku.me/games/<id>/embed.js` serves it and the next room that opens loads it. The site
switches to a release only once all its files are uploaded, so a player never gets half a build.
Every release is kept: if one is broken, ask the operator to switch back to an earlier tag, or tag
a fixed one.

## Checklist

- [ ] `dist/embed.js` exports `mount(el, ctx)` and returns `{ update, unmount }`.
- [ ] It draws inside a shadow root and loads every asset by relative URL from its own folder.
- [ ] It works in the two-seat harness, including a seat reloading mid-game.
- [ ] Only the leader sends `{ t: 'over', winners }`, once, at the end.
- [ ] `dist/manifest.json` names your label and seat range.
- [ ] The operator has the id, entry name, repo and your hadoku.me name.
- [ ] `release.yml` and `scripts/notify-hadoku.mjs` are in the repo, and `.devvault.local.json` is in
      `.gitignore`.
