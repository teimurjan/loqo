export { defineAdapter } from './adapter';
export { type ApiFailure, type ApiResult, type ClientOptions, createClient, type LoqoClient } from './client';
export {
  arrays,
  createExtractor,
  type ExtractedField,
  type Extractor,
  type ExtractorOptions,
  type ExtractRule,
  localizedText,
  type LocalizedTextOptions,
  type Nest,
  objects,
} from './extract';
export {
  getLocalized,
  isLocalizedMap,
  type LocaleContext,
  localize,
  projectLocale,
  restore,
  type RestorableField,
  type Translations,
} from './localized';
export { deepEqual, getAt, isPlainObject, parsePath, type Path, pathKey, setAt } from './object';
export { pluralCategories } from './plurals';
export { isPlaceholderOnlyKey, SPECIFIER, SPECIFIER_TYPES, stripSpecifiers } from './specifiers';
export {
  type ApplyOptions,
  type ApplyResult,
  applyTranslations,
  foldTranslations,
  importResources,
  syncRemote,
  type SyncRemoteOptions,
  type SyncRemoteResult,
} from './sync';
export * from './types';
