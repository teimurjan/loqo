import { isPlainObject, type Path } from '@loqo/sdk';

/**
 * The slice of a Payload field config the adapter reads. Structural so the pure parts of the
 * package do not depend on Payload's own types; a `SanitizedCollectionConfig` satisfies it.
 */
export type FieldLike = {
  name?: string;
  type: string;
  localized?: boolean;
  required?: boolean;
  /** `{ localize: false }` opts a field out of translation, whatever its type. */
  custom?: Record<string, unknown>;
  maxLength?: number;
  minLength?: number;
  fields?: readonly FieldLike[];
  blocks?: readonly { slug: string; fields?: readonly FieldLike[] }[];
  tabs?: readonly { name?: string; fields?: readonly FieldLike[] }[];
};

export type FieldConfigMap = Record<string, FieldLike>;

/** Field types whose localized value is an id, not prose. */
export const REFERENCE_FIELD_TYPES: ReadonlySet<string> = new Set(['upload', 'relationship', 'join']);

/** Field types whose value may be a string without being prose: options, addresses, code, dates. */
export const NON_PROSE_FIELD_TYPES: ReadonlySet<string> = new Set([...REFERENCE_FIELD_TYPES, 'select', 'radio', 'email', 'code', 'date', 'json', 'number', 'checkbox', 'point']);

/**
 * Every named field keyed by its dotted config path. Block fields are keyed with the block slug
 * (`content.hero.heading`), tab fields with the tab name when it has one.
 */
export const buildFieldConfigMap = (config: { fields: readonly FieldLike[] }): FieldConfigMap => {
  const map: FieldConfigMap = {};
  const visit = (fields: readonly FieldLike[], prefix: string) => {
    for (const field of fields) {
      const path = field.name ? (prefix ? `${prefix}.${field.name}` : field.name) : prefix;
      if (field.name) map[path] = field;
      if (field.fields) visit(field.fields, path);
      for (const block of field.blocks ?? []) if (block.fields) visit(block.fields, `${path}.${block.slug}`);
      for (const tab of field.tabs ?? []) if (tab.fields) visit(tab.fields, tab.name ? `${path}.${tab.name}` : path);
    }
  };
  visit(config.fields, '');
  return map;
};

/**
 * The config key for a runtime path. Array indexes drop out; inside a `blocks` field the block slug
 * is not in the path but on the row, so the document is walked alongside to recover it. Stops at
 * `root`, where a Lexical value's internals begin and field configs end.
 */
export const configPathOf = (path: Path, document: unknown): string => {
  const parts: string[] = [];
  let current: unknown = document;
  for (const segment of path) {
    if (typeof segment === 'number') {
      current = Array.isArray(current) ? current[segment] : undefined;
      if (isPlainObject(current) && typeof current.blockType === 'string') parts.push(current.blockType);
      continue;
    }
    if (segment === 'root') break;
    parts.push(segment);
    current = isPlainObject(current) ? current[segment] : undefined;
  }
  return parts.join('.');
};

/** Index-stripped path, the key a block-unaware lookup uses (`content.heading`). */
export const unindexedPathOf = (path: Path): string => path.filter((segment): segment is string => typeof segment === 'string' && segment !== 'root').join('.');

export const fieldConfigAt = (map: FieldConfigMap, path: Path, document: unknown): FieldLike | undefined =>
  map[configPathOf(path, document)] ?? map[unindexedPathOf(path)];

export const isNonProseField = (field: FieldLike | undefined): boolean =>
  field !== undefined && (NON_PROSE_FIELD_TYPES.has(field.type) || field.custom?.localize === false);

export const lengthMeta = (field: FieldLike | undefined): Record<string, number> | undefined => {
  if (!field?.maxLength && !field?.minLength) return undefined;
  return { ...(field.maxLength ? { maxLength: field.maxLength } : {}), ...(field.minLength ? { minLength: field.minLength } : {}) };
};
