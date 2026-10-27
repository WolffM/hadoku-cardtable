/*
 * The patch-notes card's own parser — pure, and tested on a REAL release file rather than a
 * fixture, because `docs/releases/*.md`'s own shape (`# vX.Y.Z — Title`, then `## New` / `## Changed`
 * / `## Fixed` / `## Under the hood`, each a flat bullet list) is the contract this reads, not one
 * this file gets to invent (`docs/planning/wave77-2026-10-27.md` §A: "the newest release's title and
 * its first bullets").
 */

export interface ParsedRelease {
  /** `vX.Y.Z`, read off the filename (`v0.36.0.md`) — the one piece the heading does not repeat reliably. */
  version: string;
  /** The text after the em dash on the `#` heading; the bare version when there is none. */
  title: string;
  /** The first bullets under `## New` then `## Changed`, in that order, markdown emphasis stripped. */
  bullets: string[];
}

/** One bullet's text, its leading `- ` and any `**bold**`/`*em*` markers stripped — a card draws plain text. */
function plainBullet(line: string): string {
  return line
    .replace(/^[-*]\s+/, '')
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

  // New's bullets before Changed's, each read in the file's own order — the card shows what shipped
  // before what merely changed, and tops up from Changed only once New runs out.
  const ordered = [...bulletsOfSection(lines, 'new'), ...bulletsOfSection(lines, 'changed')];
  return { version, title, bullets: ordered.slice(0, 3) };
}

/**
 * A release file wraps a long bullet onto an indented continuation line (no leading `-`), so this
 * joins every line up to the next bullet, heading or blank line before stripping markdown.
 */
function bulletsOfSection(lines: readonly string[], target: 'new' | 'changed'): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = /^##\s+(.+)/.exec(line);
    if (heading !== null) {
      inSection = heading[1]!.trim().toLowerCase() === target;
      continue;
    }
    if (!inSection) continue;
    if (/^[-*]\s+/.test(line)) {
      out.push(plainBullet(line));
    } else if (/^\s+\S/.test(line) && out.length > 0) {
      out[out.length - 1] = `${out[out.length - 1]!} ${line.trim()}`;
    }
  }
  return out;
}

/** `v0.36.0.md` → `v0.36.0`. `null` for a name this does not recognise as a release's. */
export function versionOfPath(path: string): string | null {
  const m = /([^/]+)\.md$/.exec(path);
  return m === null ? null : m[1]!;
}

/** The newest of a set of release versions, by semantic order (`v` + three dot-separated integers). */
export function newestVersion(versions: readonly string[]): string | null {
  let best: string | null = null;
  let bestParts: readonly number[] = [];
  for (const v of versions) {
    const parts = v.replace(/^v/, '').split('.').map(Number);
    if (best === null || compareVersions(parts, bestParts) > 0) {
      best = v;
      bestParts = parts;
    }
  }
  return best;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
