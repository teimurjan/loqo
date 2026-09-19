import {
  type Adapter,
  type ApiResult,
  applyTranslations,
  type ApplyResult,
  type ClientOptions,
  createClient,
  importResources,
  type LoqoClient,
  type ScopeStatus,
  type StatusCounts,
  type SyncSummary,
  syncRemote,
  type SyncRemoteResult,
} from '@loqo/sdk';
import type { Payload, Where } from 'payload';
import { type PayloadAdapterOptions, payloadAdapter, pullCollection, pullDocument } from './adapter';
import { type DocumentRef, documentPrefix, entityTag } from './keys';
import type { LexicalCodec } from './rich-text';

export type ServiceOptions = Omit<PayloadAdapterOptions, 'codec'> & {
  /** A client, or what to build one from. */
  client: LoqoClient | ClientOptions;
  /** The platform project's slug. */
  project: string;
  collections: readonly string[];
  /** Defaults to the app's own Lexical editor config (`@loqo/payload/lexical`). */
  codec?: (payload: Payload) => Promise<LexicalCodec>;
};

export type DocumentStatus = { locales: Record<string, StatusCounts> };

/**
 * A collection, or the part of it `where` selects, with the `tags` that name that part on the
 * platform (a `product`, say) — the unit a store that writes Payload behind its back re-syncs.
 * `where` and `tags` must describe the same documents: an import prunes everything under the tags
 * that the `where` did not return.
 */
export type CollectionScope = { collection: string; where?: Where; tags?: readonly string[] };

const scopeTags = (scope: CollectionScope): string[] => [entityTag(scope), ...(scope.tags ?? [])];

/** One row per collection or global listed: how many of its targets are in each status. */
export type ProjectStatus = {
  project: { slug: string; sourceLocale: string; targetLocales: string[]; counts: StatusCounts };
  collections: { slug: string; applied: boolean; counts: StatusCounts }[];
  globals: { slug: string; applied: boolean; counts: StatusCounts }[];
};

const isClient = (client: LoqoClient | ClientOptions): client is LoqoClient => typeof (client as LoqoClient).import === 'function';

/**
 * What the plugin does, without Payload's wiring: the hooks, the endpoints and the admin
 * components all go through here. One instance per plugin, one adapter per `Payload` instance.
 */
export const createService = (options: ServiceOptions) => {
  const client = isClient(options.client) ? options.client : createClient(options.client);
  const codecs = new WeakMap<Payload, Promise<LexicalCodec>>();
  const globals = options.globals ?? [];
  const applied = { collections: options.applyTo?.collections ?? options.collections, globals: options.applyTo?.globals ?? globals };

  const codecFor = (payload: Payload): Promise<LexicalCodec> => {
    const cached = codecs.get(payload);
    if (cached) return cached;
    const created = (options.codec ?? ((instance: Payload) => import('./lexical').then((module) => module.lexicalHtml(instance))))(payload);
    codecs.set(payload, created);
    return created;
  };

  const adapterOptions = async (payload: Payload): Promise<PayloadAdapterOptions> => ({
    collections: options.collections,
    globals,
    codec: await codecFor(payload),
    ignore: options.ignore,
    disableField: options.disableField,
    describe: options.describe,
    applyTo: options.applyTo,
    pageSize: options.pageSize,
  });

  const adapterFor = async (payload: Payload): Promise<Adapter> => payloadAdapter(payload, await adapterOptions(payload));

  /** One document's resources, pruned under its prefix — or, after a delete, nothing under it. */
  const importDocument = async (payload: Payload, ref: DocumentRef, { deleted = false, enqueue }: { deleted?: boolean; enqueue?: boolean } = {}): Promise<ApiResult<SyncSummary>> => {
    const prunePrefix = documentPrefix(ref);
    const one: Adapter = { name: 'payload', pull: async ({ project }) => ({ resources: deleted ? [] : await pullDocument(payload, ref, project, await adapterOptions(payload)) }) };
    return importResources(client, options.project, one, { prunePrefix, enqueue });
  };

  /**
   * One collection's resources (or one `where`'s worth), pruned under its tags — for a store that
   * writes documents without Payload's hooks (a bulk import straight into the database), where
   * `afterChange` never fires. What is already translated at the current source is left alone.
   */
  const importCollection = async (payload: Payload, scope: CollectionScope, { enqueue }: { enqueue?: boolean } = {}): Promise<ApiResult<SyncSummary>> => {
    const one: Adapter = { name: 'payload', pull: async ({ project }) => ({ resources: await pullCollection(payload, scope.collection, project, await adapterOptions(payload), scope.where) }) };
    return importResources(client, options.project, one, { pruneTags: scopeTags(scope), enqueue });
  };

  /** Translations of one document, written back now rather than on the next sync. */
  const applyDocument = async (payload: Payload, ref: DocumentRef): Promise<ApiResult<ApplyResult>> =>
    applyTranslations(client, options.project, await adapterFor(payload), { prefix: documentPrefix(ref) });

  const documentStatus = async (ref: DocumentRef): Promise<ApiResult<DocumentStatus>> => {
    const counts = await client.counts(options.project, { by: 'locale', prefix: documentPrefix(ref) });
    return counts.ok ? { ok: true, data: { locales: counts.data.groups } } : counts;
  };

  const status = async (): Promise<ApiResult<ProjectStatus>> => {
    const [project, byCollection, byGlobal] = await Promise.all([
      client.project(options.project),
      client.counts(options.project, { by: 'tag', tagPrefix: 'collection:' }),
      client.counts(options.project, { by: 'tag', tagPrefix: 'global:' }),
    ]);
    if (!project.ok) return project;
    if (!byCollection.ok) return byCollection;
    if (!byGlobal.ok) return byGlobal;
    return {
      ok: true,
      data: {
        project: { slug: project.data.slug, sourceLocale: project.data.sourceLocale, targetLocales: project.data.targetLocales, counts: project.data.counts.targets },
        collections: options.collections.map((slug) => ({ slug, applied: applied.collections.includes(slug), counts: byCollection.data.groups[`collection:${slug}`] ?? {} })),
        globals: globals.map((slug) => ({ slug, applied: applied.globals.includes(slug), counts: byGlobal.data.groups[`global:${slug}`] ?? {} })),
      },
    };
  };

  const importAll = async (payload: Payload): Promise<ApiResult<SyncSummary>> => importResources(client, options.project, await adapterFor(payload), { prune: true });

  const sync = async (payload: Payload, since?: string): Promise<ApiResult<SyncRemoteResult>> =>
    syncRemote(client, options.project, await adapterFor(payload), { prune: true, updatedSince: since });

  /** Queues what is missing, stale, rejected or failed — never a translated value — in the whole project or one scope. */
  const translate = (scope?: CollectionScope): Promise<ApiResult<{ enqueued: number }>> => client.translate(options.project, scope ? { tags: scopeTags(scope) } : {});

  const scopeStatus = (scope: CollectionScope): Promise<ApiResult<ScopeStatus>> => client.status(options.project, { tags: scopeTags(scope) });

  return { client, importDocument, importCollection, applyDocument, documentStatus, scopeStatus, status, importAll, sync, translate };
};

export type LoqoService = ReturnType<typeof createService>;
