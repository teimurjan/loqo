import { describe, expect, test } from 'bun:test';
import { applyTranslations, createClient, defineAdapter, foldTranslations, importResources, type PushResource, syncRemote, type TranslationRow } from '../src';

const project = { id: 'p', slug: 'cms', name: 'CMS', sourceLocale: 'en', targetLocales: ['de'], glossary: [], extraInstructions: {}, debounceSeconds: 0, counts: { resources: 0, targets: {} } };

const row = (overrides: Partial<TranslationRow>): TranslationRow => ({
  id: 't1',
  key: 'pages/1:title',
  source: 'Home',
  tags: ['collection:pages', 'text'],
  meta: {},
  translatable: true,
  locale: 'de',
  value: 'Start',
  status: 'translated',
  origin: 'machine',
  pinned: false,
  native: false,
  updatedAt: '2026-09-17T10:00:00.000Z',
  ...overrides,
});

/** A platform that answers from a script and records what it was asked. */
const fakePlatform = (pages: TranslationRow[][]) => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, body });
    if (url.endsWith('/api/projects/cms')) return Response.json(project);
    if (url.endsWith('/import')) return Response.json({ pulled: body.resources.length, created: 1, updated: 0, unchanged: 0, removed: 0, legacyImported: 0, legacyRejected: 0, pinned: 0, enqueued: 1, duplicates: [] });
    if (url.includes('/translations')) {
      const page = Number(new URL(url).searchParams.get('page'));
      return Response.json({ page, limit: 500, hasMore: page < pages.length, docs: pages[page - 1] ?? [] });
    }
    if (url.includes('/counts')) return Response.json({ groups: { 'collection:pages': { translated: 3, pending: 1 } } });
    if (url.includes('/status')) return Response.json({ counts: { translated: 3, pending: 1 }, digest: 'd1' });
    if (url.endsWith('/translate')) return Response.json({ enqueued: 1 });
    if (url.endsWith('/missing')) return Response.json({ error: 'project not found' }, { status: 404 });
    return new Response('nope', { status: 500 });
  };
  return { calls, client: createClient({ baseUrl: 'http://platform/', apiKey: 'k', fetch: fetchImpl }) };
};

describe('client', () => {
  test('sends the bearer key, encodes queries, maps failures to a result instead of throwing', async () => {
    const { calls, client } = fakePlatform([[]]);
    const since = new Date('2026-09-17T09:00:00.000Z');
    expect((await client.translations('cms', { updatedSince: since, page: 1 })).ok).toBe(true);
    expect(calls[0]?.url).toBe('http://platform/api/projects/cms/translations?updatedSince=2026-09-17T09%3A00%3A00.000Z&page=1');

    const failed = await createClient({ baseUrl: 'http://platform', apiKey: 'k', fetch: async () => Response.json({ error: 'project not found' }, { status: 404 }) }).project('missing');
    expect(failed).toEqual({ ok: false, error: { status: 404, message: 'project not found', details: undefined } });

    const offline = await createClient({ baseUrl: 'http://platform', apiKey: 'k', fetch: async () => { throw new Error('ECONNREFUSED'); } }).project('cms');
    expect(offline).toMatchObject({ ok: false, error: { status: 0, message: 'ECONNREFUSED' } });
  });
});

describe('remote sync', () => {
  test('foldTranslations groups rows per resource and drops empty values', () => {
    const folded = foldTranslations([row({}), row({ locale: 'fr', value: 'Accueil', id: 't2' }), row({ key: 'pages/1:body', value: null })]);
    expect(folded).toHaveLength(1);
    expect(folded[0]?.targets).toEqual({
      de: { value: 'Start', status: 'translated', origin: 'machine', pinned: false, native: false },
      fr: { value: 'Accueil', status: 'translated', origin: 'machine', pinned: false, native: false },
    });
  });

  test('importResources pulls in-app and posts to /import with the prune options', async () => {
    const { calls, client } = fakePlatform([[]]);
    const adapter = defineAdapter({ name: 'fake', pull: async () => ({ resources: [{ key: 'pages/1:title', source: 'Home' }] }) });
    const result = await importResources(client, 'cms', adapter, { prunePrefix: 'pages/1:' });
    expect(result.ok && result.data.enqueued).toBe(1);
    expect(calls[1]).toMatchObject({ method: 'POST', body: { resources: [{ key: 'pages/1:title', source: 'Home' }], prunePrefix: 'pages/1:' } });
  });

  test('applyTranslations pages through /translations, folds, pushes, and reports the newest updatedAt', async () => {
    const pushed: PushResource[][] = [];
    const { calls, client } = fakePlatform([[row({})], [row({ key: 'pages/1:body', value: 'Text', updatedAt: '2026-09-17T11:00:00.000Z' })]]);
    const adapter = defineAdapter({ name: 'fake', push: async (_ctx, resources) => { pushed.push(resources); return { written: resources.length }; } });
    const result = await applyTranslations(client, 'cms', adapter, { updatedSince: '2026-09-17T00:00:00.000Z', prefix: 'pages/1:' });
    expect(result).toEqual({ ok: true, data: { pushed: { written: 2 }, resources: 2, latestUpdatedAt: '2026-09-17T11:00:00.000Z' } });
    expect(pushed[0]?.map((resource) => resource.key)).toEqual(['pages/1:title', 'pages/1:body']);
    expect(new URL(calls[1]?.url ?? '').searchParams.get('prefix')).toBe('pages/1:');
  });

  test('counts asks for one grouping and passes the filters through', async () => {
    const { calls, client } = fakePlatform([[]]);
    const result = await client.counts('cms', { by: 'tag', tagPrefix: 'collection:' });
    expect(result.ok && result.data.groups['collection:pages']).toEqual({ translated: 3, pending: 1 });
    expect(calls[0]?.url).toBe('http://platform/api/projects/cms/counts?by=tag&tagPrefix=collection%3A');
  });

  test('status and translate take a scope: tags travel comma-joined in the query, as a list in the body', async () => {
    const { calls, client } = fakePlatform([[]]);
    const scope = { tags: ['collection:app-translations', 'ios'] };
    expect(await client.status('cms', scope)).toEqual({ ok: true, data: { counts: { translated: 3, pending: 1 }, digest: 'd1' } });
    expect(calls[0]?.url).toBe('http://platform/api/projects/cms/status?tags=collection%3Aapp-translations%2Cios');
    expect(await client.translate('cms', scope)).toEqual({ ok: true, data: { enqueued: 1 } });
    expect(calls[1]).toMatchObject({ method: 'POST', url: 'http://platform/api/projects/cms/translate', body: scope });
  });

  test('a half the adapter lacks is a typed failure; syncRemote chains both halves', async () => {
    const { client } = fakePlatform([[]]);
    const pullOnly = defineAdapter({ name: 'pull-only', pull: async () => ({ resources: [] }) });
    expect(await applyTranslations(client, 'cms', pullOnly)).toMatchObject({ ok: false, error: { status: 422 } });
    const both = defineAdapter({ name: 'both', pull: async () => ({ resources: [] }), push: async () => ({ written: 0 }) });
    const synced = await syncRemote(client, 'cms', both, { prune: true });
    expect(synced.ok && synced.data.applied.pushed).toEqual({ written: 0 });
  });
});
