/*
 * The site's trim: one look for every player (the operator, 2026-10-21: "make it set the look for
 * every player"), kept by the server (`/api/trim`, `apps/server/src/http/trim.ts`) and written only
 * from `#/ui` by an admin.
 *
 * Read once per page into a module store every screen shares, so `#/ui` and the screens behind it
 * redraw together on a save. Until the read answers, nothing is drawn rather than a default that
 * might be wrong; a site nobody has set, or a read that fails, draws `DEFAULT_TRIM`. Names the
 * catalogue does not know (a newer server, a hand edit) are dropped, never drawn.
 */
import { useLayoutEffect, useSyncExternalStore } from 'react';

import { apiUrl, bodyOf, isRecord } from '../http.ts';
import { applyTrim, DEFAULT_TRIM, isTrimOption, TRIM_FAMILY_IDS, type Trim } from './trim.ts';

export interface SiteTrim {
  /** False until the server has answered. */
  loaded: boolean;
  trim: Trim;
  /** The server's answer: an admin may write it. */
  canEdit: boolean;
}

const UNREAD: SiteTrim = { loaded: false, trim: {}, canEdit: false };
let state: SiteTrim = UNREAD;
let reading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: SiteTrim): void {
  state = next;
  for (const l of listeners) l();
}

/** Only the families and options the catalogue has. */
export function knownTrim(value: unknown): Trim {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    TRIM_FAMILY_IDS.flatMap((f) => (typeof value[f] === 'string' && isTrimOption(f, value[f] as string) ? [[f, value[f]]] : [])),
  ) as Trim;
}

function read(): Promise<void> {
  reading ??= fetch(apiUrl('trim'), { credentials: 'same-origin' })
    .then(async (res) => {
      const body = res.ok ? await bodyOf(res) : null;
      const stored = isRecord(body) ? body.trim : null;
      set({ loaded: true, trim: stored == null ? DEFAULT_TRIM : knownTrim(stored), canEdit: isRecord(body) && body.canEdit === true });
    })
    .catch(() => set({ loaded: true, trim: DEFAULT_TRIM, canEdit: false }));
  return reading;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  void read();
  return () => listeners.delete(listener);
}

export function useSiteTrim(): SiteTrim {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Saves the site's trim; every screen redraws at once, and back again if the server refuses. Whether it was stored. */
export async function saveSiteTrim(trim: Trim): Promise<boolean> {
  const before = state;
  set({ ...state, trim });
  try {
    const res = await fetch(apiUrl('trim'), { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trim }) });
    if (res.ok) return true;
  } catch {
    // Refused below, like a non-2xx answer.
  }
  set(before);
  return false;
}

/** The site's trim, written on `root`: the standalone page's `<html>`, or the embed's chrome root. */
export function useTrim(root: () => HTMLElement | null): void {
  const { trim } = useSiteTrim();
  useLayoutEffect(() => {
    const el = root();
    if (el === null) return undefined;
    applyTrim(el, trim);
    return () => applyTrim(el, {});
  }, [root, trim]);
}

/** Tests only: forget what was read. */
export function resetSiteTrimForTests(): void {
  state = UNREAD;
  reading = null;
}
