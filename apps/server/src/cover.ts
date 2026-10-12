/*
 * `/cover`: cardtable's tile in watchparty's game picker. The catalog's
 * `cover` must be a same-origin path.
 *
 * Drawn here rather than borrowed from a card: the picker crops its cover to a
 * square under a name label and has nowhere to credit an artist, and a cropped
 * card's art without its artist and copyright is exactly what Scryfall's image
 * guidelines rule out. So the cover is three of our own card backs — the same
 * back `card.css`'s `.card-back` draws (a bordered field, an inset panel, a
 * lozenge) — fanned on the table's dark felt. No card art, no WotC mark.
 */

import type { Request, Response } from 'express';

const W = 488;
const H = 680;

/** One back at the origin, the size of a card face: field, inset panel, lozenge. */
function back(): string {
	const inset = 0.11;
	const lozenge = W * 0.36;
	return [
		`<rect width="${W}" height="${H}" rx="28" fill="url(#field)" stroke="#3a4152" stroke-width="6"/>`,
		`<rect x="${W * inset}" y="${H * inset}" width="${W * (1 - 2 * inset)}" height="${H * (1 - 2 * inset)}" rx="16" fill="none" stroke="#2a3040" stroke-width="5"/>`,
		`<path d="M${W / 2} ${H / 2 - lozenge / 2} L${W / 2 + lozenge / 2} ${H / 2} L${W / 2} ${H / 2 + lozenge / 2} L${W / 2 - lozenge / 2} ${H / 2} Z" fill="#8a93a8" fill-opacity="0.34"/>`,
	].join('');
}

/** The cover: a square of felt with three backs fanned about a point below it. */
export function coverSvg(): string {
	const size = 1024;
	const fan = [-14, 0, 14]
		.map(
			(deg) =>
				`<g transform="translate(${size / 2} ${size * 0.95}) rotate(${deg}) translate(${-W / 2} ${-H - 140})">${back()}</g>`
		)
		.join('');
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">`,
		'<defs>',
		'<radialGradient id="felt" cx="50%" cy="40%" r="75%"><stop offset="0" stop-color="#1d4a3a"/><stop offset="1" stop-color="#0b1a15"/></radialGradient>',
		'<radialGradient id="field" cx="50%" cy="38%" r="90%"><stop offset="0" stop-color="#2b3140"/><stop offset="0.62" stop-color="#1b1f29"/><stop offset="1" stop-color="#12151c"/></radialGradient>',
		'</defs>',
		`<rect width="${size}" height="${size}" fill="url(#felt)"/>`,
		fan,
		'</svg>',
	].join('');
}

export function serveCover(_req: Request, res: Response): void {
	res.setHeader('Cache-Control', 'public, max-age=3600');
	res.type('image/svg+xml').send(coverSvg());
}
