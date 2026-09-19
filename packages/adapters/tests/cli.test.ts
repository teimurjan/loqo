import { describe, expect, test } from 'bun:test';
import { adapterFrom, parseCli } from '../src/cli';

describe('loqo-sync', () => {
  test('flags become adapter options; the platform coordinates fall back to the environment', () => {
    const options = parseCli(['request', '--adapter', 'android-xml', '--ignore', 'androidApp/src/demo', '--locale-map', 'zh-hans=zh-rCN,pt=pt-rBR', '--no-enqueue'], {
      LOQO_PROJECT: 'android',
      LOQO_BASE_URL: 'https://translate.example',
      LOQO_API_KEY: 'loqo_x',
    });
    expect(options).toMatchObject({ command: 'request', adapter: 'android-xml', root: '.', ignore: ['androidApp/src/demo'], localeMap: { 'zh-hans': 'zh-rCN', pt: 'pt-rBR' }, project: 'android', prune: true, enqueue: false });
    expect(adapterFrom(options).name).toBe('android-xml');
    expect(adapterFrom({ ...options, adapter: 'xcstrings' }).name).toBe('xcstrings');
    expect(adapterFrom({ ...options, adapter: 'json', source: 'public/locales/en/common.json' }).name).toBe('json');
  });

  test('a missing command, key or adapter is an error before anything is touched', () => {
    expect(() => parseCli(['sync'])).toThrow(/usage/);
    expect(() => parseCli(['check', '--project', 'p', '--base-url', 'u'])).toThrow('--api-key or LOQO_API_KEY is required');
    const options = parseCli(['import', '--project', 'p', '--base-url', 'u', '--api-key', 'k']);
    expect(() => adapterFrom(options)).toThrow('--adapter must be');
    expect(() => adapterFrom({ ...options, adapter: 'json' })).toThrow('--source');
    expect(() => parseCli(['import', '--locale-map', 'broken', '--project', 'p', '--base-url', 'u', '--api-key', 'k'])).toThrow('--locale-map');
  });
});
