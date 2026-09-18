import type { CollectionAfterChangeHook, CollectionAfterDeleteHook, CollectionConfig, Config, GlobalAfterChangeHook, GlobalConfig, Payload, PayloadRequest, Plugin } from 'payload';
import { OPENDEEPL_CONTEXT } from './adapter';
import { createEndpoints } from './endpoints';
import { createService, type OpendeeplService, type ServiceOptions } from './service';

export type OpendeeplPluginOptions = ServiceOptions & {
  /** Re-import a document when an editor saves it in the source locale. On by default. */
  importOnChange?: boolean;
  /** Keeps a hook-triggered import alive after the response; on Vercel pass `waitUntil`. */
  defer?: (work: Promise<unknown>) => void;
  /** Bearer token the plugin's endpoints accept instead of a signed-in user. */
  secret?: string;
  onError?: (message: string, detail: unknown) => void;
  /**
   * The admin pieces: translate/apply controls on every listed document's edit view and a status
   * view at `admin/opendeepl`. `false` adds nothing; `importPath` is where the components are
   * imported from when the package is not consumed from a registry (`/src/vendor/opendeepl`, say).
   */
  admin?: false | { controls?: boolean; view?: false | { path?: `/${string}` }; importPath?: string };
};

const DEFAULT_IMPORT_PATH = '@opendeepl/payload';

/** Where the plugin leaves its service on the config, for app code that has a `payload` and a job for it. */
const CUSTOM_KEY = 'opendeepl';

export const opendeeplServiceOf = (payload: Payload): OpendeeplService => {
  const service = (payload.config.custom as Record<string, unknown> | undefined)?.[CUSTOM_KEY];
  if (!service) throw new Error('opendeeplPlugin is not installed in this Payload config');
  return service as OpendeeplService;
};

const sourceLocaleOf = (req: PayloadRequest): string | undefined => (req.payload.config.localization ? req.payload.config.localization.defaultLocale : undefined);

/**
 * Wires the platform into a Payload app:
 *
 * - `afterChange`/`afterDelete` on the listed collections and globals re-import that one document
 *   (pruning under its key prefix), so the platform sees an edit as soon as it is saved;
 * - `/api/opendeepl/*` endpoints (see `createEndpoints`) for the admin components, a cron or a CI step;
 * - the admin components themselves, unless `admin: false`;
 * - the service under `config.custom.opendeepl`, reachable as `opendeeplServiceOf(payload)`.
 *
 * Translations flow back through `sync`/`apply`; nothing here listens for them.
 */
export const opendeeplPlugin = (options: OpendeeplPluginOptions): Plugin => {
  const service = createService(options);
  const onError = options.onError ?? ((message, detail) => console.error(`[opendeepl] ${message}`, detail));
  const defer = options.defer ?? ((work) => void work.catch((error: unknown) => onError('background import failed', error)));
  const admin = options.admin === false ? undefined : { controls: true, view: {}, importPath: DEFAULT_IMPORT_PATH, ...options.admin };
  const controlsComponent = `${admin?.importPath ?? DEFAULT_IMPORT_PATH}/client#TranslateControls`;

  const reimport = (req: PayloadRequest, ref: Parameters<typeof service.importDocument>[1], deleted = false) =>
    defer(
      service.importDocument(req.payload, ref, { deleted }).then((result) => {
        if (!result.ok) onError(`import of ${'global' in ref ? ref.global : `${ref.collection}/${ref.id}`} failed`, result.error);
      }),
    );

  const shouldImport = (req: PayloadRequest, doc: unknown): boolean => {
    if (options.importOnChange === false) return false;
    if (req.context?.[OPENDEEPL_CONTEXT]) return false;
    const sourceLocale = sourceLocaleOf(req);
    if (sourceLocale && req.locale && req.locale !== sourceLocale) return false;
    const status = (doc as { _status?: string } | null)?._status;
    return status === undefined || status === 'published';
  };

  const afterChange: CollectionAfterChangeHook = ({ doc, req, collection }) => {
    if (shouldImport(req, doc)) reimport(req, { collection: collection.slug, id: String(doc.id) });
    return doc;
  };
  const afterDelete: CollectionAfterDeleteHook = ({ doc, req, collection }) => {
    if (options.importOnChange !== false) reimport(req, { collection: collection.slug, id: String(doc.id) }, true);
    return doc;
  };
  const afterGlobalChange: GlobalAfterChangeHook = ({ doc, req, global }) => {
    if (shouldImport(req, doc)) reimport(req, { global: global.slug });
    return doc;
  };

  return (config: Config): Config => {
    const withControls = <T extends CollectionConfig | GlobalConfig>(entity: T, elements: 'edit' | 'elements'): T => {
      if (!admin?.controls) return entity;
      const components = (entity.admin?.components ?? {}) as Record<string, { beforeDocumentControls?: unknown[] } | undefined>;
      const slot = components[elements] ?? {};
      return {
        ...entity,
        admin: { ...entity.admin, components: { ...components, [elements]: { ...slot, beforeDocumentControls: [...(slot.beforeDocumentControls ?? []), controlsComponent] } } },
      };
    };

    return {
      ...config,
      custom: { ...config.custom, [CUSTOM_KEY]: service },
      collections: (config.collections ?? []).map((collection) =>
        options.collections.includes(collection.slug)
          ? withControls(
              {
                ...collection,
                hooks: {
                  ...collection.hooks,
                  afterChange: [...(collection.hooks?.afterChange ?? []), afterChange],
                  afterDelete: [...(collection.hooks?.afterDelete ?? []), afterDelete],
                },
              },
              'edit',
            )
          : collection,
      ),
      globals: (config.globals ?? []).map((global) =>
        options.globals?.includes(global.slug)
          ? withControls({ ...global, hooks: { ...global.hooks, afterChange: [...(global.hooks?.afterChange ?? []), afterGlobalChange] } }, 'elements')
          : global,
      ),
      endpoints: [...(config.endpoints ?? []), ...createEndpoints(service, { secret: options.secret })],
      admin:
        admin?.view === false || admin === undefined
          ? config.admin
          : {
              ...config.admin,
              components: {
                ...config.admin?.components,
                views: {
                  ...config.admin?.components?.views,
                  opendeepl: { Component: `${admin.importPath}/rsc#TranslationStatusView`, path: admin.view.path ?? '/opendeepl' },
                },
              },
            },
    };
  };
};
