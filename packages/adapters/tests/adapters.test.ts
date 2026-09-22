import { describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pulledTarget } from '@loqo/sdk';
import { androidXml, parseAndroidResources } from '../src/android-xml';
import { compositeKey, discoverFiles, globToRegExp } from '../src/files';
import { xcstrings } from '../src/xcstrings';

const fixtures = join(import.meta.dir, 'fixtures');
const scratch = () => mkdtemp(join(tmpdir(), 'loqo-'));

describe('file discovery', () => {
  test('globs: ** spans directories, * stays inside a segment', () => {
    const catalog = globToRegExp('**/*.xcstrings');
    expect(catalog.test('Localizable.xcstrings')).toBe(true);
    expect(catalog.test('App/Resources/Localizable.xcstrings')).toBe(true);
    expect(catalog.test('App/Localizable.xcstrings.bak')).toBe(false);
    const strings = globToRegExp('**/values/strings.xml');
    expect(strings.test('app/src/main/res/values/strings.xml')).toBe(true);
    expect(strings.test('app/src/main/res/values-de/strings.xml')).toBe(false);
    expect(globToRegExp('src/*/en.json').test('src/a/b/en.json')).toBe(false);
  });

  test('walks the tree but never node_modules, .git or an ignored prefix', async () => {
    const root = await scratch();
    for (const path of ['App/Localizable.xcstrings', 'Tools/Localizable.xcstrings', 'node_modules/x/Localizable.xcstrings', '.git/Localizable.xcstrings']) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), '{}');
    }
    expect(await discoverFiles({ root, include: ['**/*.xcstrings'], ignore: ['Tools'] })).toEqual(['App/Localizable.xcstrings']);
  });
});

describe('xcstrings adapter', () => {
  const project = { slug: 'ios', name: 'iOS', sourceLocale: 'en', targetLocales: ['de', 'pl'] };

  test('pull: one resource per key or plural variant, placeholder-only keys dropped, legacy targets kept', async () => {
    const { resources } = await xcstrings({ root: fixtures }).pull!({ project });
    const keys = resources.map((r) => JSON.parse(r.key).key);
    expect(keys).not.toContain('%@');
    expect(resources.find((r) => JSON.parse(r.key).quantity === 'one')).toMatchObject({
      source: '%lld item',
      tags: ['ios', 'plural'],
      meta: { filePath: 'Localizable.xcstrings', key: '%lld items', quantity: 'one', comment: 'Library count', pluralSpecifiers: ['%lld'] },
      targets: { de: '%lld Element' },
    });
    expect(resources.find((r) => r.source === 'Hello')?.targets).toEqual({ de: 'Hallo' });
    expect(resources.find((r) => r.source === 'Acme')?.translatable).toBe(false);
  });

  test('push: unchanged values leave the file byte-identical, a new value is a minimal edit', async () => {
    const root = await scratch();
    await cp(join(fixtures, 'Localizable.xcstrings'), join(root, 'Localizable.xcstrings'));
    const adapter = xcstrings({ root });
    const original = await Bun.file(join(root, 'Localizable.xcstrings')).text();
    const { resources } = await adapter.pull!({ project });
    const asPush = resources.map((r) => ({
      ...r,
      tags: r.tags ?? [],
      meta: r.meta ?? {},
      translatable: r.translatable ?? true,
      targets: Object.fromEntries(
        Object.entries(r.targets ?? {}).map(([locale, value]) => [locale, { value: pulledTarget(value).value ?? '', status: 'translated', origin: 'legacy', pinned: false, native: false }]),
      ),
    }));
    expect(await adapter.push!({ project }, asPush)).toEqual({ written: 0, files: [] });
    expect(await Bun.file(join(root, 'Localizable.xcstrings')).text()).toBe(original);

    const hello = asPush.find((r) => r.source === 'Hello')!;
    hello.targets.pl = { value: 'Cześć', status: 'translated', origin: 'machine', pinned: false, native: false };
    expect((await adapter.push!({ project }, [hello])).written).toBe(1);
    const after = (await adapter.pull!({ project })).resources.find((r) => r.source === 'Hello');
    expect(after?.targets).toEqual({ de: 'Hallo', pl: 'Cześć' });
  });
});

describe('android adapter', () => {
  const project = { slug: 'android', name: 'Android', sourceLocale: 'en', targetLocales: ['de', 'pl'] };
  const root = join(fixtures, 'android');

  test('parses strings, arrays, plurals and skips comments', async () => {
    const parsed = parseAndroidResources(await Bun.file(join(root, 'app/src/main/res/values/strings.xml')).text());
    expect(parsed.map((r) => `${r.kind}:${r.name}`)).toEqual([
      'string:app_name',
      'string:quoted',
      'string:with_xliff',
      'string:cdata',
      'string-array:voices',
      'plurals:pages',
    ]);
  });

  test('pull: translatable flag, aapt quotes unwrapped, synthesized plural categories for target locales', async () => {
    const { resources } = await androidXml({ root }).pull!({ project });
    const byKey = Object.fromEntries(resources.map((r) => [r.key, r]));
    const file = 'app/src/main/res/values/strings.xml';
    expect(resources.map((r) => JSON.parse(r.key).key)).not.toContain('commented_out');
    expect(byKey[compositeKey({ filePath: file, key: 'app_name' })]?.translatable).toBe(false);
    expect(byKey[compositeKey({ filePath: file, key: 'quoted' })]?.source).toBe('  Padded  ');
    expect(byKey[compositeKey({ filePath: file, key: 'with_xliff' })]?.source).toBe('Moved <xliff:g id="count" example="5">%1$d</xliff:g> files');
    expect(byKey[compositeKey({ filePath: file, key: 'with_xliff' })]?.targets).toEqual({ de: 'Verschoben <xliff:g id="count" example="5">%1$d</xliff:g> Dateien \\"fett\\"' });
    expect(byKey[compositeKey({ filePath: file, key: 'voices', index: 1 })]?.source).toBe('Spanish');
    // Polish needs few/many; they are seeded from `other`, never from `one`.
    const few = byKey[compositeKey({ filePath: file, key: 'pages', quantity: 'few' })];
    expect(few).toMatchObject({ source: '%1$d pages', tags: ['android', 'plural', 'synthesized'], meta: { quantity: 'few', pluralSpecifiers: ['%1$d'] } });
  });

  test('push: writes values-<locale> files with escaping rules and only the locale\'s plural categories', async () => {
    const dir = await scratch();
    await cp(root, dir, { recursive: true });
    const adapter = androidXml({ root: dir });
    const { resources } = await adapter.pull!({ project });
    const target = (value: string) => ({ value, status: 'translated', origin: 'machine', pinned: false, native: false });
    const pushed = resources.map((r) => {
      const parsed = JSON.parse(r.key) as { key: string; quantity?: string; index?: number };
      const value =
        parsed.key === 'quoted' ? "  Gepolstert  " :
        parsed.key === 'with_xliff' ? 'Verschoben <xliff:g id="count" example="5">%1$d</xliff:g> Dateien <b>fett</b> 5 < 6' :
        parsed.key === 'cdata' ? '<![CDATA[<font>Fett</font> & Text]]>' :
        parsed.key === 'pages' ? `${parsed.quantity} %1$d Seiten` :
        parsed.key === 'voices' ? `Stimme ${parsed.index}` : 'x';
      return { ...r, tags: r.tags ?? [], meta: r.meta ?? {}, translatable: r.translatable ?? true, targets: { de: target(value), pl: target(value) } };
    });
    const result = await adapter.push!({ project }, pushed);
    expect(result.files).toEqual(['app/src/main/res/values-de/strings.xml', 'app/src/main/res/values-pl/strings.xml']);
    const de = await Bun.file(join(dir, 'app/src/main/res/values-de/strings.xml')).text();
    expect(de).not.toContain('app_name');
    expect(de).toContain('<string name="quoted">"  Gepolstert  "</string>');
    expect(de).toContain('<string name="with_xliff">"Verschoben <xliff:g id="count" example="5">%1$d</xliff:g> Dateien <b>fett</b> 5 &lt; 6"</string>');
    expect(de).toContain('<string name="cdata">"<![CDATA[<font>Fett</font> & Text]]>"</string>');
    expect(de).toContain('<string-array name="voices">\n    <item>"Stimme 0"</item>\n    <item>"Stimme 1"</item>');
    expect(de).toMatch(/<plurals name="pages">\n {4}<item quantity="one">"one %1\$d Seiten"<\/item>\n {4}<item quantity="other">"other %1\$d Seiten"<\/item>\n {2}<\/plurals>/);
    const pl = await Bun.file(join(dir, 'app/src/main/res/values-pl/strings.xml')).text();
    expect(pl).toContain('quantity="few"');
    expect(pl).toContain('quantity="many"');
    expect(de).not.toContain('quantity="few"');
  });
});
