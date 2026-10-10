/*
 * The three DOM questions whose answer changes when the app is not the page.
 *
 * Standalone, cardtable owns its document. Embedded in a watchparty room
 * (D21, `embed/`), it renders inside a SHADOW ROOT on someone else's page, and
 * the shadow boundary changes three things this app used to take for granted:
 *
 * 1. **An event seen at `window` or `document` is retargeted.** Its `target`
 *    (and `relatedTarget`) is the shadow HOST, not the card under the pointer,
 *    so every `target.closest('[data-board-card]')` in a window-level drag
 *    handler answers null. `eventTarget` reads the real one off the composed
 *    path. Standalone, the path's first entry IS `event.target`.
 * 2. **`document.querySelector` cannot see inside the shadow tree.** A lookup
 *    with no element at hand to start from asks `documentScope()` instead —
 *    the shadow root when embedded, the document otherwise.
 * 3. **`document.elementFromPoint` stops at the host.** `hitAt` asks the scope,
 *    which on a `ShadowRoot` answers with the element inside it.
 *
 * A function that already holds an element inside the app should prefer
 * `scopeOf(el)` — it is the same answer and needs no registration.
 */

let registered: Document | ShadowRoot | null = null;

/** The embed registers its shadow root for the life of a mount; the returned function unregisters it. */
export function setDocumentScope(root: ShadowRoot): () => void {
  registered = root;
  return () => {
    if (registered === root) registered = null;
  };
}

/** Where the app's own elements live: the embed's shadow root, or the document. */
export function documentScope(): Document | ShadowRoot {
  return registered ?? document;
}

/** The document or shadow root `node` is in. */
export function scopeOf(node: Node): Document | ShadowRoot {
  const root = node.getRootNode();
  return root instanceof ShadowRoot || root instanceof Document ? root : document;
}

/**
 * The element the event actually happened on, through any shadow boundary.
 *
 * `composedPath()` is empty once dispatch has finished, and absent on a plain
 * object a test hands a handler, so `target` is the fallback in both cases.
 */
export function eventTarget(event: Event): EventTarget | null {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  return path[0] ?? event.target;
}

/** `elementFromPoint`, inside the app's own tree. Null where the environment has no layout (jsdom). */
export function hitAt(scope: Document | ShadowRoot, x: number, y: number): Element | null {
  return typeof scope.elementFromPoint === 'function' ? scope.elementFromPoint(x, y) : null;
}
