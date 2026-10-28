/*
 * `apps/ui/src/http.ts` and `apps/ui/src/draft/socket.ts` read
 * `import.meta.env?.BASE_URL`, which only exists under Vite's own types
 * (`vite/client`, apps/ui's own `tsconfig.json`). This program runs those
 * files under Node, where `import.meta.env` is simply `undefined` at
 * runtime — exactly what the optional chain already handles — so this is
 * only the type-level shim this isolated tsconfig needs to typecheck them,
 * scoped to this directory's own program alone.
 */
interface ImportMeta {
  readonly env?: { readonly BASE_URL?: string };
}
