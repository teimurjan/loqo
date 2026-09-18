import { describe, expect, test } from 'bun:test';
import { renderTemplate } from '../src/core/prompts/template';

describe('renderTemplate', () => {
  test('interpolates nested paths and drops missing ones', () => {
    expect(renderTemplate('Hi {{user.name}}{{missing}}!', { user: { name: 'Ada' } })).toBe('Hi Ada!');
  });

  test('if/else treats empty strings and arrays as falsy', () => {
    const tpl = '{{#if items}}has{{else}}none{{/if}}';
    expect(renderTemplate(tpl, { items: [] })).toBe('none');
    expect(renderTemplate(tpl, { items: [1] })).toBe('has');
    expect(renderTemplate('{{#if s}}x{{/if}}', { s: '  ' })).toBe('');
  });

  test('each exposes item fields and this', () => {
    const tpl = '{{#each pairs}}- {{source}} → {{target}}\n{{/each}}{{#each names}}{{this}},{{/each}}';
    expect(renderTemplate(tpl, { pairs: [{ source: 'a', target: 'b' }], names: ['x', 'y'] })).toBe('- a → b\nx,y,');
  });

  test('backslash escapes literal braces', () => {
    expect(renderTemplate('keep \\{{userName}} as {{locale}}', { locale: 'de' })).toBe('keep {{userName}} as de');
  });

  test('throws on stray closers', () => {
    expect(() => renderTemplate('{{/if}}', {})).toThrow();
  });
});
