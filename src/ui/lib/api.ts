import type { ApiKeyPublic } from '../../core/api-keys/service';
import type { GuardRuleInput } from '../../core/guards/rules';
import type { LayerInput, OverrideInput, PromptInput, PromptWithVersion } from '../../core/layers/service';
import type { MemberWithUser, Membership } from '../../core/members/service';
import type { CostDimension, CostRow, QueueStatus, SuspiciousTarget } from '../../core/ops/service';
import type { ProjectInput, ProjectWithCounts } from '../../core/projects/service';
import type { ResourceDetail, ResourceListItem } from '../../core/resources/service';
import type { FlowExplain } from '../../core/scenarios/flow';
import type { ScenarioInput } from '../../core/scenarios/service';
import type { AuditEntry, GuardRule, Layer, LayerOverride, MemberRole, Project, ProjectMember, PromptVersion, Scenario, Target } from '../../db/schema';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Fired on any 401 so the shell can drop back to the login page. */
export const UNAUTHORIZED_EVENT = 'loqo:unauthorized';

const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (response.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = parsed as { error?: string; details?: unknown } | null;
    throw new ApiError(response.status, error?.error ?? response.statusText, error?.details);
  }
  return parsed as T;
};

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') search.set(key, String(value));
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
};

export type JsonSchema = { type?: string; properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema; description?: string };

export type ConfigInfo = {
  guardKinds: { name: string; description: string; canRepair: boolean; schema: JsonSchema }[];
  processors: { name: string; stage: 'source' | 'output' }[];
  repairModel: string | null;
};

export type Me = {
  user: { id: string; email: string; name: string; avatarUrl: string | null } | null;
  api: boolean;
  memberships: Membership[];
};

export type ResourceQuery = { q?: string; status?: string; locale?: string; tag?: string; page?: number; limit?: number };

export const api = {
  config: () => request<ConfigInfo>('GET', '/api/config'),
  auth: {
    me: () => request<Me>('GET', '/api/auth/me'),
    logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  },
  projects: {
    list: () => request<ProjectWithCounts[]>('GET', '/api/projects'),
    get: (slug: string) => request<ProjectWithCounts>('GET', `/api/projects/${slug}`),
    create: (input: ProjectInput) => request<Project>('POST', '/api/projects', input),
    update: (slug: string, input: Partial<ProjectInput>) => request<Project>('PATCH', `/api/projects/${slug}`, input),
    remove: (slug: string) => request<{ ok: true }>('DELETE', `/api/projects/${slug}`),
    translate: (slug: string, input: { locales?: string[]; force?: boolean }) =>
      request<{ enqueued: number }>('POST', `/api/projects/${slug}/translate`, input),
    resources: (slug: string, params: ResourceQuery) =>
      request<{ items: ResourceListItem[]; total: number }>('GET', `/api/projects/${slug}/resources${query(params)}`),
  },
  keys: {
    list: (slug: string) => request<ApiKeyPublic[]>('GET', `/api/projects/${slug}/keys`),
    create: (slug: string, input: { name: string; role: MemberRole }) => request<{ key: ApiKeyPublic; token: string }>('POST', `/api/projects/${slug}/keys`, input),
    remove: (slug: string, id: string) => request<{ ok: true }>('DELETE', `/api/projects/${slug}/keys/${id}`),
  },
  members: {
    list: (slug: string) => request<MemberWithUser[]>('GET', `/api/projects/${slug}/members`),
    invite: (slug: string, input: { email: string; role: MemberRole }) => request<ProjectMember>('POST', `/api/projects/${slug}/members`, input),
    setRole: (slug: string, id: string, role: MemberRole) => request<ProjectMember>('PATCH', `/api/projects/${slug}/members/${id}`, { role }),
    remove: (slug: string, id: string) => request<{ ok: true }>('DELETE', `/api/projects/${slug}/members/${id}`),
  },
  scenarios: {
    list: (slug: string) => request<Scenario[]>('GET', `/api/projects/${slug}/scenarios`),
    create: (slug: string, input: ScenarioInput) => request<Scenario>('POST', `/api/projects/${slug}/scenarios`, input),
    update: (slug: string, id: string, input: Partial<ScenarioInput>) => request<Scenario>('PATCH', `/api/projects/${slug}/scenarios/${id}`, input),
    remove: (slug: string, id: string) => request<{ ok: true }>('DELETE', `/api/projects/${slug}/scenarios/${id}`),
    flow: (slug: string, id: string) => request<FlowExplain>('GET', `/api/projects/${slug}/scenarios/${id}/flow`),
    addLayer: (slug: string, id: string, input: LayerInput) => request<Layer>('POST', `/api/projects/${slug}/scenarios/${id}/layers`, input),
    addPrompt: (slug: string, id: string, input: PromptInput) => request<PromptWithVersion>('POST', `/api/projects/${slug}/scenarios/${id}/prompts`, input),
    upsertOverride: (slug: string, id: string, input: OverrideInput) => request<LayerOverride>('POST', `/api/projects/${slug}/scenarios/${id}/overrides`, input),
    addGuardRule: (slug: string, id: string, input: GuardRuleInput) => request<GuardRule>('POST', `/api/projects/${slug}/scenarios/${id}/guard-rules`, input),
  },
  resources: {
    get: (id: string) => request<ResourceDetail>('GET', `/api/resources/${id}`),
  },
  targets: {
    pin: (id: string, pinned: boolean) => request<Target>('POST', `/api/targets/${id}/pin`, { pinned }),
    native: (id: string, native: boolean) => request<Target>('POST', `/api/targets/${id}/native`, { native }),
    setValue: (id: string, value: string) => request<Target>('PUT', `/api/targets/${id}/value`, { value }),
    retranslate: (id: string) => request<Target>('POST', `/api/targets/${id}/retranslate`),
  },
  layers: {
    update: (id: string, input: Partial<LayerInput>) => request<Layer>('PATCH', `/api/layers/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/api/layers/${id}`),
  },
  prompts: {
    update: (id: string, input: Partial<Omit<PromptInput, 'body'>>) => request<PromptWithVersion>('PATCH', `/api/prompts/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/api/prompts/${id}`),
    versions: (id: string) => request<PromptVersion[]>('GET', `/api/prompts/${id}/versions`),
    addVersion: (id: string, body: string) => request<PromptVersion>('POST', `/api/prompts/${id}/versions`, { body }),
  },
  overrides: {
    remove: (id: string) => request<{ ok: true }>('DELETE', `/api/layer-overrides/${id}`),
  },
  guardRules: {
    update: (id: string, input: Partial<Omit<GuardRuleInput, 'guard'>>) => request<GuardRule>('PATCH', `/api/guard-rules/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/api/guard-rules/${id}`),
  },
  queue: (project?: string) => request<QueueStatus>('GET', `/api/queue${query({ project })}`),
  suspicious: (project?: string) => request<SuspiciousTarget[]>('GET', `/api/ops/suspicious${query({ project })}`),
  cost: (groupBy: CostDimension, project?: string) => request<CostRow[]>('GET', `/api/analytics/cost${query({ groupBy, project })}`),
  audit: (limit = 100, project?: string) => request<AuditEntry[]>('GET', `/api/audit${query({ limit, project })}`),
};
