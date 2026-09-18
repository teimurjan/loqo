import { defaultProviders, defineConfig } from './src/config';
import { defaultGuards } from './src/core/guards';

/**
 * Code, not data: provider keys, guards, code stages and the prompt fragments a deployment owns get
 * code review. Layers, models and prompts are edited in the UI and versioned in Postgres. Models
 * are addressed as `provider:model`. Adapters are not here at all: they run in the repos they sync,
 * against a project API key, via `@opendeepl/sdk`.
 *
 * This file is the platform's default. A deployment keeps its own next to a checkout and points
 * `TRANSLATE_CONFIG` at it — typically `brandTerms([...])` among the guards and its brand's and
 * product's vocabulary under `prompts`. Export a function `({ db }) => ({ … })` instead when a stage
 * or guard needs the platform's database.
 */
export default defineConfig({
  providers: defaultProviders(),
  guards: defaultGuards(),
});
