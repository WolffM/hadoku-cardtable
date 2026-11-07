/**
 * Whether the viewer asked for less motion. Any game's board can read this
 * without caring where the question lives; cardtable's own `play/motion.ts`
 * re-exports it so none of its 20+ importers moved.
 */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
