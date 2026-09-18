import { setTimeout as sleep } from 'node:timers/promises';
import { APICallError } from '@ai-sdk/provider';
import type { LanguageModelMiddleware } from 'ai';

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_PAUSE_MS = 5_000;
const MAX_PAUSE_MS = 60_000;

/**
 * A provider's rate limit is one budget shared by every call in the process, so one 429 is news
 * for all of them: the provider goes into a cooldown for its Retry-After and every call holds at
 * the door until it ends, instead of each discovering the limit on its own and piling retries on
 * top of each other.
 */
export type ProviderBackoff = {
  /** Retries the SDK makes per call before it fails for good; each one waits out the cooldown first. */
  readonly maxRetries: number;
  /** Resolves once `provider` is out of cooldown; at once when it is not in one. */
  wait(provider: string): Promise<void>;
  /** A 429 puts `provider` in cooldown for its Retry-After (5 s when absent, 60 s at most); any other error is ignored. */
  observe(provider: string, error: unknown): void;
};

const retryAfterMs = (headers: Record<string, string> | undefined): number => {
  const ms = Number.parseFloat(headers?.['retry-after-ms'] ?? '');
  if (Number.isFinite(ms)) return ms;
  const header = headers?.['retry-after'] ?? '';
  const seconds = Number.parseFloat(header);
  return Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
};

const pauseMs = (error: APICallError): number => {
  const asked = retryAfterMs(error.responseHeaders);
  return Math.min(MAX_PAUSE_MS, Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_PAUSE_MS);
};

export const createProviderBackoff = ({ maxRetries = DEFAULT_MAX_RETRIES }: { maxRetries?: number } = {}): ProviderBackoff => {
  const pausedUntil = new Map<string, number>();
  const remaining = (provider: string): number => (pausedUntil.get(provider) ?? 0) - Date.now();

  return {
    maxRetries,
    wait: async (provider) => {
      // Re-check after sleeping: another call may have seen a 429 and pushed the cooldown out.
      for (let delay = remaining(provider); delay > 0; delay = remaining(provider)) await sleep(delay);
    },
    observe: (provider, error) => {
      if (!APICallError.isInstance(error) || error.statusCode !== 429) return;
      const until = Date.now() + pauseMs(error);
      pausedUntil.set(provider, Math.max(pausedUntil.get(provider) ?? 0, until));
    },
  };
};

/** Holds a call while its provider cools down and reports the 429s it sees; the SDK's own retry does the retrying. */
export const backoffMiddleware = (backoff: ProviderBackoff, provider: string): LanguageModelMiddleware => ({
  wrapGenerate: async ({ doGenerate }) => {
    await backoff.wait(provider);
    try {
      return await doGenerate();
    } catch (error) {
      backoff.observe(provider, error);
      throw error;
    }
  },
});
