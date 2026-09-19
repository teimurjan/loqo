export { pluralCategories } from '@loqo/sdk';

const displayNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'code' });

export const localeName = (locale: string, overrides: Record<string, string> = {}): string => {
  const override = overrides[locale];
  if (override) return override;
  try {
    return displayNames.of(locale) ?? locale;
  } catch {
    return locale;
  }
};

