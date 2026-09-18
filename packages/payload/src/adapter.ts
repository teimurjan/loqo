import { type Adapter, defineAdapter, isPlainObject, type ProjectRef, type PulledResource, type PushRejection, type PushResource } from '@opendeepl/sdk';
import type { CollectionSlug, GlobalSlug, Payload, Where } from 'payload';
import { type Describe, type DocumentOptions, documentToResources, localeWrites, rowsWithUnstableId } from './document';
import { buildFieldConfigMap, type FieldConfigMap, type FieldLike } from './fields';
import { type DocumentRef, parseResourceKey, sameDocument } from './keys';
import type { LexicalCodec } from './rich-text';

export type PayloadAdapterOptions = {
  collections?: readonly string[];
  globals?: readonly string[];
  codec: LexicalCodec;
  /** Keys never translated, at any depth (`revision`, say). Each locale keeps its own value there. */
  ignore?: readonly string[];
  /** See `DocumentOptions.disableField`; defaults to `disableTranslate`. */
  disableField?: string | null;
  /** See `DocumentOptions.describe`: per-document tags and meta, e.g. a collection's scenario tag. */
  describe?: Describe;
  /**
   * Where translations are written back. Everything listed is pulled; only these receive pushes —
   * the switch for moving one collection at a time off another engine. Defaults to everything.
   */
  applyTo?: { collections?: readonly string[]; globals?: readonly string[] };
  /** Rows per `find` page when pulling a collection. */
  pageSize?: number;
};

/** Marks the adapter's own writes so an `afterChange` hook can tell them from an editor's. */
export const OPENDEEPL_CONTEXT = 'opendeepl';

const fieldMapOf = (payload: Payload, ref: DocumentRef): FieldConfigMap => {
  const slug = 'global' in ref ? ref.global : ref.collection;
  const config = 'global' in ref ? payload.config.globals.find((global) => global.slug === slug) : payload.config.collections.find((collection) => collection.slug === slug);
  if (!config) throw new Error(`payload adapter: no ${'global' in ref ? 'global' : 'collection'} "${slug}" in the Payload config`);
  return buildFieldConfigMap(config as { fields: readonly FieldLike[] });
};

const documentOptions = (fields: FieldConfigMap, project: ProjectRef, options: PayloadAdapterOptions): DocumentOptions => ({
  sourceLocale: project.sourceLocale,
  targetLocales: project.targetLocales,
  fields,
  codec: options.codec,
  ignore: options.ignore,
  disableField: options.disableField === undefined ? 'disableTranslate' : options.disableField,
  describe: options.describe,
});

const read = (payload: Payload, ref: DocumentRef): Promise<unknown> =>
  'global' in ref
    ? payload.findGlobal({ slug: ref.global as GlobalSlug, locale: 'all', depth: 0, overrideAccess: true })
    : payload.findByID({ collection: ref.collection as CollectionSlug, id: ref.id, locale: 'all', depth: 0, overrideAccess: true, disableErrors: true });

/** One document's resources — what an `afterChange` hook re-imports. Empty when it is gone or a draft. */
export const pullDocument = async (payload: Payload, ref: DocumentRef, project: ProjectRef, options: PayloadAdapterOptions): Promise<PulledResource[]> => {
  const document = await read(payload, ref);
  if (!document || !isPublished(document)) return [];
  return documentToResources(ref, document, documentOptions(fieldMapOf(payload, ref), project, options));
};

/** Drafts are not content yet; a collection without drafts has no `_status`. */
const isPublished = (document: unknown): boolean => !isPlainObject(document) || document._status === undefined || document._status === 'published';

const idOf = (document: unknown): string | null => (isPlainObject(document) && (typeof document.id === 'string' || typeof document.id === 'number') ? String(document.id) : null);

/** A collection's resources — all of it, or the documents a `where` selects (one product's strings, say). */
export const pullCollection = async (payload: Payload, collection: string, project: ProjectRef, options: PayloadAdapterOptions, where?: Where): Promise<PulledResource[]> => {
  const fields = fieldMapOf(payload, { collection, id: '' });
  const resources: PulledResource[] = [];
  for (let page = 1; ; page += 1) {
    const result = await payload.find({ collection: collection as CollectionSlug, where, locale: 'all', depth: 0, limit: options.pageSize ?? 100, page, overrideAccess: true });
    for (const document of result.docs) {
      const id = idOf(document);
      if (id === null || !isPublished(document)) continue;
      resources.push(...(await documentToResources({ collection, id }, document, documentOptions(fields, project, options))));
    }
    if (!result.hasNextPage) break;
  }
  return resources;
};

const groupByDocument = (resources: readonly PushResource[]): { ref: DocumentRef; resources: PushResource[] }[] => {
  const groups: { ref: DocumentRef; resources: PushResource[] }[] = [];
  for (const resource of resources) {
    const parsed = parseResourceKey(resource.key);
    if (!parsed) continue;
    const group = groups.find((candidate) => sameDocument(candidate.ref, parsed.ref));
    if (group) group.resources.push(resource);
    else groups.push({ ref: parsed.ref, resources: [resource] });
  }
  return groups;
};

/**
 * Payload documents in, translations back — through the local API, so access control, hooks and
 * versions behave as they do for an editor. Runs wherever `payload` does: inside the app.
 */
export const payloadAdapter = (payload: Payload, options: PayloadAdapterOptions): Adapter => {
  const collections = options.collections ?? [];
  const globals = options.globals ?? [];
  const writable = (ref: DocumentRef): boolean =>
    'global' in ref ? (options.applyTo?.globals ?? globals).includes(ref.global) : (options.applyTo?.collections ?? collections).includes(ref.collection);

  return defineAdapter({
    name: 'payload',

    async pull({ project }) {
      const resources: PulledResource[] = [];
      for (const collection of collections) resources.push(...(await pullCollection(payload, collection, project, options)));
      for (const global of globals) resources.push(...(await pullDocument(payload, { global }, project, options)));
      return { resources };
    },

    async push({ project }, resources) {
      let written = 0;
      const rejected: PushRejection[] = [];

      for (const { ref, resources: own } of groupByDocument(resources)) {
        if (!writable(ref)) continue;
        const document = await read(payload, ref);
        if (!document) {
          rejected.push(...own.flatMap((resource) => Object.keys(resource.targets).map((locale) => ({ key: resource.key, locale, reason: 'document no longer exists' }))));
          continue;
        }
        // A row with no id in storage gets a fresh one on every read; written back, Payload would not match it and drop its other locales.
        const unmatchableRows = rowsWithUnstableId(document, await read(payload, ref), project.sourceLocale);
        const writes = await localeWrites(ref, document, own, { ...documentOptions(fieldMapOf(payload, ref), project, options), unmatchableRows });
        for (const write of writes) {
          rejected.push(...write.rejected);
          if (write.unchanged) continue;
          const data = write.data as Record<string, unknown>;
          try {
            if ('global' in ref) {
              await payload.updateGlobal({ slug: ref.global as GlobalSlug, locale: write.locale, data, depth: 0, overrideAccess: true, context: { [OPENDEEPL_CONTEXT]: true } });
            } else {
              // `autosave` reuses one version across the locales of a run instead of minting one per locale.
              await payload.update({ collection: ref.collection as CollectionSlug, id: ref.id, locale: write.locale, data, depth: 0, autosave: true, overrideAccess: true, context: { [OPENDEEPL_CONTEXT]: true } });
            }
            written += write.units.length;
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            rejected.push(...own.filter((resource) => resource.targets[write.locale]).map((resource) => ({ key: resource.key, locale: write.locale, reason })));
          }
        }
      }
      return { written, rejected };
    },
  });
};
