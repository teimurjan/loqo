import { describe, expect, test } from 'bun:test';
import { brandTerms, lengthCap, newlineParity, placeholderParity, pluralParity } from '../src/core/guards';
import { scanIcuArguments } from '../src/core/guards/icu';
import { isPlaceholderOnlyKey } from '../src/core/guards/specifiers';
import type { ValueContext } from '../src/core/model/types';

const ctx = (over: Partial<ValueContext> = {}): ValueContext => ({
  projectSlug: 'p',
  sourceLocale: 'en',
  locale: 'pl',
  key: 'k',
  tags: [],
  meta: {},
  ...over,
});

describe('placeholderParity', () => {
  const guard = placeholderParity();
  test('ios: rejects a dropped or invented specifier, accepts reordering', async () => {
    const ios = ctx({ tags: ['ios'] });
    expect(await guard.check('%2$@ ma %1$lld', '%1$lld items in %2$@', ios)).toBeNull();
    expect(await guard.check('godzinę temu', '%1$s hours ago', ios)).toMatch(/format specifiers changed/);
    expect(await guard.check('%1$s %1$s', '%1$s', ios)).toMatch(/got \[%1\$sx2\]/);
    expect(await guard.check('100 %', '100%%', ios)).toMatch(/changed/);
  });
  test('android xliff tags are compared whole', async () => {
    const android = ctx({ tags: ['android'] });
    const source = 'Moved <xliff:g id="count" example="5">%1$d</xliff:g> files';
    expect(await guard.check('Przeniesiono <xliff:g id="count" example="5">%1$d</xliff:g> plików', source, android)).toBeNull();
    expect(await guard.check('Przeniesiono <xliff:g id="n">%1$d</xliff:g> plików', source, android)).toMatch(/xliff/);
  });
  test('mustache keys are checked everywhere', async () => {
    expect(await guard.check('Hola {{userName}}', 'Hello {{userName}}', ctx())).toBeNull();
    expect(await guard.check('Hola {{nombre}}', 'Hello {{userName}}', ctx())).toMatch(/template keys/);
  });
  test('does not match plain resources without placeholders', async () => {
    expect(await guard.check('Cześć', 'Hello', ctx())).toBeNull();
  });
});

describe('icu + pluralParity', () => {
  const guard = pluralParity();
  test('scans nested arguments and plural options', async () => {
    const args = scanIcuArguments('{count, plural, one {# item in {folder}} other {# items}} left');
    expect(args.map((a) => `${a.name}:${a.type}`)).toEqual(['count:plural', 'folder:null']);
    expect(Object.keys(args[0]!.options)).toEqual(['one', 'other']);
  });
  test('rejects invalid categories for the locale and empty variants', async () => {
    const webapp = ctx({ tags: ['webapp'], locale: 'pl' });
    const source = '{count, plural, one {# book} other {# books}}';
    expect(await guard.check('{count, plural, one {# książka} few {# książki} many {# książek} other {# książki}}', source, webapp)).toBeNull();
    expect(await guard.check('{count, plural, one {# książka} two {# x} other {# książek}}', source, webapp)).toMatch(/invalid for pl: two/);
    expect(await guard.check('{count} książka{count, plural, one {} few {i} other {}}', source, webapp)).toMatch(/ICU arguments changed/);
    expect(await guard.check('{count, plural, one {# książka} other {}}', source, webapp)).toMatch(/empty variants: other/);
    expect(await guard.check('{count, plural, one {# książka}}', source, webapp)).toMatch(/no 'other'/);
  });
  test('judges selectordinal against the ordinal categories', async () => {
    const source = '{day, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}';
    expect(await guard.check('{day, selectordinal, one {#r} two {#n} few {#r} other {#è}}', source, ctx({ tags: ['webapp'], locale: 'ca' }))).toBeNull();
    expect(await guard.check('{day, selectordinal, one {#.} two {#.} few {#.} other {#.}}', source, ctx({ tags: ['webapp'], locale: 'de' }))).toMatch(
      /invalid for de: one, two, few \(allowed: other\)/,
    );
  });
  test('accepts exact matches and ignores messages without arguments', async () => {
    const webapp = ctx({ tags: ['webapp'], locale: 'ru' });
    expect(await guard.check('{n, plural, =0 {нет} one {#} few {#} many {#} other {#}}', '{n, plural, =0 {none} one {#} other {#}}', webapp)).toBeNull();
    expect(await guard.check('Привет', 'Hello', webapp)).toBeNull();
  });
});

describe('lengthCap', () => {
  const guard = lengthCap();
  test('matches only when meta.maxLength is set and offers a repair', async () => {
    expect(guard.match(ctx())).toBe(false);
    const capped = ctx({ meta: { maxLength: 5 } });
    expect(guard.match(capped)).toBe(true);
    expect(await guard.check('abcde', 'x', capped)).toBeNull();
    const reason = await guard.check('abcdef', 'x', capped);
    expect(reason).toMatch(/too long: 6 chars, max 5/);
    expect((await guard.repair?.('abcdef', 'x', capped, reason!))?.prompt).toMatch(/at most 4 characters/);
  });
});

describe('brandTerms', () => {
  const guard = brandTerms(['Acme']);
  test('requires the term verbatim when the source has it', async () => {
    expect(await guard.check('Акме читает', 'Acme reads', ctx())).toMatch(/missing/);
    expect(await guard.check('Acme читает', 'Acme reads', ctx())).toBeNull();
    expect(await guard.check('что угодно', 'anything', ctx())).toBeNull();
  });
});

describe('newlineParity', () => {
  test('counts line breaks on tagged resources', async () => {
    const guard = newlineParity();
    const tagged = ctx({ tags: ['preserve-newlines'] });
    expect(guard.match(ctx())).toBe(false);
    expect(await guard.check('a\nb', 'x\ny', tagged)).toBeNull();
    expect(await guard.check('a b', 'x\ny', tagged)).toMatch(/expected 1, got 0/);
  });
});

describe('isPlaceholderOnlyKey', () => {
  test('flags keys with nothing translatable', async () => {
    expect(isPlaceholderOnlyKey('%@')).toBe(true);
    expect(isPlaceholderOnlyKey('%1$@ - %2$@')).toBe(true);
    expect(isPlaceholderOnlyKey('1.5×')).toBe(false);
    expect(isPlaceholderOnlyKey('%@ items')).toBe(false);
  });
});
