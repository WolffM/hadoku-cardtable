/*
 * Client telemetry for a played card's two hand-overs, on BOTH screens: the
 * stand-in giving way to the stack card (`handover`), and to the card in its
 * row (`landing`). What the operator sees as jitter is a fact of the painted
 * frame — how far the stand-in actually was from where its replacement is
 * drawn, how far into its glide, and whether two copies of the card were up
 * at once — so those are measured off the DOM at the moment it happens, never
 * reconstructed from the release point.
 *
 * Sent through the seat's existing client-event path (`@hadoku/shared`'s
 * `telemetry.ts`, `LiveBoard`'s `reportClient`): flat scalars, a bounded field
 * set, one event per hand-over.
 */
import { GLIDE_MS } from '../motion.ts';
import type { Point } from './gestures/types.ts';

export type ReportKind = 'landing' | 'handover';
export type Report = (kind: ReportKind, data: Record<string, string | number | boolean>) => void;

export interface HandoverFacts {
  /** `caster`: the screen that played the card; `receiver`: the other seat's. */
  readonly screen: 'caster' | 'receiver';
  readonly card: number | null;
  /** `stack` (to the placed stack card), `flight`, `swap` (in place), or why nothing travelled. */
  readonly how: string;
  /** The stand-in's centre as drawn right now; null when there is none. */
  readonly from: Point | null;
  /** The replacement's centre as drawn — or the replacement itself, measured on the frame the report is taken (a stack card drawn this instant has no box yet). */
  readonly to: Point | Element | null;
  /** `Date.now()` when the stand-in began its glide into the gap; null when it never glided. */
  readonly glideStartedAt: number | null;
  /** `Date.now()` of the release — on the receiver, when the release reached this screen. */
  readonly releasedAt: number | null;
  /** `Date.now()` when Forge's frame put the spell on the stack, as this screen saw it. */
  readonly stackFrameAt: number | null;
  readonly motion: boolean;
}

/** The centre of `el` as drawn this frame, or null when it has no box. */
export function drawnCentreOf(el: Element | null | undefined): Point | null {
  if (el === null || el === undefined || !el.isConnected) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}

function shown(el: Element): boolean {
  if (!el.isConnected || el.hasAttribute('data-placed-pending')) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.opacity !== '0' && style.display !== 'none';
}

/**
 * How many copies of `card` are drawn and visible right now: its own element in a zone, its
 * placed stack card, the caster's stand-in (`data-cast-ghost`), and the receiver's back or
 * travelling copy (these carry no id; one play is in flight on that screen at a time).
 */
export function visibleCopies(root: ParentNode, card: number): number {
  const copies = [
    ...root.querySelectorAll(`[data-zone] [data-board-card="${card}"]`),
    ...root.querySelectorAll(`[data-placed-card="${card}"]`),
    ...root.querySelectorAll(`[data-cast-ghost="${card}"]`),
    ...root.querySelectorAll('.presence__back[data-waiting], .presence__handoff'),
  ];
  return copies.filter(shown).length;
}

/** The event's fields: flat, rounded, and only the ones known (a null is left out). */
export function handoverData(f: HandoverFacts & { readonly to: Point | null }, doubled: boolean, now = Date.now()): Record<string, string | number | boolean> {
  const data: Record<string, string | number | boolean> = { screen: f.screen, how: f.how, motion: f.motion, doubled };
  if (f.card !== null) data.card = f.card;
  if (f.from !== null) {
    data.fromX = Math.round(f.from.x);
    data.fromY = Math.round(f.from.y);
  }
  if (f.to !== null) {
    data.toX = Math.round(f.to.x);
    data.toY = Math.round(f.to.y);
  }
  if (f.from !== null && f.to !== null) data.dist = Math.round(Math.hypot(f.to.x - f.from.x, f.to.y - f.from.y));
  if (f.glideStartedAt !== null) {
    data.glideMs = now - f.glideStartedAt;
    data.glideDone = now - f.glideStartedAt >= GLIDE_MS;
  }
  if (f.releasedAt !== null) data.msSinceRelease = now - f.releasedAt;
  if (f.stackFrameAt !== null) data.msSinceStackFrame = now - f.stackFrameAt;
  return data;
}

/**
 * Report one hand-over. The facts are taken now, at the hand-over itself; whether two copies
 * were up at once is read on the next animation frame — the DOM that frame paints — so a copy
 * the swap leaves behind for a frame is counted.
 */
export function reportHandover(report: Report | undefined, kind: ReportKind, root: ParentNode, facts: HandoverFacts): void {
  if (report === undefined) return;
  const now = Date.now();
  requestAnimationFrame(() => {
    const doubled = facts.card !== null && visibleCopies(root, facts.card) > 1;
    const to = facts.to instanceof Element ? drawnCentreOf(facts.to) : facts.to;
    report(kind, handoverData({ ...facts, to }, doubled, now));
  });
}
