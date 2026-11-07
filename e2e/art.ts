/**
 * Every card image a page asks for is the server's art route, `/api/art/<id>`, which redirects to
 * the art host (`apps/server/src/http/card-art.ts`). A test that blocks or stands in for card art
 * intercepts the route itself: Playwright does not route a redirect's follow-up request, so a
 * route on the art hosts no longer sees an image at all — the page would fetch the real one.
 */
export const ART_ROUTE = /\/api\/art\//;

/** Whether `url` is a card image request. */
export const isArtRequest = (url: string | URL): boolean => ART_ROUTE.test(new URL(url).pathname);
