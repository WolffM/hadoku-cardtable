/*
 * The envelope, and the counts.
 *
 * Four things are checked here that no single tier can check on its own:
 *
 *   1. **The census.** 14 + 21 + 3 = 38, no duplicates, and every modelled
 *      method has exactly one example. If a tier grows a method without a
 *      frame — or a frame without a method — this is where it shows.
 *   2. **Blocking is settled, not guessed.** 15 methods block; the set of
 *      frames that carry a `callId` must equal that list exactly, and so must
 *      the reply table's keys.
 *   3. **A reply is checked against its own method.** The discriminated union
 *      leaves `result` as `unknown` because its type depends on `method`;
 *      `safeParseClientFrame`'s second pass closes that, and a `confirm`
 *      answered with a string has to fail.
 *   4. **Nothing imports from `forge/`.** Asserted by reading this package's
 *      own sources, so it stays true after the next file lands rather than only
 *      on the day somebody ran the grep.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ABORT_REASONS,
  BLOCKING_METHODS,
  ClientAbortSchema,
  FORGE_CHANNEL,
  REPLY_SCHEMAS,
  REQUIRED_METHODS,
  isBlocking,
  parseClientFrame,
  parseServerFrame,
  safeParseClientFrame,
  safeParseServerFrame,
} from './envelope.ts';
import { CLIENT_FRAME_EXAMPLES, REPLY_EXAMPLES, SERVER_FRAME_EXAMPLES } from './examples.ts';
import { TIER_A_METHODS } from './tier-a.ts';
import { TIER_B_METHODS } from './tier-b.ts';
import { TIER_C_METHODS } from './tier-c.ts';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

describe('the census — 14 + 21 + 3 = 38', () => {
  it('matches Wave 6 lane F’s tiering, method for method', () => {
    expect(TIER_A_METHODS).toHaveLength(14);
    expect(TIER_B_METHODS).toHaveLength(21);
    expect(TIER_C_METHODS).toHaveLength(3);
    expect(REQUIRED_METHODS).toHaveLength(38);
  });

  it('names no method twice', () => {
    expect(new Set(REQUIRED_METHODS).size).toBe(38);
  });

  it('has exactly one example per modelled method, and none for Tier C', () => {
    const examples = [
      ...Object.keys(SERVER_FRAME_EXAMPLES),
      ...Object.keys(CLIENT_FRAME_EXAMPLES),
    ].sort();
    const modelled = [...TIER_A_METHODS, ...TIER_B_METHODS].sort();
    expect(examples).toEqual(modelled);
    expect(examples).toHaveLength(35);
  });
});

describe('blocking — the 15 that park a Forge game thread', () => {
  it('is 15 methods, all of them server→client and modelled', () => {
    expect(BLOCKING_METHODS).toHaveLength(15);
    expect(new Set(BLOCKING_METHODS).size).toBe(15);
    for (const method of BLOCKING_METHODS) {
      expect(Object.keys(SERVER_FRAME_EXAMPLES)).toContain(method);
      expect(isBlocking(method)).toBe(true);
    }
  });

  it('the frames carrying a callId are exactly the blocking ones', () => {
    const withCallId = Object.entries(SERVER_FRAME_EXAMPLES)
      .filter(([, frame]) => 'callId' in (frame as Record<string, unknown>))
      .map(([method]) => method)
      .sort();
    expect(withCallId).toEqual([...BLOCKING_METHODS].sort());
  });

  it('the frames with kind "ask" are exactly the blocking ones', () => {
    const asks = Object.entries(SERVER_FRAME_EXAMPLES)
      .filter(([, frame]) => (frame as Record<string, unknown>).kind === 'ask')
      .map(([method]) => method)
      .sort();
    expect(asks).toEqual([...BLOCKING_METHODS].sort());
  });

  it('the reply table has one entry per blocking method and no others', () => {
    expect(Object.keys(REPLY_SCHEMAS).sort()).toEqual([...BLOCKING_METHODS].sort());
    expect(Object.keys(REPLY_EXAMPLES).sort()).toEqual([...BLOCKING_METHODS].sort());
  });

  it('no client→server method blocks — ProtocolMethod.java:84-86', () => {
    for (const method of Object.keys(CLIENT_FRAME_EXAMPLES)) {
      expect([method, isBlocking(method)]).toEqual([method, false]);
    }
  });
});

describe('replies are validated against the method they answer', () => {
  it.each(BLOCKING_METHODS)('a valid %s reply parses', (method) => {
    const result = safeParseClientFrame({
      kind: 'reply',
      callId: 'c-1',
      method,
      result: REPLY_EXAMPLES[method],
    });
    expect(result.ok ? null : result.errors).toBeNull();
  });

  it('a confirm answered with a string is rejected', () => {
    const result = safeParseClientFrame({
      kind: 'reply',
      callId: 'c-1',
      method: 'confirm',
      result: 'yes',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toContain('reply to confirm');
    expect(result.errors[0].path).toBe('$.result');
  });

  it('an order reply cannot omit rememberDecision', () => {
    expect(
      safeParseClientFrame({
        kind: 'reply',
        callId: 'c-1',
        method: 'order',
        result: { ordered: ['opt-1'] },
      }).ok,
    ).toBe(false);
  });

  it('a sideboard reply may be null — "I changed nothing"', () => {
    const result = safeParseClientFrame({
      kind: 'reply',
      callId: 'c-1',
      method: 'sideboard',
      result: null,
    });
    expect(result.ok).toBe(true);
  });

  it('a reply to a method that does not block is rejected', () => {
    expect(
      safeParseClientFrame({ kind: 'reply', callId: 'c-1', method: 'message', result: true }).ok,
    ).toBe(false);
    expect(
      safeParseClientFrame({ kind: 'reply', callId: 'c-1', method: 'concede', result: true }).ok,
    ).toBe(false);
  });

  it('a reply without a callId is rejected — an uncorrelated answer is noise', () => {
    expect(
      safeParseClientFrame({ kind: 'reply', method: 'confirm', result: true }).ok,
    ).toBe(false);
    expect(
      safeParseClientFrame({ kind: 'reply', callId: '', method: 'confirm', result: true }).ok,
    ).toBe(false);
  });
});

describe('abort — the answer to Forge’s untimed ReplyPool', () => {
  it('carries a callId and one of four reasons', () => {
    for (const reason of ABORT_REASONS) {
      expect(ClientAbortSchema.safeParse({ kind: 'abort', callId: 'c-1', reason }).success).toBe(
        true,
      );
    }
    expect(
      ClientAbortSchema.safeParse({ kind: 'abort', callId: 'c-1', reason: 'bored' }).success,
    ).toBe(false);
    expect(ClientAbortSchema.safeParse({ kind: 'abort', reason: 'timeout' }).success).toBe(false);
  });

  it('takes an optional detail and refuses anything else', () => {
    expect(
      ClientAbortSchema.safeParse({
        kind: 'abort',
        callId: 'c-1',
        reason: 'timeout',
        detail: 'no answer in 30s',
      }).success,
    ).toBe(true);
    expect(
      ClientAbortSchema.safeParse({
        kind: 'abort',
        callId: 'c-1',
        reason: 'timeout',
        retryAfter: 5,
      }).success,
    ).toBe(false);
  });

  it('parses through the client frame union', () => {
    const frame = parseClientFrame({ kind: 'abort', callId: 'c-1', reason: 'disconnected' });
    expect(frame.kind).toBe('abort');
  });
});

describe('the transport itself', () => {
  it('has one event name per direction, and they differ', () => {
    expect(FORGE_CHANNEL.serverToClient).not.toBe(FORGE_CHANNEL.clientToServer);
  });

  it('rejects junk in both directions', () => {
    for (const junk of [null, undefined, 42, 'frame', [], {}, { kind: 'notify' }]) {
      expect([junk, safeParseServerFrame(junk).ok]).toEqual([junk, false]);
      expect([junk, safeParseClientFrame(junk).ok]).toEqual([junk, false]);
    }
  });

  it('the throwing helpers name what failed', () => {
    expect(() => parseServerFrame({ kind: 'notify', method: 'nope' }, 'from bridge')).toThrow(
      /from bridge is not a valid ServerFrame/,
    );
    expect(() => parseClientFrame({ kind: 'act', method: 'nope' }, 'from browser')).toThrow(
      /from browser is not a valid ClientFrame/,
    );
  });

  it('a client cannot send a server frame, or the reverse', () => {
    expect(safeParseClientFrame(SERVER_FRAME_EXAMPLES.message).ok).toBe(false);
    expect(safeParseServerFrame(CLIENT_FRAME_EXAMPLES.concede).ok).toBe(false);
  });
});

describe('nothing in this package reaches into the vendored Forge tree', () => {
  const sources = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'));

  // Assembled rather than written, so this file does not trip its own check.
  const VENDORED = 'forge'.concat('/');

  /** Drop block and line comments, so a Forge citation in prose is not code. */
  function code(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  it('reads a non-empty set of sources, so the check cannot pass vacuously', () => {
    expect(sources.length).toBeGreaterThanOrEqual(9);
    // And the comment stripper must not be eating the code it is scanning.
    expect(code(readFileSync(join(SRC_DIR, 'envelope.ts'), 'utf8'))).toContain("from './tier-c.ts'");
    expect(VENDORED).toBe(['forge', ''].join('/'));
  });

  it.each(sources)('%s imports only zod, @hadoku/*, node: and its own siblings', (file) => {
    const specifiers = [
      ...code(readFileSync(join(SRC_DIR, file), 'utf8')).matchAll(/from\s*'([^']+)'/g),
    ].map((m) => m[1]);

    for (const specifier of specifiers) {
      const allowed =
        specifier === 'zod' ||
        specifier === 'vitest' ||
        specifier.startsWith('@hadoku/') ||
        specifier.startsWith('node:') ||
        /^\.\.?\/[\w./-]+\.ts$/.test(specifier);
      expect([file, specifier, allowed]).toEqual([file, specifier, true]);
    }
  });

  it.each(sources)('%s never names the vendored tree in code', (file) => {
    // Comments cite Forge files by BASENAME (`ProtocolMethod.java:35`) on
    // purpose. A vendored-tree path in the CODE means somebody started
    // reaching into the submodule — which CI does not even fetch.
    expect([file, code(readFileSync(join(SRC_DIR, file), 'utf8')).includes(VENDORED)]).toEqual([
      file,
      false,
    ]);
  });
});
