/**
 * A small ICU MessageFormat scanner: enough to list the arguments a message declares and the
 * variants each plural/select carries. It is deliberately not a full parser — the guards only need
 * names, types and option keys, and a message a real parser would reject is one the guard should
 * reject too.
 */
export type IcuArgument = {
  name: string;
  type: string | null;
  /** option key → option body, for plural/select/selectordinal. */
  options: Record<string, string>;
};

const matchingBrace = (message: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < message.length; i += 1) {
    const char = message[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

const parseOptions = (body: string): Record<string, string> => {
  const options: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i] ?? '')) i += 1;
    const keyStart = i;
    while (i < body.length && !/[\s{]/.test(body[i] ?? '')) i += 1;
    const key = body.slice(keyStart, i);
    while (i < body.length && /\s/.test(body[i] ?? '')) i += 1;
    if (!key || body[i] !== '{') break;
    const close = matchingBrace(body, i);
    if (close === -1) break;
    options[key] = body.slice(i + 1, close);
    i = close + 1;
  }
  return options;
};

const SELECT_TYPES = new Set(['plural', 'select', 'selectordinal']);

export const scanIcuArguments = (message: string): IcuArgument[] => {
  const found: IcuArgument[] = [];
  let i = 0;
  while (i < message.length) {
    if (message[i] === "'" && message[i + 1] === '{') {
      const end = message.indexOf("'", i + 1);
      i = end === -1 ? message.length : end + 1;
      continue;
    }
    if (message[i] !== '{') {
      i += 1;
      continue;
    }
    const close = matchingBrace(message, i);
    if (close === -1) break;
    const inner = message.slice(i + 1, close);
    const [rawName, rawType, ...rest] = inner.split(',');
    const name = (rawName ?? '').trim();
    const type = rawType?.trim() || null;
    const isValidName = /^[\w.-]+$/.test(name);
    if (isValidName) {
      const options = type && SELECT_TYPES.has(type) ? parseOptions(rest.join(',')) : {};
      found.push({ name, type, options });
      for (const body of Object.values(options)) found.push(...scanIcuArguments(body));
    }
    i = close + 1;
  }
  return found;
};

export const hasIcuArguments = (message: string): boolean => scanIcuArguments(message).length > 0;
