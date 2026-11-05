/*
 * The patch-notes card's own parser — pure, and tested on a REAL release file rather than a
 * fixture, because `docs/releases/*.md`'s own shape (`# vX.Y.Z — Title`, then `## New` / `## Changed`
 * / `## Fixed` / `## Under the hood`, each a flat bullet list) is the contract this reads, not one
 * this file gets to invent (`docs/planning/wave77-2026-10-27.md` §A: "the newest release's title and
 * its first bullets"). The player's own sections only: `## Under the hood` / `## Fixes` stay in the full notes.
 */

export interface ParsedRelease {
  /** `vX.Y.Z`, read off the filename (`v0.36.0.md`) — the one piece the heading does not repeat reliably. */
  version: string;
  /** The text after the em dash on the `#` heading; the bare version when there is none. */
  title: string;
  /** Every bullet under `## New`, `## Changed` then `## Fixed`, in that order, markdown emphasis stripped: the card draws as many as fit. */
  bullets: string[];
  /** The paragraph between the heading and the first section; empty when there is none. */
  summary: string;
  /** Every `##` section in the file's order, its bullets with their markdown kept (the full notes draw `**bold**`). */
  sections: ReleaseSection[];
}

export interface ReleaseSection {
  heading: string;
  bullets: string[];
}

/** One bullet's text with any `**bold**`/`*em*` markers stripped — a card draws plain text. */
function plainBullet(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .trim();
}

/**
 * `markdown` is one release file's whole text, `version` its filename's `vX.Y.Z`. `null` when the
 * file has no heading at all — not expected of a real release, but never thrown over one.
 */
export function parseReleaseNotes(markdown: string, version: string): ParsedRelease | null {
  const lines = markdown.split('\n');
  const headingLine = lines.find((l) => l.startsWith('# '));
  if (headingLine === undefined) return null;
  const heading = headingLine.slice(2).trim();
  const dash = heading.indexOf('—'); // em dash
  const title = dash === -1 ? heading : heading.slice(dash + 1).trim();

  const { summary, sections } = sectionsOf(lines.slice(lines.indexOf(headingLine) + 1));
  // New's bullets, then Changed's, then Fixed's, each in the file's own order — the card shows what
  // shipped before what merely changed or was mended, and draws down the list as far as it has room.
  const named = (target: string): string[] => sections.find((s) => s.heading.toLowerCase() === target)?.bullets ?? [];
  const bullets = [...named('new'), ...named('changed'), ...named('fixed')].map(plainBullet);
  return { version, title, bullets, summary, sections };
}

/**
 * A release file wraps a long bullet onto an indented continuation line (no leading `-`), so this
 * joins every continuation onto its bullet. Lines before the first `##` are the summary paragraph.
 */
function sectionsOf(lines: readonly string[]): { summary: string; sections: ReleaseSection[] } {
  const summary: string[] = [];
  const sections: ReleaseSection[] = [];
  for (const line of lines) {
    const heading = /^##\s+(.+)/.exec(line);
    if (heading !== null) {
      sections.push({ heading: heading[1]!.trim(), bullets: [] });
      continue;
    }
    const current = sections.at(-1);
    if (current === undefined) {
      if (line.trim() !== '') summary.push(line.trim());
      continue;
    }
    const bullet = /^[-*]\s+(.*)/.exec(line);
    if (bullet !== null) {
      current.bullets.push(bullet[1]!.trim());
    } else if (/^\s+\S/.test(line) && current.bullets.length > 0) {
      current.bullets[current.bullets.length - 1] = `${current.bullets.at(-1)!} ${line.trim()}`;
    }
  }
  return { summary: summary.join(' '), sections: sections.filter((s) => s.bullets.length > 0) };
}

/**
 * How many bullets, from the first, sit wholly inside a list whose bottom edge is `limit`; `bottoms` are
 * each bullet's bottom edge in the same coordinates. The card hides the rest rather than cut one in half.
 */
export function fittingBullets(bottoms: readonly number[], limit: number): number {
  const over = bottoms.findIndex((b) => b > limit + 0.5);
  return over === -1 ? bottoms.length : over;
}

/** `v0.36.0.md` → `v0.36.0`. `null` for a name this does not recognise as a release's. */
export function versionOfPath(path: string): string | null {
  const m = /([^/]+)\.md$/.exec(path);
  return m === null ? null : m[1]!;
}

/** Releases newest first, by semantic order (`v` + three dot-separated integers, each a number). */
export function newestFirst<T extends { version: string }>(releases: readonly T[]): T[] {
  const parts = (v: string): number[] => v.replace(/^v/, '').split('.').map(Number);
  return [...releases].sort((a, b) => compareVersions(parts(b.version), parts(a.version)));
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
