import {
  arrays,
  createExtractor,
  type ExtractedField,
  type ExtractRule,
  isLocalizedMap,
  isPlainObject,
  type LocaleContext,
  localizedText,
  objects,
} from '@opendeepl/sdk';
import { type FieldConfigMap, fieldConfigAt, isNonProseField, lengthMeta } from './fields';
import { extractRichText, isLexicalNode, type LexicalCodec } from './rich-text';

/** What every rule sees: the locales, the whole document (block slugs live on rows) and the field configs. */
export type PayloadContext = LocaleContext & { document: unknown; fields: FieldConfigMap };

/** `breadcrumbs` from `@payloadcms/plugin-nested-docs`: a localized list whose labels are prose. */
export const breadcrumbs = (): ExtractRule<ExtractedField, PayloadContext> => (value, path, ctx) => {
  if (path[path.length - 1] !== 'breadcrumbs' || !isLocalizedMap(value, ctx.sourceLocale)) return undefined;
  const crumbs = value[ctx.sourceLocale];
  if (!Array.isArray(crumbs)) return undefined;
  return crumbs.flatMap((crumb, index) =>
    isPlainObject(crumb) && typeof crumb.label === 'string' ? [{ path: [...path, index, 'label'], value: crumb.label, kind: 'text', unit: path }] : [],
  );
};

/** A localized Lexical value: one field per block-level node, carrying the field's length limits. */
export const richText =
  (codec: LexicalCodec): ExtractRule<ExtractedField, PayloadContext> =>
  async (value, path, ctx) => {
    if (!isLocalizedMap(value, ctx.sourceLocale)) return undefined;
    const source = value[ctx.sourceLocale];
    if (!isPlainObject(source) || !isLexicalNode(source.root)) return undefined;
    const limits = lengthMeta(fieldConfigAt(ctx.fields, path, ctx.document));
    const fields = await extractRichText(source.root, [...path, 'root'], codec);
    return fields.map((field) => ({ ...field, unit: path, meta: limits ? { ...field.meta, ...limits } : field.meta }));
  };

/** Localized strings that are prose — not ids, options, dates or code — with the field's length limits. */
export const payloadText = (): ExtractRule<ExtractedField, PayloadContext> =>
  localizedText<PayloadContext>({
    skip: (path, ctx) => isNonProseField(fieldConfigAt(ctx.fields, path, ctx.document)),
    meta: (path, ctx) => lengthMeta(fieldConfigAt(ctx.fields, path, ctx.document)),
  });

export type LocalizableOptions = {
  codec: LexicalCodec;
  /** Keys never translated, at any depth (`revision`, say). Each locale keeps its own value there. */
  ignore?: readonly string[];
};

export const createLocalizableExtractor = (options: LocalizableOptions) =>
  createExtractor<ExtractedField, PayloadContext>([breadcrumbs(), richText(options.codec), payloadText(), arrays(), objects()], {
    ignoreKeys: options.ignore ?? [],
  });
