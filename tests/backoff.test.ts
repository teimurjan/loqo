import { describe, expect, test } from 'bun:test';
import { APICallError } from '@ai-sdk/provider';
import { generateText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { backoffMiddleware, createProviderBackoff } from '../src/core/pipeline/backoff';

const rateLimited = (headers: Record<string, string>) =>
  new APICallError({ message: 'rate limited', url: 'https://provider.test', requestBodyValues: {}, statusCode: 429, responseHeaders: headers, isRetryable: true });

const elapsed = async (work: () => Promise<unknown>): Promise<number> => {
  const started = performance.now();
  await work();
  return performance.now() - started;
};

describe('provider backoff', () => {
  test('a 429 holds every call to that provider for its Retry-After, and nothing else does', async () => {
    const backoff = createProviderBackoff();
    backoff.observe('openai', new Error('not a rate limit'));
    backoff.observe('anthropic', rateLimited({ 'retry-after': 'not a number' }));
    expect(await elapsed(() => backoff.wait('openai'))).toBeLessThan(20);

    backoff.observe('openai', rateLimited({ 'retry-after-ms': '60' }));
    // A shorter Retry-After never cuts a cooldown short.
    backoff.observe('openai', rateLimited({ 'retry-after-ms': '10' }));
    expect(await elapsed(() => backoff.wait('openai'))).toBeGreaterThanOrEqual(55);
    expect(await elapsed(() => backoff.wait('openai'))).toBeLessThan(20);
  });

  test('the middleware reports 429s and the SDK retries once the provider is back', async () => {
    const backoff = createProviderBackoff({ maxRetries: 1 });
    let attempts = 0;
    const model = wrapLanguageModel({
      model: new MockLanguageModelV4({
        doGenerate: async () => {
          attempts += 1;
          if (attempts === 1) throw rateLimited({ 'retry-after-ms': '30' });
          return {
            content: [{ type: 'text', text: 'ok' }],
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
            warnings: [],
          };
        },
      }),
      middleware: backoffMiddleware(backoff, 'fake'),
    });

    const first = generateText({ model, prompt: 'hi', maxRetries: backoff.maxRetries });
    await Bun.sleep(5);
    // Started during the cooldown the first call triggered, so it waits that cooldown out too.
    const secondMs = await elapsed(() => generateText({ model, prompt: 'hi', maxRetries: 0 }));
    expect((await first).text).toBe('ok');
    expect(attempts).toBe(3);
    expect(secondMs).toBeGreaterThanOrEqual(20);
  });
});
