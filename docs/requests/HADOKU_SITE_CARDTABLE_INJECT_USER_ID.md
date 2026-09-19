# Request to hadoku_site: one flag — `injectUserId` on the cardtable mount

**Small, isolated, and the fix for something the operator has now reported
twice.** cardtable renders `anon` where a person's name should be.

## The cause, exactly

`workers/edge-router/src/index.ts:1556-1566` — cardtable's proxy sets
`injectSessionKey: true` and **not** `injectUserId: true`:

```js
const cardtableProxy = (c: Context<AppContext>) =>
  proxyRequest(c, {
    baseUrl: c.env.CARDTABLE_BASE,
    backendSource: 'cardtable-tunnel',
    backendType: 'tunnel',
    timeout: 60000,
    stripPrefix: '/cardtable',
    injectSessionKey: true,
    …
  });
```

`X-User-Id` is stamped only inside `if (injectUserId)` (`proxy.ts:272-280`), so
cardtable's server never receives it. Its own `userIdOf()` falls back to the
string `anon`, and that lands in persisted room records as the member's display
name.

Live evidence from cardtable's server log, same request:

```
tier=admin  user=anon    ← tier survived, identity did not
```

Provenance is fine: `sanitizeHeaders` only strips `x-user-id` when it also pins
the tier to `public`, and the tier came through as `admin`. The header simply
was never sent.

Four other mounts already set the flag (`index.ts:304`, `:395`, `:666`, `:923`),
and `:651` describes it as *"what makes the worker able to identify anybody at
all"*, so this reads as an omission rather than a deliberate exclusion.

## What we are asking

Add `injectUserId: true` to the cardtable mount.

Nothing else. Tier gating is unchanged, `/cardtable/*` stays friend-floored, and
cardtable already re-checks the tier itself as a second seal.

## What we fixed on our side, so this is not urgent

cardtable now calls `whoami()` from `@wolffm/prefs-client` in the browser, which
goes to the edge directly and does return `name` — so the app's own chrome will
show the right name once deployed. That is also how watchparty's chat knew the
operator's name while our app beside it said `anon`.

What that does **not** fix is the server side: room membership records are
written from the request headers, so every member is stored as `anon` until the
flag is set. Rooms already persisted with `anon` will keep it until they are
re-created.

## Related, already with you

`docs/requests/HADOKU_SITE_GAME_TEMPLATE.md` — the template gap that left this
app without hadoku chrome at all. Same underlying story: nothing in the
hydration path handed a `tunnel-loopback-ui` app the fleet's front-end
conventions, and `injectUserId` is the server-side half of the same omission.
