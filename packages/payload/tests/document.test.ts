import { describe, expect, test } from 'bun:test';
import { deepEqual, projectLocale, type PushResource } from '@opendeepl/sdk';
import { documentToResources, localeWrites, rowsWithoutId, rowsWithUnstableId } from '../src/document';
import { buildFieldConfigMap } from '../src/fields';
import type { LexicalCodec } from '../src/rich-text';
import blogCategory from './fixtures/blog-category.json';
import voiceSelect from './fixtures/voice-select-screen.json';

/**
 * Lexical ↔ HTML is the app's job (it needs the editor config); here the codec is the identity so
 * the test is about everything else: paths, restorables, flags, and the promise that a document
 * pulled and pushed back unchanged is byte-for-byte the document.
 */
const identity: LexicalCodec = { toHtml: (node) => JSON.stringify(node), fromHtml: (html) => JSON.parse(html) };

const locales = (document: Record<string, unknown>) => Object.keys((document.title ?? document.voicePartnershipText) as Record<string, unknown>).filter((locale) => locale !== 'en');

const voiceFields = buildFieldConfigMap({
  fields: [
    { name: 'internalName', type: 'text' },
    { name: 'backgroundImage', type: 'upload', localized: true },
    { name: 'headerText', type: 'richText', localized: true, maxLength: 200 },
    { name: 'voicePartnershipText', type: 'text', localized: true, maxLength: 40 },
    { name: 'voices', type: 'array', localized: true, fields: [{ name: 'voice', type: 'relationship' }] },
  ],
});
const categoryFields = buildFieldConfigMap({
  fields: [
    { name: 'title', type: 'text', localized: true },
    { name: 'header', type: 'relationship', localized: true },
    { name: 'seoDescription', type: 'textarea', localized: true, maxLength: 160 },
  ],
});

const asPush = (resources: Awaited<ReturnType<typeof documentToResources>>): PushResource[] =>
  resources.map((resource) => ({
    key: resource.key,
    source: resource.source,
    tags: resource.tags ?? [],
    meta: resource.meta ?? {},
    translatable: resource.translatable ?? true,
    targets: Object.fromEntries(
      Object.entries(resource.targets ?? {}).flatMap(([locale, target]) =>
        typeof target === 'object' && target.value !== undefined ? [[locale, { value: target.value, status: 'translated', origin: 'legacy', pinned: false, native: false }]] : [],
      ),
    ),
  }));

describe('rows without ids', () => {
  const fields = buildFieldConfigMap({
    fields: [
      { name: 'title', type: 'text', localized: true },
      { name: 'items', type: 'array', fields: [{ name: 'label', type: 'text', localized: true }, { name: 'kind', type: 'select' }] },
      { name: 'tags', type: 'array', localized: true, fields: [{ name: 'label', type: 'text' }] },
    ],
  });
  const options = { sourceLocale: 'en', targetLocales: ['de'], fields, codec: identity };
  const target = (value: string) => ({ value, status: 'translated', origin: 'machine', pinned: false, native: false });
  const ref = { collection: 'pages', id: 'p1' };

  test('a shared row without an id that holds a localized value blocks the locale; a localized array\'s own rows do not', async () => {
    const document = {
      id: 'p1',
      title: { en: 'Home', de: 'Start' },
      items: [{ id: 'r1', label: { en: 'One' }, kind: 'a' }, { label: { en: 'Two' }, kind: 'b' }, { kind: 'c' }],
      tags: { en: [{ label: 'x' }], de: [{ label: 'y' }] },
    };
    expect(rowsWithoutId(document, 'en')).toEqual([['items', 1]]);
    const [write] = await localeWrites(ref, document, [{ key: 'pages/p1:title', source: 'Home', tags: [], meta: { path: 'title', kind: 'text' }, translatable: true, targets: { de: target('Startseite') } }], options);
    expect(write).toMatchObject({ locale: 'de', unchanged: true, units: [] });
    expect(write?.rejected).toEqual([{ key: 'pages/p1:title', locale: 'de', reason: expect.stringContaining('row items.1 has no stored id') }]);
  });

  test('an id that changes between two reads was minted on read: the row is as unmatchable as one without', async () => {
    const read = (id: string) => ({ id: 'p1', title: { en: 'Home' }, items: [{ id, label: { en: 'One' }, kind: 'a' }, { id: 'stable', label: { en: 'Two' }, kind: 'b' }] });
    expect(rowsWithUnstableId(read('minted-1'), read('minted-2'), 'en')).toEqual([['items', 0]]);
    expect(rowsWithUnstableId(read('same'), read('same'), 'en')).toEqual([]);
  });

  test('rows with ids write as usual', async () => {
    const document = { id: 'p1', title: { en: 'Home' }, items: [{ id: 'r1', label: { en: 'One' }, kind: 'a' }] };
    const [write] = await localeWrites(ref, document, [{ key: 'pages/p1:title', source: 'Home', tags: [], meta: { path: 'title', kind: 'text' }, translatable: true, targets: { de: target('Startseite') } }], options);
    expect(write).toMatchObject({ locale: 'de', unchanged: false, units: ['title'], rejected: [] });
  });
});

describe('required values a locale lacks', () => {
  const fields = buildFieldConfigMap({
    fields: [
      { name: 'title', type: 'text', localized: true, required: true },
      { name: 'subtitle', type: 'text', localized: true },
      { name: 'logo', type: 'upload', localized: true, required: true },
      { name: 'banner', type: 'upload', localized: true },
      { name: 'align', type: 'select', localized: true, required: true },
      { name: 'identifier', type: 'text', localized: true, custom: { localize: false } },
      { name: 'revision', type: 'text', localized: true, required: true },
      { name: 'body', type: 'richText', localized: true, required: true },
      { name: 'blocks', type: 'blocks', blocks: [{ slug: 'media', fields: [{ name: 'caption', type: 'text', localized: true }, { name: 'image', type: 'upload', localized: true, required: true }] }] },
    ],
  });
  const paragraph = (children: unknown[]) => ({ type: 'paragraph', version: 1, children });
  const link = { type: 'link', version: 3, fields: { linkType: 'custom', url: 'https://x.example' }, children: [{ type: 'text', text: 'X', version: 1 }] };
  const document = {
    id: 'p1',
    title: { en: 'Home', de: 'Start' },
    subtitle: { en: 'Listen', de: '' },
    logo: { en: 'logo-en' },
    banner: { en: 'banner-en' },
    align: { en: 'left' },
    revision: { en: 'rev-en' },
    // The German paragraph puts a word before the link; it must not be lined up with the source's nodes.
    body: { en: { root: { type: 'root', version: 1, children: [paragraph([link])] } }, de: { root: { type: 'root', version: 1, children: [paragraph([{ type: 'text', text: 'Der ', version: 1 }, link])] } } },
    // A required upload inside a block row, next to prose: filled, while the prose beside it is not.
    blocks: [{ id: 'b1', blockType: 'media', caption: { en: 'A caption' }, image: { en: 'image-en' } }],
  };
  const options = { sourceLocale: 'en', targetLocales: ['de'], fields, codec: identity, ignore: ['revision'] };
  const target = (value: string) => ({ value, status: 'translated', origin: 'machine', pinned: false, native: false });

  test('come from the source when required and not prose; prose stays untranslated, ignored keys stay the locale\'s', async () => {
    const [write] = await localeWrites({ collection: 'pages', id: 'p1' }, document, [{ key: 'pages/p1:title', source: 'Home', tags: [], meta: { path: 'title', kind: 'text' }, translatable: true, targets: { de: target('Startseite') } }], options);
    expect(write?.data).toEqual({
      id: 'p1',
      title: 'Startseite',
      subtitle: '',
      logo: 'logo-en',
      banner: undefined,
      align: 'left',
      identifier: undefined,
      revision: undefined,
      body: document.body.de,
      blocks: [{ id: 'b1', blockType: 'media', caption: undefined, image: 'image-en' }],
    });
  });

  test('a select is an option and an opted-out field is not prose: neither is extracted for translation', async () => {
    const resources = await documentToResources({ collection: 'pages', id: 'p1' }, document, options);
    expect(resources.map((resource) => resource.key)).toEqual(['pages/p1:title', 'pages/p1:subtitle', 'pages/p1:body.root.children.0', 'pages/p1:blocks.0.caption']);
    // An empty stored string is not a translation to import.
    expect(resources[1]?.targets).toEqual({});
  });
});

describe('documentToResources', () => {
  test('a mobile screen: text, rich text per node with length limits, revision ignored', async () => {
    const ref = { collection: 'voice-select-screens', id: voiceSelect._id };
    const resources = await documentToResources(ref, voiceSelect, {
      sourceLocale: 'en',
      targetLocales: ['de', 'ar'],
      fields: voiceFields,
      codec: identity,
      ignore: ['revision'],
      disableField: 'disableTranslate',
    });
    expect(resources.map((resource) => resource.key)).toEqual([
      `voice-select-screens/${voiceSelect._id}:headerText.root.children.0`,
      `voice-select-screens/${voiceSelect._id}:headerText.root.children.1`,
      `voice-select-screens/${voiceSelect._id}:voicePartnershipText`,
    ]);
    const [heading, , partnership] = resources;
    expect(heading).toMatchObject({
      source: expect.stringContaining('"text":"Choose your starting voice"'),
      tags: ['collection:voice-select-screens', 'richText'],
      meta: { path: 'headerText.root.children.0', kind: 'richText', maxLength: 200 },
      translatable: true,
    });
    expect(JSON.parse((heading?.targets?.de as { value: string }).value)).toMatchObject({ type: 'heading', tag: 'h1' });
    // (Yes, the stored German is Polish. The adapter imports what is there; the platform is where it gets fixed.)
    expect(partnership).toMatchObject({ meta: { maxLength: 40 }, targets: { de: { value: 'Oficjalne partnerstwo z Acme' } } });
  });

  test('a category: breadcrumb labels are prose, references are not, disableTranslate maps to pins', async () => {
    const withPins = { ...blogCategory, disableTranslate: { ...blogCategory.disableTranslate, de: true, en: false } };
    const resources = await documentToResources({ collection: 'blog-categories', id: blogCategory._id }, withPins, {
      sourceLocale: 'en',
      targetLocales: ['de', 'fr'],
      fields: categoryFields,
      codec: identity,
      ignore: ['revision'],
      disableField: 'disableTranslate',
    });
    expect(resources.map((resource) => resource.meta?.path)).toEqual(['title', 'seoDescription', 'breadcrumbs.0.label']);
    expect(resources[0]?.targets).toEqual({ de: { value: 'Sprachverarbeitung', pinned: true }, fr: { value: 'Dictée vocale' } });

    const disabled = await documentToResources({ collection: 'blog-categories', id: blogCategory._id }, { ...withPins, disableTranslate: { en: true } }, {
      sourceLocale: 'en',
      targetLocales: ['de'],
      fields: categoryFields,
      codec: identity,
      disableField: 'disableTranslate',
    });
    expect(disabled.every((resource) => resource.translatable === false)).toBe(true);
  });
});

describe('zero diff', () => {
  const cases = [
    { name: 'voice-select-screen', ref: { collection: 'voice-select-screens', id: voiceSelect._id }, document: voiceSelect, fields: voiceFields, ignore: ['revision'] },
    { name: 'blog-category', ref: { collection: 'blog-categories', id: blogCategory._id }, document: blogCategory, fields: categoryFields, ignore: ['revision'] },
  ];

  for (const { name, ref, document, fields, ignore } of cases) {
    test(`${name}: pulled then pushed back, every locale is exactly what is stored`, async () => {
      const targetLocales = locales(document);
      const options = { sourceLocale: 'en', targetLocales, fields, codec: identity, ignore, disableField: 'disableTranslate' };
      const resources = asPush(await documentToResources(ref, document, options));
      const writes = await localeWrites(ref, document, resources, options);
      expect(writes.map((write) => write.locale)).toEqual(targetLocales);
      for (const write of writes) {
        const stored = projectLocale(document, { sourceLocale: 'en', locale: write.locale });
        expect(write.rejected).toEqual([]);
        expect(write.data).toEqual(stored);
        expect(write.unchanged).toBe(true);
        expect(deepEqual(write.data, stored)).toBe(true);
      }
    });
  }

  test('a translation lands at its path and only there; the rest of the locale is untouched', async () => {
    const ref = { collection: 'blog-categories', id: blogCategory._id };
    const options = { sourceLocale: 'en', targetLocales: ['de'], fields: categoryFields, codec: identity, ignore: ['revision'], disableField: 'disableTranslate' };
    const resources = asPush(await documentToResources(ref, blogCategory, options));
    const title = resources.find((resource) => resource.meta.path === 'title');
    if (!title) throw new Error('no title');
    title.targets.de = { value: 'Spracheingabe', status: 'translated', origin: 'machine', pinned: false, native: false };
    const [write] = await localeWrites(ref, blogCategory, resources, options);
    const stored = projectLocale(blogCategory, { sourceLocale: 'en', locale: 'de' }) as Record<string, unknown>;
    expect(write?.unchanged).toBe(false);
    expect(write?.data).toEqual({ ...stored, title: 'Spracheingabe' });
  });

  test('a half-translated tree is not written; a complete one is rebuilt from the source with links restored', async () => {
    const ref = { collection: 'voice-select-screens', id: voiceSelect._id };
    const options = { sourceLocale: 'en', targetLocales: ['bn'], fields: voiceFields, codec: identity, ignore: ['revision'] };
    const resources = asPush(await documentToResources(ref, voiceSelect, options));
    const nodes = resources.filter((resource) => resource.meta.kind === 'richText');
    expect(nodes).toHaveLength(2);
    // `bn` has no headerText at all; the source node stands in for the translation.
    const translated = (node: PushResource) => ({ ...node, targets: { bn: { value: node.source, status: 'translated', origin: 'machine', pinned: false, native: false } } });

    const [partial] = await localeWrites(ref, voiceSelect, [translated(nodes[0]!)], options);
    expect(partial?.units).toEqual([]);
    expect((partial?.data as { headerText?: unknown }).headerText).toBeUndefined();

    const [complete] = await localeWrites(ref, voiceSelect, nodes.map(translated), options);
    expect(complete?.units).toEqual(['headerText']);
    expect((complete?.data as { headerText: unknown }).headerText).toEqual(voiceSelect.headerText.en);
  });

  test('rich text that does not convert is rejected, not written', async () => {
    const ref = { collection: 'voice-select-screens', id: voiceSelect._id };
    const broken: LexicalCodec = { ...identity, fromHtml: () => undefined };
    const options = { sourceLocale: 'en', targetLocales: ['de'], fields: voiceFields, codec: broken, ignore: ['revision'] };
    const resources = asPush(await documentToResources(ref, voiceSelect, { ...options, codec: identity }));
    const [write] = await localeWrites(ref, voiceSelect, resources, options);
    expect(write?.rejected.map((rejection) => rejection.key)).toEqual(resources.filter((resource) => resource.meta.kind === 'richText').map((resource) => resource.key));
    // The tree is not rewritten at all; the text field still applies (to the same value).
    expect(write?.units).toEqual(['voicePartnershipText']);
    expect(write?.unchanged).toBe(true);
  });
});
