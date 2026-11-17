/**
 * ArchiveBot's release-announce settings (w120 §K, C's w119 remainder): cardtable's own
 * deployment integration, read here because this IS the deployment (the `site` layer, which may
 * read anything) rather than in Magic's config — its two readers, `plugins/{listen,routes}.ts`,
 * live in the `magic` layer, which `scripts/layers/layers.json` forbids from importing
 * `apps/server`. `config` phase, before `routes`/`listen` read `ctx.state.archivebot`.
 *
 * `ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET` is prod-only (PPE's wrapper holds no such key), which is
 * what keeps the release-notes post a prod-only one; unset, the boot announcement is skipped,
 * exactly as before this moved.
 */
import type { CardtablePlugin } from '@hadoku/magic-server/plugins/state';

export const archivebotPlugin: CardtablePlugin = {
	name: 'archivebot',
	phase: 'config',
	setup(ctx) {
		ctx.state.archivebot = {
			secret: process.env.ARCHIVEBOT_CARDTABLE_WEBHOOK_SECRET || '',
			url: process.env.CARDTABLE_ARCHIVEBOT_URL || 'http://127.0.0.1:3004',
		};
	},
};
