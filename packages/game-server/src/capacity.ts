/**
 * Cardtable's binding of the kernel's capacity sampler: a card image request (`http/card-art.ts`)
 * is a redirect to the art host, one per card a page draws, so it is counted on its own as
 * `artRedirects`, never timed nor logged a line each. `index.ts` hands it to `createGameServer`.
 */
export const ART_REDIRECTS = { path: (path: string): boolean => path.startsWith('/api/art/'), field: 'artRedirects' };
