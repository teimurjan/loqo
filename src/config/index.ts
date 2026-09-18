import { resolve } from 'node:path';
import type { ProviderV3, ProviderV4 } from '@ai-sdk/provider';
import type { ProviderRegistryProvider } from 'ai';
import { defaultGuardKinds } from '../core/guards';
import type { Guard, GuardKind } from '../core/guards/types';
import type { PromptSeed } from '../core/layers/defaults';
import type { MaybePromise } from '../core/model/types';
import type { Stage } from '../core/pipeline/stage';
import { defaultProcessors } from '../core/processors';
import type { ValueProcessor } from '../core/processors/types';
import type { Db } from '../db/client';

/**
 * Everything that is code, not data: provider instances (and their API keys), guards, value
 * processors and code stages. Layers, models and prompts live in Postgres; adapters live in the
 * repos they sync.
 */
export type TranslateConfig = {
  providers: ProviderRegistryProvider<Record<string, ProviderV4 | ProviderV3>, ':'>;
  guards: Guard[];
  /** Guards a scenario may attach with parameters from the flow UI; defaults to every built-in kind. */
  guardKinds?: GuardKind[];
  processors?: ValueProcessor[];
  /** Code stages of the pipeline, ordered among the layers by their `position`. */
  stages?: Stage[];
  /** Display names used in prompts; anything missing falls back to `Intl.DisplayNames`. */
  localeNames?: Record<string, string>;
  /** `provider:model` for guard repair calls when a guard does not name one; defaults to the last layer's model. */
  repairModel?: string;
  /**
   * Prompt fragments this deployment owns — a brand's rules, a product's vocabulary. Seeded beside
   * the built-ins under the same contract: read-only in the UI, and a body that changes here becomes
   * the prompt's next version on the next start.
   */
  prompts?: PromptSeed[];
};

export type { PromptSeed };
export { defaultProviders } from './providers';

export type ResolvedConfig = Required<Pick<TranslateConfig, 'processors' | 'localeNames' | 'guardKinds' | 'stages'>> & TranslateConfig;

/** What the platform lends to a config: a stage or guard that reads translation memory gets the database here. */
export type ConfigServices = { db: Db };

export type ConfigFactory = (services: ConfigServices) => MaybePromise<TranslateConfig>;

export const defineConfig = (config: TranslateConfig | ConfigFactory): TranslateConfig | ConfigFactory => config;

/** Resolved from the working directory, not this file: the bundle in `dist/` runs from the project root too. */
const configPath = (): string => resolve(process.cwd(), process.env.TRANSLATE_CONFIG ?? 'translate.config.ts');

export const loadConfig = async (services: ConfigServices): Promise<ResolvedConfig> => {
  const module = (await import(configPath())) as { default?: TranslateConfig | ConfigFactory };
  const config = typeof module.default === 'function' ? await module.default(services) : module.default;
  if (!config?.providers || !config.guards) {
    throw new Error(`translate.config.ts must default-export defineConfig({ providers, guards })`);
  }
  return { processors: defaultProcessors(), localeNames: {}, guardKinds: defaultGuardKinds(), stages: [], ...config };
};
