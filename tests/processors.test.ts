import { describe, expect, test } from 'bun:test';
import { stripControlCharacters } from '../src/core/pipeline/llm';
import { decodeSpaceEntities, repairFormatSpecifiers, stripEnvelopeTail } from '../src/core/processors/repairs';
import { extractNewlines, restoreNewlines } from '../src/core/processors/newline-placeholder';

describe('stripEnvelopeTail', () => {
  test('strips a leaked closer but keeps a legitimately moved placeholder', () => {
    expect(stripEnvelopeTail('Get %@”}', 'Get %@')).toBe('Get %@');
    expect(stripEnvelopeTail('فعِّل {chip}', 'Create {chip} on')).toBe('فعِّل {chip}');
    expect(stripEnvelopeTail('plain', 'plain')).toBe('plain');
  });
});

describe('repairFormatSpecifiers', () => {
  test('fixes transposed positional specifiers only', () => {
    expect(repairFormatSpecifiers('%2@$ and %1lld$')).toBe('%2$@ and %1$lld');
    expect(repairFormatSpecifiers('%2$@ %@ %lld')).toBe('%2$@ %@ %lld');
  });
});

describe('stripControlCharacters', () => {
  test('drops controls and the BOM, keeps every character a language may need', () => {
    expect(stripControlCharacters('\uFEFFa\u0000b\u0007c\u009Fd\te\nf')).toBe('abcd\te\nf');
    const kept = 'می\u200Cخواهم \u200Bไทย \u200Fعربي\u200E Prix\u00A0: 5\u202F€ 　日本';
    expect(stripControlCharacters(kept)).toBe(kept);
  });
});

describe('decodeSpaceEntities', () => {
  test('decodes space entities to the spaces they name, swallowing the ordinary spaces around them', () => {
    expect(decodeSpaceEntities('Prix&nbsp;: 5&#160;€ et &#8239;! &thinsp;x')).toBe('Prix\u00A0: 5\u00A0€ et\u202F!\u2009x');
  });
});

describe('newline tokens', () => {
  test('round-trips through the model-safe token', () => {
    expect(extractNewlines('a\nb')).toBe('a<br/>b');
    expect(restoreNewlines('a<br />b<BR>c')).toBe('a\nb\nc');
  });
});
