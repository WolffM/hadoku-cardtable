/*
 * `#/deck/<draftId>` — the deck built out of a draft's pool.
 *
 * The route exists because the routing scheme is fixed for the whole app and
 * splitting it across two waves is how two incompatible schemes get shipped.
 * The screen behind it does not exist yet: `@hadoku/deck` has the pool→deck
 * model and the Forge `.dck` writer, and wiring them to a draft's pool is
 * somebody's lane, not this one.
 *
 * So this says so, in those words, rather than rendering an empty deck builder.
 * Nothing in the product links here — the route is reachable only by typing it
 * — and swapping this component for the real one is a one-line change in
 * `App.tsx`'s switch.
 */

import { navigate } from './route.ts';

export function DeckScreen({ draftId }: { draftId: string }) {
  return (
    <div className="shell" data-testid="deck">
      <header className="shell__head">
        <h1 className="shell__title">Deck</h1>
        <p className="shell__sub">
          Pod <strong>{draftId}</strong>
        </p>
      </header>
      <main className="lobby">
        <section className="lobby__card">
          <h2>Not built yet</h2>
          <p className="lobby__note">
            Building a deck out of a drafted pool, and exporting it as a Forge{' '}
            <code>.dck</code>, is not wired to this route. The route is reserved so the
            link shape does not change when it is.
          </p>
          <button
            type="button"
            className="lobby__go"
            onClick={() => navigate({ kind: 'draft', draftId })}
          >
            Back to the pod
          </button>
        </section>
      </main>
    </div>
  );
}
