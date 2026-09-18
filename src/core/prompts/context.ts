import type { GlossaryEntry, Project, Resource } from '../../db/schema';
import { localeName } from '../model/locales';
import type { TemplateContext } from './template';

export type NativeExample = { source: string; target: string };

/** Length budget the prompt asks for: 5% under the hard cap, like the old TextLengthPlugin. */
const lengthBudget = (maxLength: unknown): number | null =>
  typeof maxLength === 'number' && maxLength > 0 ? maxLength - Math.round((maxLength / 100) * 5) : null;

const glossaryTable = (glossary: GlossaryEntry[], locale: string): string => {
  const rows = glossary
    .filter((entry) => entry.term && entry.translations[locale])
    .map((entry) => `| ${entry.term.padEnd(12)} | ${(entry.translations[locale] ?? '').padEnd(25)} |`);
  if (rows.length === 0) return '';
  return ['| English term | Preferred translation |', '|--------------|-----------------------|', ...rows].join('\n');
};

export type PromptContextInput = {
  project: Pick<Project, 'slug' | 'name' | 'sourceLocale' | 'glossary' | 'extraInstructions'>;
  resource: Pick<Resource, 'id' | 'key' | 'source' | 'tags' | 'meta'>;
  locale: string;
  localeNames: Record<string, string>;
  nativeExamples: NativeExample[];
};

export const buildPromptContext = (input: PromptContextInput): TemplateContext => ({
  locale: input.locale,
  localeName: localeName(input.locale, input.localeNames),
  sourceLocale: input.project.sourceLocale,
  sourceLocaleName: localeName(input.project.sourceLocale, input.localeNames),
  project: { slug: input.project.slug, name: input.project.name },
  key: input.resource.key,
  source: input.resource.source,
  tags: input.resource.tags,
  meta: input.resource.meta,
  glossaryTable: glossaryTable(input.project.glossary, input.locale),
  extraInstructions: input.project.extraInstructions[input.locale] ?? '',
  lengthBudget: lengthBudget(input.resource.meta.maxLength),
  nativeExamples: input.nativeExamples,
});
