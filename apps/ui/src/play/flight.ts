/**
 * One clock for a flyer's every part (`card.css`'s flying loop). Each part — the art, each overlay, the
 * protection layer, the shadow — runs its own `fly-*` animations, which the compositor can move; a CSS
 * animation's clock starts when its element is drawn, so a pill mounted mid-loop would have bobbed
 * apart from the art it sits on. Every `fly-*` animation is started at the document's own origin
 * instead: each then runs at the same point of its loop as its card's art, wherever in the loop it was
 * mounted, and only `--fly-phase` (its delay) sets one card apart from another.
 */

/** Start every `fly-*` animation in `root` at the document's origin, as each begins. Returns the uninstall. */
export function pinFlight(root: HTMLElement): () => void {
  const onStart = (event: AnimationEvent): void => {
    if (!event.animationName.startsWith('fly-')) return;
    const target = event.target;
    if (!(target instanceof Element) || typeof target.getAnimations !== 'function') return;
    // `subtree` includes the element's own pseudo-elements: the shadow is the face's `::after`.
    for (const animation of target.getAnimations({ subtree: true })) {
      const name = (animation as Animation & { animationName?: string }).animationName;
      if (name?.startsWith('fly-') === true && animation.startTime !== 0) animation.startTime = 0;
    }
  };
  root.addEventListener('animationstart', onStart);
  return () => root.removeEventListener('animationstart', onStart);
}
