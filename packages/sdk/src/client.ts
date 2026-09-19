import type {
  CountsQuery,
  CountsResult,
  ImportOptions,
  ProjectInfo,
  PulledResource,
  ResourceInfo,
  ResourceScope,
  ResourcesQuery,
  ScopeStatus,
  SyncSummary,
  TargetInfo,
  TranslateOptions,
  TranslationsPage,
  TranslationsQuery,
} from './types';

export type ApiFailure = { status: number; message: string; details?: unknown };

/** Every call resolves; a non-2xx status or a network failure is the `ok: false` branch, never a throw. */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

export type ClientOptions = {
  /** Platform origin, e.g. `https://translate.example.com`. */
  baseUrl: string;
  /** A project API key from the platform's project settings; sent as a bearer token. */
  apiKey: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

type Query = Record<string, string | number | boolean | Date | undefined>;

const queryString = (query: Query): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    search.set(key, value instanceof Date ? value.toISOString() : String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
};

const createRequest = (options: ClientOptions) => {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;

  return async <T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<ApiResult<T>> => {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      return { ok: false, error: { status: 0, message: error instanceof Error ? error.message : 'network error' } };
    }
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (response.ok) return { ok: true, data: parsed as T };
    const failure = parsed !== null && typeof parsed === 'object' ? (parsed as { error?: string; details?: unknown }) : {};
    return {
      ok: false,
      error: { status: response.status, message: failure.error ?? response.statusText ?? `HTTP ${response.status}`, details: failure.details },
    };
  };
};

/** Typed over the platform's HTTP routes; one method per route, no state. */
export const createClient = (options: ClientOptions) => {
  const request = createRequest(options);
  const project = (slug: string) => `/api/projects/${encodeURIComponent(slug)}`;
  const target = (id: string) => `/api/targets/${encodeURIComponent(id)}`;

  return {
    project: (slug: string) => request<ProjectInfo>('GET', project(slug)),

    import: (slug: string, body: { resources: PulledResource[] } & ImportOptions) =>
      request<SyncSummary>('POST', `${project(slug)}/import`, body),

    translate: (slug: string, body: TranslateOptions = {}) => request<{ enqueued: number }>('POST', `${project(slug)}/translate`, body),

    status: (slug: string, scope: ResourceScope = {}) =>
      request<ScopeStatus>('GET', `${project(slug)}/status${queryString({ prefix: scope.prefix, tags: scope.tags?.join(',') })}`),

    translations: (slug: string, query: TranslationsQuery = {}) =>
      request<TranslationsPage>('GET', `${project(slug)}/translations${queryString(query)}`),

    resources: (slug: string, query: ResourcesQuery = {}) =>
      request<{ items: ResourceInfo[]; total: number }>('GET', `${project(slug)}/resources${queryString(query)}`),

    counts: (slug: string, query: CountsQuery) => request<CountsResult>('GET', `${project(slug)}/counts${queryString(query)}`),

    pin: (id: string, pinned: boolean) => request<TargetInfo>('POST', `${target(id)}/pin`, { pinned }),

    native: (id: string, native: boolean) => request<TargetInfo>('POST', `${target(id)}/native`, { native }),

    setValue: (id: string, value: string) => request<TargetInfo>('PUT', `${target(id)}/value`, { value }),

    retranslate: (id: string) => request<TargetInfo>('POST', `${target(id)}/retranslate`),
  };
};

export type LoqoClient = ReturnType<typeof createClient>;
