/**
 * One clock for a flyer's every part (`card.css`'s flying loop). Each part — the art, each overlay, the
 * protection layer, the shadow — runs its own `fly-*` animations, which the compositor can move; a CSS
 * animation's clock starts when its element is drawn, so a pill mounted mid-loop would have bobbed
 * apart from the art it sits on. Every `fly-*` animation is started at the document's own origin
 * instead: each then runs at the same point of its loop as its card's art, wherever in the loop it was
 * mounted, and only `--fly-phase` (its delay) sets one card apart from another.
 *
 * Before the frame that would first draw it: a flying card, a part added to one, or a card that starts
 * flying is pinned as the DOM changes (a mutation's callback runs before the page is drawn again).
 * Pinned at `animationstart` instead, each was drawn one frame at its own start and then jumped 4–7 px
 * into step — `e2e/fly-jump.spec.ts`'s Firefox run caught it, 90 ms after every flyer was drawn.
 * `animationstart` is kept for whatever starts without a DOM change.
 *
 * Wave 76 §C (AF405): the attacking outline's `::before` ring (`card.css`'s `[data-flying]
 * [data-attacking] > .board-card__face::before`) starts its OWN fresh `fly-*` animation the moment
 * `data-attacking` is set on a card already flying — no new node, so `FLYING_PART`'s `addedNodes`
 * watch never sees it, and without `data-attacking` in `attributeFilter` the observer's own
 * attribute branch did not either (`animationstart` would still catch it, a frame later — the same
 * gap the module header already names as worth closing). Watching `data-attacking` too pins it in
 * the SAME pass as everything else, before the first frame it is drawn in.
 */

const FLYING = '[data-flying]';

/**
 * Where a node added to a flyer can start a `fly-*` animation: as a part the `<li>` lays out, or as the
 * face (its art, protection layer and shadow) or a part of it. Anything deeper — a pill's text, a
 * counter's digits — runs none, and pinning on it would read every animation of the card again
 * (`getAnimations` brings the page's style up to date first) for every change inside an attacking
 * flyer (`docs/spikes/browser-fps.md`).
 */
const FLYING_PART = ':is([data-flying], [data-flying] > .board-card__face) > *';

/** Start every `fly-*` animation of `el` and everything in it at the document's origin. */
function pin(el: Element): void {
  if (typeof el.getAnimations !== 'function') return;
  // `subtree` includes the element's own pseudo-elements: the shadow is the face's `::after`.
  for (const animation of el.getAnimations({ subtree: true })) {
    const name = (animation as Animation & { animationName?: string }).animationName;
    if (name?.startsWith('fly-') === true && animation.startTime !== 0) animation.startTime = 0;
  }
}

/** Keep every flyer in `root` on the document's clock from the frame it is first drawn. Returns the uninstall. */
export function pinFlight(root: HTMLElement): () => void {
  const observer = new MutationObserver((records) => {
    const pinned = new Set<Element>();
    for (const r of records) {
      // A card that starts flying: all of it.
      if (r.type === 'attributes') {
        if (r.target instanceof Element && r.target.matches(FLYING)) pinned.add(r.target);
        continue;
      }
      for (const node of r.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(FLYING) || node.matches(FLYING_PART)) pinned.add(node);
        for (const f of node.querySelectorAll(FLYING)) pinned.add(f);
      }
    }
    for (const el of pinned) pin(el);
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-flying', 'data-attacking'] });
  // Whatever already flies as this is installed (a layout effect, before the board is first drawn).
  for (const flyer of root.querySelectorAll(FLYING)) pin(flyer);
  const onStart = (event: AnimationEvent): void => {
    if (event.animationName.startsWith('fly-') && event.target instanceof Element) pin(event.target);
  };
  root.addEventListener('animationstart', onStart);
  return () => {
    observer.disconnect();
    root.removeEventListener('animationstart', onStart);
  };
}
