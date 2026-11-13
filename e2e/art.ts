/**
 * Every card image a page asks for is the server's art route, `/api/art/<id>`, which redirects to
 * the art host (`games/magic/server/src/http/card-art.ts`). A test that blocks or stands in for card art
 * intercepts the route itself: Playwright does not route a redirect's follow-up request, so a
 * route on the art hosts no longer sees an image at all — the page would fetch the real one.
 */
export const ART_ROUTE = /\/api\/art\//;

/** Whether `url` is a card image request. */
export const isArtRequest = (url: string | URL): boolean => ART_ROUTE.test(new URL(url).pathname);

/**
 * Whether a blocked request is an image the product is meant to load: card art (the route), or
 * one of the app's own images on our CDN (the constructed modes' tiles, `modeArt.ts`). A page
 * that asks Scryfall directly is not: every card image goes through the route.
 */
export const isProductImage = (url: string | URL): boolean => isArtRequest(url) || new URL(url).hostname === 'cdn.hadoku.me';
