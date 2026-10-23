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
 */

const FLYING = '[data-flying]';

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
  const flyers = new Set<Element>();
  const observer = new MutationObserver((records) => {
    flyers.clear();
    for (const r of records) {
      const at = r.target instanceof Element ? r.target : r.target.parentElement;
      const flyer = at?.closest(FLYING) ?? null;
      if (flyer !== null) flyers.add(flyer);
      for (const node of r.addedNodes) if (node instanceof Element) for (const f of [node, ...node.querySelectorAll(FLYING)]) if (f.matches(FLYING)) flyers.add(f);
    }
    for (const flyer of flyers) pin(flyer);
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-flying'] });
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
