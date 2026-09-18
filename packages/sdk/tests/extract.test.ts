import { describe, expect, test } from 'bun:test';
import {
  arrays,
  createExtractor,
  deepEqual,
  type ExtractedField,
  getLocalized,
  type LocaleContext,
  localize,
  localizedText,
  objects,
  pathKey,
  projectLocale,
  restore,
  setAt,
} from '../src';

const ctx: LocaleContext = { sourceLocale: 'en', locale: 'de' };

const doc = {
  id: 'abc',
  title: { en: 'Home', de: 'Start' },
  hero: { en: '68a1b2c3d4e5f60718293a4b', de: '68a1b2c3d4e5f60718293a4c' },
  enabled: { en: true, de: false },
  disableTranslate: { en: false, de: true },
  blocks: [
    { blockType: 'cta', label: { en: 'Buy', de: 'Kaufen' }, url: '/buy' },
    { blockType: 'cta', label: { en: 'Try' }, url: '/try' },
  ],
  voices: { en: [{ voice: 'v1' }], de: [{ voice: 'v2' }] },
};

describe('createExtractor', () => {
  const extract = createExtractor<ExtractedField, LocaleContext>(
    [localizedText({ skip: (path) => pathKey(path) === 'hero' }), arrays(), objects()],
    { ignoreKeys: ['disableTranslate'] },
  );

  test('walks arrays and objects, claims localized strings, skips references, ignored keys and empty sources', async () => {
    const fields = await extract({ ...doc, tagline: { en: '  ', de: 'Slogan' } }, ctx);
    expect(fields.map((field) => [pathKey(field.path), field.value])).toEqual([
      ['title', 'Home'],
      ['blocks.0.label', 'Buy'],
      ['blocks.1.label', 'Try'],
    ]);
  });

  test('a rule that passes lets the next one look; unmatched leaves are reported, not thrown', async () => {
    const unmatched: string[] = [];
    const strict = createExtractor<ExtractedField, LocaleContext>([localizedText()], { onUnmatched: (path) => unmatched.push(pathKey(path)) });
    expect(await strict({ title: { en: 'x' }, slug: 'y' }, ctx)).toHaveLength(0);
    expect(unmatched).toEqual(['']);
  });
});

describe('localize / restore', () => {
  test('collapses to the source, swaps translations in by path, restore puts locale values back', async () => {
    const localized = localize(doc, { title: 'Startseite', 'blocks.0.label': 'Kaufen!' }, ctx);
    expect(localized).toEqual({
      id: 'abc',
      title: 'Startseite',
      hero: '68a1b2c3d4e5f60718293a4b',
      enabled: true,
      disableTranslate: false,
      blocks: [
        { blockType: 'cta', label: 'Kaufen!', url: '/buy' },
        { blockType: 'cta', label: 'Try', url: '/try' },
      ],
      voices: [{ voice: 'v1' }],
    });
    const restored = restore(localized, [
      { path: ['enabled'], value: false },
      { path: ['hero'], value: '68a1b2c3d4e5f60718293a4c' },
    ]);
    expect(restored).toMatchObject({ enabled: false, hero: '68a1b2c3d4e5f60718293a4c', title: 'Startseite' });
    // Copy-on-write: the input is untouched.
    expect(doc.enabled).toEqual({ en: true, de: false });
  });

  test('projectLocale is the locale as stored; getLocalized reads through maps', () => {
    expect(projectLocale(doc, ctx)).toMatchObject({ title: 'Start', enabled: false, blocks: [{ label: 'Kaufen' }, { label: undefined }] });
    expect(getLocalized(doc, ['blocks', 0, 'label'], ctx)).toBe('Kaufen');
    expect(getLocalized(doc, ['blocks', 1, 'label'], ctx)).toBeUndefined();
    expect(getLocalized(doc, ['voices', 0, 'voice'], ctx)).toBe('v2');
  });

  test('setAt creates missing containers and deepEqual ignores undefined and key order', () => {
    expect(setAt({}, ['a', 0, 'b'], 1)).toEqual({ a: [{ b: 1 }] });
    expect(deepEqual({ a: 1, b: undefined }, { b: undefined, a: 1 })).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});
