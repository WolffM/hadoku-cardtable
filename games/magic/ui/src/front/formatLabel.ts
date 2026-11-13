/*
 * A format era's id, read as a short label — the operator's rulings (2026-10-27), ruling 5:
 *
 *   "legacy-2011-07-15"  -> "Legacy 2011"
 *   "modern-2011-07-15"  -> "Modern 2011"
 *   "2018-07-13"         -> "Standard 2018"   (a bare date is always a Standard era)
 *
 * and, where the family is already said (a year slider beside its format's tabs), the year alone.
 *
 * The id shapes come from `games/magic/ui/src/screens/tables.ts`'s own comment on `erasOf`: "a Standard id
 * IS its bare `YYYY-MM-DD` date, and a Modern/Legacy id is `<family>-<date>`". Free pick (`FREE_PICK`,
 * `'free'`) is never passed here — callers keep saying "Free pick" themselves, exactly as before this
 * wave — and anything else this does not recognise (an empty string, a label already) is returned
 * unchanged rather than mangled.
 */

const FAMILY_DATE = /^(modern|legacy)-(\d{4})-\d{2}-\d{2}$/;
const BARE_DATE = /^(\d{4})-\d{2}-\d{2}$/;

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** A format era's id, as a one- or two-word label: the family (or "Standard" for a bare date) plus its year. */
export function formatEraLabel(id: string): string {
  const family = FAMILY_DATE.exec(id);
  if (family !== null) return `${capitalize(family[1]!)} ${family[2]!}`;
  const bare = BARE_DATE.exec(id);
  if (bare !== null) return `Standard ${bare[1]!}`;
  return id;
}

/** A format era's id, read as its year alone ("modern-2011-07-15" -> "2011"); anything else unchanged. */
export function formatEraYear(id: string): string {
  return (FAMILY_DATE.exec(id)?.[2] ?? BARE_DATE.exec(id)?.[1]) ?? id;
}
