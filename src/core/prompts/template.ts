/**
 * A deliberately tiny template language for prompt fragments stored in Postgres:
 *
 *   {{path.to.value}}                         interpolate (empty string when missing)
 *   {{#if path}} ... {{else}} ... {{/if}}     truthy check (empty arrays and strings are falsy)
 *   {{#each path}} ... {{/each}}              iterate; inside, {{this}} is the item and {{key}} its fields
 *   \{{literal}}                              a backslash keeps the braces verbatim
 *
 * No helpers, no partials, no HTML escaping — prompts are plain text for a model.
 */
export type TemplateContext = Record<string, unknown>;

type Node =
  | { kind: 'text'; value: string }
  | { kind: 'var'; path: string }
  | { kind: 'if'; path: string; then: Node[]; otherwise: Node[] }
  | { kind: 'each'; path: string; body: Node[] };

const TAG = /\{\{\s*(#if|#each|\/if|\/each|else)?\s*([^{}]*?)\s*\}\}/g;

type Token = { type: 'text'; value: string } | { type: 'tag'; keyword: string | undefined; arg: string };

const tokenize = (template: string): Token[] => {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of template.matchAll(TAG)) {
    const index = match.index ?? 0;
    const escaped = index > 0 && template[index - 1] === '\\';
    if (escaped) {
      tokens.push({ type: 'text', value: template.slice(last, index - 1) + match[0] });
    } else {
      if (index > last) tokens.push({ type: 'text', value: template.slice(last, index) });
      tokens.push({ type: 'tag', keyword: match[1], arg: match[2] ?? '' });
    }
    last = index + match[0].length;
  }
  if (last < template.length) tokens.push({ type: 'text', value: template.slice(last) });
  return tokens;
};

const parse = (tokens: Token[]): Node[] => {
  let position = 0;

  const parseUntil = (closers: string[]): { nodes: Node[]; closer: string | null } => {
    const nodes: Node[] = [];
    while (position < tokens.length) {
      const token = tokens[position];
      position += 1;
      if (!token) break;
      if (token.type === 'text') {
        nodes.push({ kind: 'text', value: token.value });
        continue;
      }
      const keyword = token.keyword ?? 'var';
      if (closers.includes(keyword)) return { nodes, closer: keyword };
      if (keyword === 'var') {
        nodes.push({ kind: 'var', path: token.arg });
      } else if (keyword === '#if') {
        const then = parseUntil(['else', '/if']);
        const otherwise = then.closer === 'else' ? parseUntil(['/if']).nodes : [];
        nodes.push({ kind: 'if', path: token.arg, then: then.nodes, otherwise });
      } else if (keyword === '#each') {
        nodes.push({ kind: 'each', path: token.arg, body: parseUntil(['/each']).nodes });
      } else {
        throw new Error(`Unexpected {{${keyword}}} in template`);
      }
    }
    return { nodes, closer: null };
  };

  return parseUntil([]).nodes;
};

const lookup = (context: TemplateContext, path: string): unknown => {
  if (path === 'this') return context.this;
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, context);
};

const truthy = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return Boolean(value);
};

const stringify = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

const render = (nodes: Node[], context: TemplateContext): string =>
  nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
          return node.value;
        case 'var':
          return stringify(lookup(context, node.path));
        case 'if':
          return render(truthy(lookup(context, node.path)) ? node.then : node.otherwise, context);
        case 'each': {
          const items = lookup(context, node.path);
          if (!Array.isArray(items)) return '';
          return items
            .map((item) =>
              render(node.body, {
                ...context,
                ...(item !== null && typeof item === 'object' ? (item as TemplateContext) : {}),
                this: item,
              }),
            )
            .join('');
        }
      }
    })
    .join('');

export const compileTemplate = (template: string): ((context: TemplateContext) => string) => {
  const nodes = parse(tokenize(template));
  return (context) => render(nodes, context);
};

export const renderTemplate = (template: string, context: TemplateContext): string =>
  compileTemplate(template)(context);
