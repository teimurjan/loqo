import { describe, expect, test } from 'bun:test';
import { createClient } from '@opendeepl/sdk';
import type { CollectionAfterChangeHook, CollectionAfterDeleteHook, Config, Payload, PayloadRequest } from 'payload';
import { OPENDEEPL_CONTEXT, payloadAdapter } from '../src/adapter';
import { opendeeplPlugin, opendeeplServiceOf } from '../src/plugin';
import type { LexicalCodec } from '../src/rich-text';

const identity: LexicalCodec = { toHtml: (node) => JSON.stringify(node), fromHtml: (html) => JSON.parse(html) };

const paragraph = (value: string) => ({ children: [{ type: 'text', text: value, version: 1 }], type: 'paragraph', version: 1 });

/** Two pages and a global, as `locale: 'all'` returns them, behind a local API that records writes. */
const fakePayload = () => {
  const pages = [
    { id: 'p1', _status: 'published', title: { en: 'Home', de: 'Start' }, body: { en: { root: { type: 'root', children: [paragraph('Hi')] } } }, hero: { en: 'a1b2c3d4e5f6a1b2c3d4e5f6' } },
    { id: 'p2', _status: 'draft', title: { en: 'Draft' } },
  ];
  const header = { nav: [{ id: 'n1', label: { en: 'Docs', de: 'Doku' } }] };
  const writes: unknown[] = [];
  const payload = {
    config: {
      localization: { defaultLocale: 'en', locales: ['en', 'de'] },
      collections: [{ slug: 'pages', fields: [{ name: 'title', type: 'text', localized: true, maxLength: 60 }, { name: 'body', type: 'richText', localized: true }, { name: 'hero', type: 'upload', localized: true }] }],
      globals: [{ slug: 'header', fields: [{ name: 'nav', type: 'array', fields: [{ name: 'label', type: 'text', localized: true }] }] }],
    },
    find: async ({ page }: { page: number }) => ({ docs: page === 1 ? pages : [], hasNextPage: false }),
    findByID: async ({ id }: { id: string }) => pages.find((page) => page.id === id) ?? null,
    findGlobal: async () => header,
    update: async (args: unknown) => void writes.push(args),
    updateGlobal: async (args: unknown) => void writes.push(args),
  };
  return { payload: payload as unknown as Payload, writes };
};

const project = { slug: 'cms', name: 'CMS', sourceLocale: 'en', targetLocales: ['de'] };

describe('payloadAdapter', () => {
  test('pull: published documents and globals become prefixed resources; drafts and uploads do not', async () => {
    const { payload } = fakePayload();
    const adapter = payloadAdapter(payload, { collections: ['pages'], globals: ['header'], codec: identity });
    const { resources } = await adapter.pull!({ project });
    expect(resources.map((resource) => resource.key)).toEqual(['pages/p1:title', 'pages/p1:body.root.children.0', 'globals/header:nav.0.label']);
    expect(resources[0]).toMatchObject({ source: 'Home', tags: ['collection:pages', 'text'], meta: { path: 'title', kind: 'text', maxLength: 60 }, targets: { de: { value: 'Start' } } });
    expect(resources[2]?.targets).toEqual({ de: { value: 'Doku' } });
  });

  test('describe: a document says which scenario it belongs to and what prompts may read off it', async () => {
    const strings = [
      { id: 's1', key: JSON.stringify({ filePath: 'Localizable.xcstrings', key: '%lld items', quantity: 'one' }), value: { en: '%lld item' }, product: 'ios', comment: 'Library count' },
      { id: 's2', key: 'library.count', value: { en: 'Items' }, product: 'webapp' },
    ];
    const payload = {
      config: {
        localization: { defaultLocale: 'en', locales: ['en', 'de'] },
        collections: [{ slug: 'app-translations', fields: [{ name: 'key', type: 'text' }, { name: 'value', type: 'text', localized: true, maxLength: 80 }, { name: 'product', type: 'text' }, { name: 'comment', type: 'text' }] }],
        globals: [],
      },
      find: async ({ page }: { page: number }) => ({ docs: page === 1 ? strings : [], hasNextPage: false }),
    } as unknown as Payload;
    const adapter = payloadAdapter(payload, {
      collections: ['app-translations'],
      codec: identity,
      describe: (ref, document) => {
        const doc = document as { key: string; product: string; comment?: string };
        if (!('collection' in ref) || ref.collection !== 'app-translations' || doc.product === 'webapp') return undefined;
        const parsed = JSON.parse(doc.key) as { quantity?: string };
        return { tags: [doc.product, parsed.quantity ? 'plural' : 'string', 'text'], meta: { ...parsed, comment: doc.comment, maxLength: 999 } };
      },
    });
    const { resources } = await adapter.pull!({ project });
    expect(resources[0]).toMatchObject({
      key: 'app-translations/s1:value',
      tags: ['collection:app-translations', 'text', 'ios', 'plural'],
      meta: { path: 'value', kind: 'text', filePath: 'Localizable.xcstrings', key: '%lld items', quantity: 'one', comment: 'Library count', maxLength: 80 },
    });
    expect(resources[1]).toMatchObject({ tags: ['collection:app-translations', 'text'], meta: { path: 'value', kind: 'text', maxLength: 80 } });
  });

  test('push: writes each changed locale through the local API, marked as its own, and skips the unchanged', async () => {
    const { payload, writes } = fakePayload();
    const adapter = payloadAdapter(payload, { collections: ['pages'], globals: ['header'], codec: identity });
    const target = (value: string) => ({ value, status: 'translated', origin: 'machine', pinned: false, native: false });
    const result = await adapter.push!({ project }, [
      { key: 'pages/p1:title', source: 'Home', tags: [], meta: { path: 'title', kind: 'text' }, translatable: true, targets: { de: target('Startseite') } },
      { key: 'pages/p1:body.root.children.0', source: '', tags: [], meta: { path: 'body.root.children.0', kind: 'richText' }, translatable: true, targets: { de: target(JSON.stringify(paragraph('Hallo'))) } },
      { key: 'globals/header:nav.0.label', source: 'Docs', tags: [], meta: { path: 'nav.0.label', kind: 'text' }, translatable: true, targets: { de: target('Doku') } },
      { key: 'pages/gone:title', source: 'x', tags: [], meta: { path: 'title', kind: 'text' }, translatable: true, targets: { de: target('y') } },
    ]);
    expect(result).toEqual({ written: 2, rejected: [{ key: 'pages/gone:title', locale: 'de', reason: 'document no longer exists' }] });
    expect(writes).toEqual([
      {
        collection: 'pages',
        id: 'p1',
        locale: 'de',
        depth: 0,
        autosave: true,
        overrideAccess: true,
        context: { [OPENDEEPL_CONTEXT]: true },
        data: { id: 'p1', _status: 'published', title: 'Startseite', body: { root: { type: 'root', children: [paragraph('Hallo')] } }, hero: undefined },
      },
    ]);
  });

  test('applyTo: everything listed is pulled, only the entities moved over are written', async () => {
    const { payload, writes } = fakePayload();
    const adapter = payloadAdapter(payload, { collections: ['pages'], globals: ['header'], codec: identity, applyTo: { collections: [] } });
    const target = (value: string) => ({ value, status: 'translated', origin: 'machine', pinned: false, native: false });
    expect((await adapter.pull!({ project })).resources).toHaveLength(3);
    const result = await adapter.push!({ project }, [
      { key: 'pages/p1:title', source: 'Home', tags: [], meta: { path: 'title', kind: 'text' }, translatable: true, targets: { de: target('Startseite') } },
      { key: 'globals/header:nav.0.label', source: 'Docs', tags: [], meta: { path: 'nav.0.label', kind: 'text' }, translatable: true, targets: { de: target('Doku 2') } },
    ]);
    expect(result).toEqual({ written: 1, rejected: [] });
    expect(writes.map((write) => (write as { slug?: string; collection?: string }).slug ?? (write as { collection: string }).collection)).toEqual(['header']);
  });
});

describe('opendeeplPlugin', () => {
  const calls: { url: string; body: unknown }[] = [];
  const client = createClient({
    baseUrl: 'http://platform',
    apiKey: 'k',
    fetch: async (url, init) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/api/projects/cms')) return Response.json({ ...project, id: '1', glossary: [], extraInstructions: {}, debounceSeconds: 0 });
      if (url.includes('/translate')) return Response.json({ enqueued: 2 });
      if (url.includes('/status?')) return Response.json({ counts: { translated: 4, queued: 1 }, digest: 'abc' });
      return Response.json({ pulled: 0, created: 0, updated: 0, unchanged: 0, removed: 0, legacyImported: 0, legacyRejected: 0, pinned: 0, enqueued: 0, duplicates: [] });
    },
  });
  const pending: Promise<unknown>[] = [];
  const plugin = opendeeplPlugin({ client, project: 'cms', collections: ['pages'], globals: ['header'], codec: async () => identity, defer: (work) => void pending.push(work) });
  const base: Config = { secret: 's', db: {} as never, collections: [{ slug: 'pages', fields: [] }, { slug: 'media', fields: [] }], globals: [{ slug: 'header', fields: [] }] };

  test('hooks and controls land only on the listed collections and globals; endpoints and the status view are added', async () => {
    const config = await plugin(base);
    expect(config.collections?.map((collection) => (collection.hooks?.afterChange ?? []).length)).toEqual([1, 0]);
    expect(config.globals?.map((global) => (global.hooks?.afterChange ?? []).length)).toEqual([1]);
    expect(config.collections?.map((collection) => collection.admin?.components?.edit?.beforeDocumentControls)).toEqual([['@opendeepl/payload/client#TranslateControls'], undefined]);
    expect(config.globals?.[0]?.admin?.components?.elements?.beforeDocumentControls).toEqual(['@opendeepl/payload/client#TranslateControls']);
    expect(config.admin?.components?.views?.opendeepl).toEqual({ Component: '@opendeepl/payload/rsc#TranslationStatusView', path: '/opendeepl' });
    expect(config.endpoints?.map((endpoint) => `${endpoint.method} ${endpoint.path}`)).toEqual([
      'get /opendeepl/status',
      'post /opendeepl/import',
      'post /opendeepl/sync',
      'post /opendeepl/translate',
      'get /opendeepl/collections/:slug/:id/status',
      'post /opendeepl/collections/:slug/:id/translate',
      'post /opendeepl/collections/:slug/:id/apply',
      'get /opendeepl/globals/:slug/status',
      'post /opendeepl/globals/:slug/translate',
      'post /opendeepl/globals/:slug/apply',
    ]);

    const bare = await opendeeplPlugin({ client, project: 'cms', collections: ['pages'], codec: async () => identity, admin: false })(base);
    expect(bare.collections?.[0]?.admin).toBeUndefined();
    expect(bare.admin?.components?.views).toBeUndefined();
  });

  test('a source-locale save re-imports that document under its prefix; the adapter’s own writes and other locales do not', async () => {
    const { payload } = fakePayload();
    const config = await plugin(base);
    const afterChange = config.collections?.[0]?.hooks?.afterChange?.[0] as CollectionAfterChangeHook;
    const req = (locale: string, context: Record<string, unknown> = {}) => ({ payload, locale, context } as unknown as PayloadRequest);
    const args = { collection: { slug: 'pages' }, doc: { id: 'p1', _status: 'published' }, previousDoc: {}, data: {}, operation: 'update' as const, context: {} };

    afterChange({ ...args, req: req('en') } as never);
    afterChange({ ...args, req: req('de') } as never);
    afterChange({ ...args, req: req('en', { [OPENDEEPL_CONTEXT]: true }) } as never);
    afterChange({ ...args, doc: { id: 'p2', _status: 'draft' }, req: req('en') } as never);
    await Promise.all(pending);
    const imports = calls.filter((call) => call.url.endsWith('/import'));
    expect(imports).toHaveLength(1);
    expect(imports[0]?.body).toMatchObject({ prunePrefix: 'pages/p1:', resources: [{ key: 'pages/p1:title' }, { key: 'pages/p1:body.root.children.0' }] });

    const afterDelete = config.collections?.[0]?.hooks?.afterDelete?.[0] as CollectionAfterDeleteHook;
    afterDelete({ collection: { slug: 'pages' }, doc: { id: 'p1' }, id: 'p1', req: req('en'), context: {} } as never);
    await Promise.all(pending);
    expect(calls.at(-1)?.body).toEqual({ resources: [], prunePrefix: 'pages/p1:' });
  });

  test('a document endpoint answers with the platform result, and only to a user or the secret', async () => {
    calls.length = 0;
    const { payload } = fakePayload();
    const config = await opendeeplPlugin({ client, project: 'cms', collections: ['pages'], codec: async () => identity, secret: 'cron' })(base);
    const translate = config.endpoints?.find((endpoint) => endpoint.path === '/opendeepl/collections/:slug/:id/translate');
    const request = (headers: Record<string, string>, user: unknown = null) =>
      ({ payload, user, headers: new Headers(headers), routeParams: { slug: 'pages', id: 'p1' } }) as unknown as PayloadRequest;
    expect((await translate!.handler(request({}))).status).toBe(401);
    const response = await translate!.handler(request({ authorization: 'Bearer cron' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enqueued: 0 });
    expect(calls.at(-1)?.body).toMatchObject({ prunePrefix: 'pages/p1:', resources: [{ key: 'pages/p1:title' }, { key: 'pages/p1:body.root.children.0' }] });
  });

  test('a collection scope re-imports what a `where` selects, pruned under its tags, then translates and reports only that scope', async () => {
    calls.length = 0;
    const finds: unknown[] = [];
    const strings = [
      { id: 's1', value: { en: 'One', de: 'Eins' }, product: 'ios' },
      { id: 's2', value: { en: 'Two' }, product: 'ios' },
    ];
    const payload = {
      config: {
        localization: { defaultLocale: 'en', locales: ['en', 'de'] },
        collections: [{ slug: 'app-translations', fields: [{ name: 'value', type: 'text', localized: true }, { name: 'product', type: 'text' }] }],
        globals: [],
        custom: {},
      },
      find: async (args: { page: number; where?: unknown }) => {
        finds.push(args.where);
        return { docs: args.page === 1 ? strings : [], hasNextPage: false };
      },
    } as unknown as Payload;
    const config = await opendeeplPlugin({ client, project: 'cms', collections: ['app-translations'], codec: async () => identity, describe: (_ref, doc) => ({ tags: [(doc as { product: string }).product] }) })(base);
    (payload.config as { custom?: unknown }).custom = config.custom;
    const service = opendeeplServiceOf(payload);
    const scope = { collection: 'app-translations', where: { product: { equals: 'ios' } }, tags: ['ios'] };

    expect((await service.importCollection(payload, scope, { enqueue: false })).ok).toBe(true);
    expect(finds).toEqual([{ product: { equals: 'ios' } }]);
    expect(calls.at(-1)?.body).toEqual({
      resources: [
        { key: 'app-translations/s1:value', source: 'One', tags: ['collection:app-translations', 'text', 'ios'], meta: { path: 'value', kind: 'text' }, translatable: true, targets: { de: { value: 'Eins' } } },
        { key: 'app-translations/s2:value', source: 'Two', tags: ['collection:app-translations', 'text', 'ios'], meta: { path: 'value', kind: 'text' }, translatable: true, targets: {} },
      ],
      pruneTags: ['collection:app-translations', 'ios'],
      enqueue: false,
    });

    expect(await service.translate(scope)).toEqual({ ok: true, data: { enqueued: 2 } });
    expect(calls.at(-1)).toEqual({ url: 'http://platform/api/projects/cms/translate', body: { tags: ['collection:app-translations', 'ios'] } });

    expect(await service.scopeStatus(scope)).toEqual({ ok: true, data: { counts: { translated: 4, queued: 1 }, digest: 'abc' } });
    expect(calls.at(-1)?.url).toBe('http://platform/api/projects/cms/status?tags=collection%3Aapp-translations%2Cios');

    expect(() => opendeeplServiceOf({ config: { custom: {} } } as unknown as Payload)).toThrow('opendeeplPlugin is not installed');
  });
});
