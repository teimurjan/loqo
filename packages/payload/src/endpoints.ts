import type { ApiResult } from '@loqo/sdk';
import type { Endpoint, PayloadRequest } from 'payload';
import { addDataAndFileToRequest } from 'payload';
import type { DocumentRef } from './keys';
import type { LoqoService } from './service';

export type EndpointOptions = {
  /** Bearer token accepted instead of a signed-in user — for a cron or a CI step. */
  secret?: string;
};

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

const resultResponse = (result: ApiResult<unknown>): Response => (result.ok ? json(result.data) : json({ error: result.error.message, details: result.error.details }, result.error.status || 502));

const bearerOf = (req: PayloadRequest): string | null => {
  const header = req.headers.get('authorization') ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null;
};

const param = (req: PayloadRequest, name: string): string => String(req.routeParams?.[name] ?? '');

/**
 * `/api/loqo/*`, for the admin components, a cron or a button:
 *
 * - `GET status`, `POST import` (whole project), `POST sync` (import, then apply what changed since
 *   `since`), `POST translate` (queue everything missing);
 * - per document: `GET|POST collections/:slug/:id/{status,translate,apply}` and `globals/:slug/…`.
 */
export const createEndpoints = (service: LoqoService, options: EndpointOptions): Endpoint[] => {
  const authorized = (req: PayloadRequest): boolean => Boolean(req.user) || (options.secret !== undefined && bearerOf(req) === options.secret);

  const guarded =
    (handler: (req: PayloadRequest) => Promise<Response>): Endpoint['handler'] =>
    async (req) =>
      authorized(req) ? handler(req) : json({ error: 'Unauthorized' }, 401);

  const document = (kind: 'collections' | 'globals', action: 'status' | 'translate' | 'apply'): Endpoint => {
    const refOf = (req: PayloadRequest): DocumentRef => (kind === 'globals' ? { global: param(req, 'slug') } : { collection: param(req, 'slug'), id: param(req, 'id') });
    const path = kind === 'globals' ? `/loqo/globals/:slug/${action}` : `/loqo/collections/:slug/:id/${action}`;
    if (action === 'status') return { path, method: 'get', handler: guarded(async (req) => resultResponse(await service.documentStatus(refOf(req)))) };
    if (action === 'translate') return { path, method: 'post', handler: guarded(async (req) => resultResponse(await service.importDocument(req.payload, refOf(req)))) };
    return { path, method: 'post', handler: guarded(async (req) => resultResponse(await service.applyDocument(req.payload, refOf(req)))) };
  };

  return [
    { path: '/loqo/status', method: 'get', handler: guarded(async () => resultResponse(await service.status())) },
    { path: '/loqo/import', method: 'post', handler: guarded(async (req) => resultResponse(await service.importAll(req.payload))) },
    {
      path: '/loqo/sync',
      method: 'post',
      handler: guarded(async (req) => {
        await addDataAndFileToRequest(req);
        const since = typeof req.data?.since === 'string' ? req.data.since : undefined;
        return resultResponse(await service.sync(req.payload, since));
      }),
    },
    { path: '/loqo/translate', method: 'post', handler: guarded(async () => resultResponse(await service.translate())) },
    ...(['collections', 'globals'] as const).flatMap((kind) => (['status', 'translate', 'apply'] as const).map((action) => document(kind, action))),
  ];
};
