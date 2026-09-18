import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createProviderRegistry } from 'ai';

/**
 * The providers the built-in layers address, keyed by `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`.
 * A config that needs another provider (a gateway, a self-hosted model) builds its own registry
 * with the AI SDK instead of, or on top of, this one.
 */
export const defaultProviders = () =>
  createProviderRegistry({
    openai: createOpenAI({ apiKey: process.env.OPENAI_API_KEY }),
    anthropic: createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  });
