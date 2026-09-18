import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));

export const formatUsd = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `$${value.toFixed(value < 0.01 ? 5 : 3)}`;

export const formatDate = (value: string | Date): string =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export const truncate = (value: string, max = 80): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
