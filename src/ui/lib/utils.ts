import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));

export const formatUsd = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `$${value.toFixed(value < 0.01 ? 5 : 3)}`;

export const formatDate = (value: string | Date): string =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const truncate = (value: string, max = 80): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

/** CLDR's likely region for bare `pt` is Brazil; projects list `pt-br` separately, so bare `pt` is Portugal. */
const LIKELY_REGION_OVERRIDES: Record<string, string> = { pt: 'PT' };

const REGIONAL_INDICATOR_OFFSET = 0x1f1e6 - 'A'.charCodeAt(0);

/** The flag of a locale's region, or of its likely region for a bare language. None for numeric regions such as es-419. */
export const localeFlag = (locale: string): string | undefined => {
  try {
    const region = LIKELY_REGION_OVERRIDES[locale.toLowerCase()] ?? new Intl.Locale(locale).maximize().region;
    if (!region || !/^[A-Z]{2}$/.test(region)) return undefined;
    return [...region].map((letter) => String.fromCodePoint(letter.charCodeAt(0) + REGIONAL_INDICATOR_OFFSET)).join('');
  } catch {
    return undefined;
  }
};
