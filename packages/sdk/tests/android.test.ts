import { describe, expect, test } from 'bun:test';
import { pluralSpecifiers, unwrapAndroidQuotes } from '../src';

describe('unwrapAndroidQuotes', () => {
  test('drops quote wrappers around and between tags, keeps escaped quotes, attributes and CDATA', () => {
    expect(unwrapAndroidQuotes('"  Padded  "')).toBe('  Padded  ');
    expect(unwrapAndroidQuotes('<xliff:g id="n" example="5">"%1$s"</xliff:g>" left"')).toBe('<xliff:g id="n" example="5">%1$s</xliff:g> left');
    expect(unwrapAndroidQuotes('Tap \\"Pay\\" — it\\\'s "quick"')).toBe('Tap \\"Pay\\" — it\\\'s quick');
    expect(unwrapAndroidQuotes('<![CDATA[say "hi"]]> "now"')).toBe('<![CDATA[say "hi"]]> now');
    expect(unwrapAndroidQuotes('plain')).toBe('plain');
  });
});

describe('pluralSpecifiers', () => {
  test('is the union across variants, undefined when there is none', () => {
    expect(pluralSpecifiers(['Delete page', 'Delete %lld pages'])).toEqual(['%lld']);
    expect(pluralSpecifiers(['%1$d of %2$s', '%1$d of %2$s'])).toEqual(['%1$d', '%2$s']);
    expect(pluralSpecifiers(['page', 'pages'])).toBeUndefined();
  });
});
