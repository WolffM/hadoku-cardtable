/* How long until an event starts, as the Upcoming card, the calendar and a scheduled room's card all say it. */

/** `in 2d 4h`, `in 3h 10m`, `in 25m`, or `now` once it has started. */
export function countdown(startsAt: string, now: number): string {
  const ms = Date.parse(startsAt) - now;
  if (!(ms > 0)) return 'now';
  const minutes = Math.ceil(ms / 60_000);
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? `in ${days}d ${hours}h` : `in ${days}d`;
  if (hours > 0) return mins > 0 ? `in ${hours}h ${mins}m` : `in ${hours}h`;
  return `in ${mins}m`;
}
