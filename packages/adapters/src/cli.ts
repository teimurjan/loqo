import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { type Adapter, type ApiResult, applyTranslations, createClient, importResources, type StatusCounts } from '@opendeepl/sdk';
import { androidXml } from './android-xml';
import { json } from './json';
import { xcstrings } from './xcstrings';

/**
 * `opendeepl-sync <request|import|check>` (`bin.ts`): the three steps a repository's CI runs against
 * the platform, with the adapter picked and configured from flags so nothing has to be installed in
 * the repository being synced. Prints a JSON summary; under GitHub Actions also writes step outputs.
 */

const USAGE = `usage: opendeepl-sync <request|import|check> [options]

  request   pull the repository's strings into the platform (prunes what is gone) and queue what is missing
  import    write translated values back into the repository
  check     report whether anything is still in flight

options
  --adapter <xcstrings|android-xml|json>   (request, import)
  --root <dir>                             repository checkout, default "."
  --include <glob,...>                     override the adapter's file patterns
  --ignore <prefix,...>                    path prefixes to skip
  --locale-map <locale=file,...>           platform locale → file locale, e.g. zh-hans=zh-Hans
  --source <path> --target <path> --tags <tag,...>   json adapter
  --project <slug>     or OPENDEEPL_PROJECT
  --base-url <url>     or OPENDEEPL_BASE_URL
  --api-key <key>      or OPENDEEPL_API_KEY
  --since <iso-8601>   import: only targets changed since then
  --no-prune           request: keep platform resources the repository no longer has
  --no-enqueue         request: import without queuing translations
`;

const list = (value: string | undefined): string[] | undefined => (value?.trim() ? value.split(',').map((entry) => entry.trim()).filter(Boolean) : undefined);

const pairs = (value: string | undefined): Record<string, string> | undefined => {
  const entries = list(value)?.map((pair) => {
    const at = pair.indexOf('=');
    if (at <= 0) throw new Error(`--locale-map: expected locale=file, got "${pair}"`);
    return [pair.slice(0, at), pair.slice(at + 1)] as const;
  });
  return entries && Object.fromEntries(entries);
};

export type CliOptions = {
  command: string;
  adapter?: string;
  root: string;
  include?: string[];
  ignore?: string[];
  localeMap?: Record<string, string>;
  source?: string;
  target?: string;
  tags?: string[];
  project: string;
  baseUrl: string;
  apiKey: string;
  since?: string;
  prune: boolean;
  enqueue: boolean;
};

export const parseCli = (argv: string[], env: Record<string, string | undefined> = {}): CliOptions => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      adapter: { type: 'string' },
      root: { type: 'string', default: '.' },
      include: { type: 'string' },
      ignore: { type: 'string' },
      'locale-map': { type: 'string' },
      source: { type: 'string' },
      target: { type: 'string' },
      tags: { type: 'string' },
      project: { type: 'string' },
      'base-url': { type: 'string' },
      'api-key': { type: 'string' },
      since: { type: 'string' },
      'no-prune': { type: 'boolean', default: false },
      'no-enqueue': { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  if (!command || !['request', 'import', 'check'].includes(command)) throw new Error(USAGE);
  const required = (flag: string, value: string | undefined, variable: string): string => {
    if (!value) throw new Error(`--${flag} or ${variable} is required`);
    return value;
  };
  return {
    command,
    adapter: values.adapter,
    root: values.root,
    include: list(values.include),
    ignore: list(values.ignore),
    localeMap: pairs(values['locale-map']),
    source: values.source,
    target: values.target,
    tags: list(values.tags),
    project: required('project', values.project ?? env.OPENDEEPL_PROJECT, 'OPENDEEPL_PROJECT'),
    baseUrl: required('base-url', values['base-url'] ?? env.OPENDEEPL_BASE_URL, 'OPENDEEPL_BASE_URL'),
    apiKey: required('api-key', values['api-key'] ?? env.OPENDEEPL_API_KEY, 'OPENDEEPL_API_KEY'),
    since: values.since,
    prune: !values['no-prune'],
    enqueue: !values['no-enqueue'],
  };
};

export const adapterFrom = (options: CliOptions): Adapter => {
  const files = { root: options.root, ...(options.include ? { include: options.include } : {}), ignore: options.ignore, localeMap: options.localeMap };
  switch (options.adapter) {
    case 'xcstrings':
      return xcstrings(files);
    case 'android-xml':
      return androidXml(files);
    case 'json':
      if (!options.source) throw new Error('--source is required for the json adapter');
      return json({ root: options.root, source: options.source, target: options.target, localeMap: options.localeMap, tags: options.tags });
    default:
      throw new Error(`--adapter must be xcstrings, android-xml or json (got "${options.adapter ?? ''}")`);
  }
};

const IN_FLIGHT = ['pending', 'queued', 'translating'] as const;
const OPEN = [...IN_FLIGHT, 'rejected', 'failed'] as const;

const total = (counts: StatusCounts, statuses: readonly (keyof StatusCounts)[]): number => statuses.reduce((sum, status) => sum + (counts[status] ?? 0), 0);

export type Outputs = Record<string, string | number | boolean>;

/** What each command reports: a JSON summary for the log and flat outputs for the workflow. */
export const run = async (options: CliOptions): Promise<{ summary: unknown; outputs: Outputs }> => {
  const client = createClient({ baseUrl: options.baseUrl, apiKey: options.apiKey });
  const unwrap = <T>(result: ApiResult<T>): T => {
    if (!result.ok) throw new Error(`${options.baseUrl}: ${result.error.status} ${result.error.message}`);
    return result.data;
  };

  if (options.command === 'check') {
    const project = unwrap(await client.project(options.project));
    const counts = project.counts.targets;
    const inFlight = total(counts, IN_FLIGHT);
    return {
      summary: { project: project.slug, counts },
      outputs: { ready: inFlight === 0, in_flight: inFlight, open: total(counts, OPEN), translated: counts.translated ?? 0, rejected: counts.rejected ?? 0, failed: counts.failed ?? 0 },
    };
  }

  const adapter = adapterFrom(options);
  if (options.command === 'request') {
    const summary = unwrap(await importResources(client, options.project, adapter, { prune: options.prune, enqueue: options.enqueue }));
    return {
      summary,
      outputs: { pulled: summary.pulled, created: summary.created, updated: summary.updated, removed: summary.removed, enqueued: summary.enqueued, legacy_rejected: summary.legacyRejected, duplicates: summary.duplicates.length },
    };
  }

  const applied = unwrap(await applyTranslations(client, options.project, adapter, { updatedSince: options.since }));
  return {
    summary: applied,
    outputs: {
      written: applied.pushed.written,
      files_updated: applied.pushed.files?.length ?? 0,
      files: JSON.stringify(applied.pushed.files ?? []),
      rejected: applied.pushed.rejected?.length ?? 0,
      latest_updated_at: applied.latestUpdatedAt ?? '',
    },
  };
};

export const writeGithubOutputs = (outputs: Outputs, path: string | undefined): void => {
  if (!path) return;
  appendFileSync(path, `${Object.entries(outputs).map(([key, value]) => `${key}=${String(value)}`).join('\n')}\n`);
};

export const main = async (argv: string[], env: Record<string, string | undefined>): Promise<void> => {
  const options = parseCli(argv, env);
  const { summary, outputs } = await run(options);
  console.log(JSON.stringify(summary, null, 2));
  writeGithubOutputs(outputs, env.GITHUB_OUTPUT);
};
