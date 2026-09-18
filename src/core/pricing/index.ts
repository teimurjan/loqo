import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { priceCache } from '../../db/schema';
import snapshot from './litellm-snapshot.json';

export const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export type ModelPrice = {
  inputPerToken: number;
  outputPerToken: number;
  cachedInputPerToken: number | null;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
};

type LiteLlmEntry = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  litellm_provider?: string;
  mode?: string;
};

export type PriceTable = Record<string, LiteLlmEntry>;

const CACHE_ID = 'litellm';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const toPrice = (entry: LiteLlmEntry | undefined): ModelPrice | null =>
  entry && typeof entry.input_cost_per_token === 'number' && typeof entry.output_cost_per_token === 'number'
    ? {
        inputPerToken: entry.input_cost_per_token,
        outputPerToken: entry.output_cost_per_token,
        cachedInputPerToken: entry.cache_read_input_token_cost ?? null,
      }
    : null;

const DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

/**
 * `provider:model` → LiteLLM key. The file mixes bare ids (`gpt-4.1`), provider-prefixed ids
 * (`openrouter/openai/gpt-4.1`) and dated snapshots, so try the likely spellings in order.
 */
export const resolvePrice = (table: PriceTable, modelRef: string): ModelPrice | null => {
  const [provider, ...rest] = modelRef.split(':');
  const model = rest.length > 0 ? rest.join(':') : (provider ?? modelRef);
  const candidates = [model, `${provider}/${model}`, model.replace(DATE_SUFFIX, ''), `${provider}/${model.replace(DATE_SUFFIX, '')}`];
  for (const candidate of candidates) {
    const price = toPrice(table[candidate]);
    if (price) return price;
  }
  return null;
};

export const priceCost = (price: ModelPrice, usage: TokenUsage): number => {
  const uncached = Math.max(usage.inputTokens - usage.cachedInputTokens, 0);
  const cachedRate = price.cachedInputPerToken ?? price.inputPerToken;
  // Reasoning tokens are already inside outputTokens; they are not priced twice.
  return uncached * price.inputPerToken + usage.cachedInputTokens * cachedRate + usage.outputTokens * price.outputPerToken;
};

export const computeCostUsd = (table: PriceTable, modelRef: string, usage: TokenUsage): number | null => {
  const price = resolvePrice(table, modelRef);
  return price ? priceCost(price, usage) : null;
};

/**
 * Daily-refreshed price table with two fallbacks: the last copy stored in Postgres, then the
 * snapshot committed with the code. Never throws — an unknown price becomes `costUsd: null`.
 */
export const createPricing = (db: Db, fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch) => {
  let table: PriceTable = snapshot.models as PriceTable;
  let refreshedAt = 0;
  let refreshing: Promise<void> | null = null;

  const loadFromDb = async (): Promise<boolean> => {
    const [row] = await db.select().from(priceCache).where(eq(priceCache.id, CACHE_ID)).limit(1);
    if (!row) return false;
    table = row.body as PriceTable;
    refreshedAt = row.fetchedAt.getTime();
    return true;
  };

  const fetchLatest = async (): Promise<void> => {
    const response = await fetchImpl(LITELLM_URL, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`LiteLLM price fetch failed: ${response.status}`);
    const body = (await response.json()) as PriceTable;
    if (typeof body !== 'object' || !body['gpt-4.1']) throw new Error('LiteLLM price file has an unexpected shape');
    const fetchedAt = new Date();
    await db
      .insert(priceCache)
      .values({ id: CACHE_ID, body, fetchedAt })
      .onConflictDoUpdate({ target: priceCache.id, set: { body, fetchedAt } });
    table = body;
    refreshedAt = fetchedAt.getTime();
  };

  const refreshIfStale = async (): Promise<void> => {
    if (Date.now() - refreshedAt < ONE_DAY_MS) return;
    if (!refreshing) {
      refreshing = fetchLatest()
        .catch((error: unknown) => {
          console.warn('[pricing] using cached prices:', error instanceof Error ? error.message : error);
          // Back off for an hour so a dead network does not retry on every LLM call.
          refreshedAt = Date.now() - ONE_DAY_MS + 60 * 60 * 1000;
        })
        .finally(() => {
          refreshing = null;
        });
    }
    await refreshing;
  };

  return {
    async start(): Promise<void> {
      await loadFromDb().catch(() => false);
      await refreshIfStale();
    },
    async costUsd(modelRef: string, usage: TokenUsage): Promise<number | null> {
      await refreshIfStale();
      return computeCostUsd(table, modelRef, usage);
    },
    status: () => ({ models: Object.keys(table).length, refreshedAt: refreshedAt ? new Date(refreshedAt) : null }),
  };
};

export type Pricing = ReturnType<typeof createPricing>;
