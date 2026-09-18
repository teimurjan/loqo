import { describe, expect, test } from 'bun:test';
import { lexicalEditor } from '@payloadcms/richtext-lexical';
import { buildConfig } from 'payload';
import { lexicalHtml } from '../src/lexical';
import { extractRichText, htmlToNode, type LexicalNode, restoreFromSource } from '../src/rich-text';

/**
 * The real codec, built the way the plugin builds it: from a sanitized Payload config. No database
 * is needed for that, so this is the Lexical half of the zero-diff spike.
 */
const config = await buildConfig({
  secret: 'test',
  db: { init: () => ({}) } as never,
  editor: lexicalEditor(),
  collections: [{ slug: 'pages', fields: [{ name: 'body', type: 'richText', localized: true }] }],
  localization: { locales: ['en', 'de'], defaultLocale: 'en' },
});
const codec = await lexicalHtml({ config } as never);

const text = (value: string, format = 0) => ({ detail: 0, format, mode: 'normal', style: '', text: value, type: 'text', version: 1 });

const heading: LexicalNode = {
  children: [
    text('Read '),
    {
      children: [text('faster', 1)],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'link',
      version: 3,
      fields: { linkType: 'internal', newTab: true, doc: { relationTo: 'pages', value: '68a1b2c3d4e5f60718293a4b' } },
      id: '6aab7f3e6b101f2fc6c33d80',
    },
    text(' today.\nReally.'),
  ],
  direction: 'ltr',
  format: 'center',
  indent: 0,
  type: 'heading',
  version: 1,
  tag: 'h1',
};

const root = { type: 'root', format: '', indent: 0, version: 1, direction: 'ltr', children: [heading, { ...heading, type: 'collapsible-title', tag: undefined }] };

describe('lexicalHtml', () => {
  test('a heading with a link and a newline survives the round trip, with the link restored from the source', async () => {
    const [field] = await extractRichText(root, ['body', 'root'], codec);
    expect(field?.value).toBe('<h1 style="text-align: center;">Read <a href="#pages/68a1b2c3d4e5f60718293a4b" rel="noopener noreferrer" target="_blank"><strong>faster</strong></a> today.\nReally.</h1>');

    const back = await htmlToNode(field!.value, undefined, codec);
    const { direction: _sourceDirection, ...expected } = heading;
    const { direction, ...actual } = restoreFromSource(back!, heading);
    // `direction` is the one thing the parser does not carry: it comes back `null` and Lexical recomputes it.
    expect(direction).toBeNull();
    expect(actual).toEqual({ ...expected, children: expected.children!.map((child) => (child.type === 'link' ? { ...child, direction: null } : child)) });
  });

  test('links are matched by href, not position: a translation may move, reorder or lose one', async () => {
    const link = (href: string, label: string, id: string): LexicalNode => ({
      children: [text(label)],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'link',
      version: 3,
      fields: { linkType: 'custom', newTab: true, url: href },
      id,
    });
    const source: LexicalNode = { ...heading, format: 'start', indent: 1, children: [link('https://a.example', 'A', 'id-a'), text(' then '), link('https://b.example', 'B', 'id-b'), text(' and '), link('https://a.example', 'A again', 'id-a2')] };
    // The model put words first and swapped the two links; one of the duplicates is gone.
    const translated = await htmlToNode('<h1>Zuerst <a href="https://b.example">B</a>, dann <a href="https://a.example">A</a>, und <a href="https://c.example">C</a></h1>', undefined, codec);
    const restored = restoreFromSource(translated!, source);
    expect([restored.format, restored.indent]).toEqual(['start', 1]);
    const links = (restored.children ?? []).filter((child) => child.type === 'link');
    expect(links.map((node) => [node.id, (node.fields as { url: string }).url, (node.fields as { newTab?: boolean }).newTab])).toEqual([
      ['id-b', 'https://b.example', true],
      ['id-a', 'https://a.example', true],
      [links[2]?.id, 'https://c.example', false],
    ]);
  });

  test('a list item with links stays one item, and newlines inside tags are not text', async () => {
    const item = (children: LexicalNode[]): LexicalNode => ({ children, direction: 'ltr', format: '', indent: 0, type: 'listitem', version: 1, value: 1 });
    const link = (href: string, label: string): LexicalNode => ({ children: [text(label, 8)], direction: 'ltr', format: '', indent: 0, type: 'link', version: 3, fields: { linkType: 'custom', newTab: false, url: href } });
    const list: LexicalNode = {
      children: [item([link('https://a.example', 'Gmail'), text(': search, draft and send '), link('https://b.example', 'emails')]), item([text('Plain item')])],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'list',
      version: 1,
      listType: 'bullet',
      start: 1,
      tag: 'ul',
    };
    const [field] = await extractRichText(list, ['body', 'root'], codec);
    expect(field?.value).toContain('\n'); // the converter formats <li> across lines; that is markup, not text
    const back = await htmlToNode(field!.value, undefined, codec);
    expect(back?.children?.map((node) => node.children?.map((child) => child.type))).toEqual([['link', 'text', 'link'], ['text']]);
  });

  test('collapsible-title travels as a paragraph and gets its type back', async () => {
    const fields = await extractRichText(root, ['body', 'root'], codec);
    expect(fields[1]).toMatchObject({ path: ['body', 'root', 'children', 1], meta: { subType: 'collapsible-title' } });
    expect(fields[1]?.value.startsWith('<p')).toBe(true);
    const back = await htmlToNode(fields[1]!.value, 'collapsible-title', codec);
    expect(back?.type).toBe('collapsible-title');
  });

  test('a text node\'s `$` (size, transform, color) survives the round trip, and keeps runs apart that would otherwise merge', async () => {
    const styled = (value: string, state: Record<string, string>, format = 0) => ({ ...text(value, format), $: state });
    const source: LexicalNode = {
      ...heading,
      children: [styled('Text to ', { size: 'headingSubtitle', transform: 'uppercase' }), styled('Speech', { size: 'headingSubtitle', transform: 'uppercase' }, 1), text(' for '), styled('everyone', { color: 'blue' }), text('.')],
    };
    const [field] = await extractRichText({ ...root, children: [source] }, ['body', 'root'], codec);
    expect(field?.value).toBe(
      '<h1 style="text-align: center;"><span data-s="size=headingSubtitle;transform=uppercase">Text to </span><span data-s="size=headingSubtitle;transform=uppercase"><strong>Speech</strong></span> for <span data-s="color=blue">everyone</span>.</h1>',
    );
    const back = await htmlToNode(field!.value, undefined, codec);
    expect(back?.children).toEqual(source.children);

    // The model may keep a span around words it moved; whatever is inside gets the state, the rest does not.
    const translated = await htmlToNode('<h1>Für <span data-s="color=blue">alle</span>: <span data-s="size=h2"><strong>Sprache</strong> aus Text</span></h1>', undefined, codec);
    expect(translated?.children?.map((child) => [child.text, child.format, child.$])).toEqual([
      ['Für ', 0, undefined],
      ['alle', 0, { color: 'blue' }],
      [': ', 0, undefined],
      ['Sprache', 1, { size: 'h2' }],
      [' aus Text', 0, { size: 'h2' }],
    ]);
  });

  test('HTML that is not a block yields nothing, so the target is rejected rather than written', async () => {
    expect(await codec.fromHtml('')).toBeUndefined();
  });
});
