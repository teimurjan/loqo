import type { LanguageModelV4 } from '@ai-sdk/provider';
import { generateObject, type JSONValue, type LanguageModelMiddleware, wrapLanguageModel } from 'ai';
import { z } from 'zod';
import type { TranslateConfig } from '../../config';
import type { TokenUsage } from '../pricing';
import { backoffMiddleware, type ProviderBackoff } from './backoff';

/** How the pipeline reaches a model: the registry from `translate.config.ts`, and the process-wide rate-limit cooldowns. */
export type ModelClient = { providers: TranslateConfig['providers']; backoff: ProviderBackoff };

/**
 * The shape every layer and repair call speaks, constrained by the provider's structured output so
 * the answer is always parseable and complete in form. It is fixed — ids live inside, not as keys —
 * because providers compile and cache a schema, and a schema with per-call keys would be new every
 * time. Content rules (a brand name kept, a placeholder present, a length) are not expressible as
 * schema on every provider and would be met mechanically where they are; the guards judge those.
 */
export const ENVELOPE = z.object({ fields: z.array(z.object({ id: z.string(), text: z.string() })) });

export type Envelope = z.infer<typeof ENVELOPE>;

/** Appended to every system prompt by code, so prompts describe the task and never the transport. */
export const WIRE_FORMAT = `## Format
You receive JSON of the form {"fields":[{"id":"…","text":"…"}]}. Reply with JSON of exactly the same form: every id exactly once, its "text" replaced by your result. Never add, drop, rename or reorder ids; never leave a text empty.`;

export const toEnvelope = (fields: Record<string, string>): Envelope => ({ fields: Object.entries(fields).map(([id, text]) => ({ id, text })) });

export const fromEnvelope = (envelope: Envelope): Record<string, string> => Object.fromEntries(envelope.fields.map(({ id, text }) => [id, text]));

/** C0/C1 controls (tab, newline and carriage return excepted) and the byte-order mark. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFEFF]/g;

/**
 * Only characters that can never be language are stripped from what a model returns. Zero-width
 * joiners and non-joiners are orthography in Persian, Urdu and Hindi, zero-width spaces break
 * lines in Thai, bidi marks order Arabic and Hebrew around Latin, and a non-breaking space before
 * a French colon is typography — none of them is in the English source, all of them belong in
 * the translation.
 */
export const stripControlCharacters = (text: string): string => text.replace(CONTROL_CHARACTERS, '');

const cleanTextMiddleware: LanguageModelMiddleware = {
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    return {
      ...result,
      content: result.content.map((part) => (part.type === 'text' ? { ...part, text: stripControlCharacters(part.text) } : part)),
    };
  },
};

/** The registry addresses models as `provider:model`. */
const providerOf = (modelRef: string): string => modelRef.split(':')[0] ?? '';

/** Each provider spells "how hard to think" differently; unknown providers get no option. */
const reasoningOptions = (modelRef: string, effort: string | null): Record<string, Record<string, JSONValue>> => {
  if (!effort) return {};
  const provider = providerOf(modelRef);
  if (provider === 'openai') return { openai: { reasoningEffort: effort } };
  if (provider === 'anthropic') {
    return effort === 'none' ? { anthropic: { thinking: { type: 'disabled' } } } : { anthropic: { effort } };
  }
  return {};
};

export type LayerCall = {
  model: string;
  reasoningEffort: string | null;
  systemPrompt: string;
  fields: Record<string, string>;
};

export type LayerCallResult = {
  fields: Record<string, string>;
  /** Ids the model returned nothing for; their `fields` entry is the input, so later layers still have text. */
  missing: string[];
  usage: TokenUsage;
};

/**
 * One model call: the values go in as the envelope and come back as the envelope. An id the model
 * dropped or answered with nothing keeps its previous value so later layers still have text, and
 * is reported in `missing` so the pipeline rejects it rather than ship the input as the output.
 */
export const callLayer = async ({ providers, backoff }: ModelClient, call: LayerCall): Promise<LayerCallResult> => {
  const registry = providers as { languageModel: (id: string) => LanguageModelV4 };
  const model = wrapLanguageModel({
    model: registry.languageModel(call.model),
    middleware: [backoffMiddleware(backoff, providerOf(call.model)), cleanTextMiddleware],
  });

  const { object, usage } = await generateObject({
    model,
    schema: ENVELOPE,
    schemaName: 'translation',
    system: `${call.systemPrompt}\n\n${WIRE_FORMAT}`,
    prompt: JSON.stringify(toEnvelope(call.fields)),
    providerOptions: reasoningOptions(call.model, call.reasoningEffort),
    maxRetries: backoff.maxRetries,
  });

  const answered = fromEnvelope(object);
  const missing: string[] = [];
  const fields = Object.fromEntries(
    Object.entries(call.fields).map(([id, previous]) => {
      const next = answered[id];
      if (typeof next === 'string' && next.length > 0) return [id, next];
      missing.push(id);
      return [id, previous];
    }),
  );

  return {
    fields,
    missing,
    usage: {
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
      cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    },
  };
};
