export type Path = readonly (string | number)[];

export const pathKey = (path: Path): string => path.join('.');

export const parsePath = (key: string): (string | number)[] =>
  key === '' ? [] : key.split('.').map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));

export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const getAt = (value: unknown, path: Path): unknown =>
  path.reduce<unknown>((current, segment) => (current === null || typeof current !== 'object' ? undefined : (current as Record<string | number, unknown>)[segment]), value);

/** Copy-on-write: only the containers along `path` are new objects; missing containers are created. */
export const setAt = (value: unknown, path: Path, next: unknown): unknown => {
  if (path.length === 0) return next;
  const [head, ...rest] = path as [string | number, ...(string | number)[]];
  if (Array.isArray(value) || (typeof head === 'number' && !isPlainObject(value))) {
    const copy = Array.isArray(value) ? [...value] : [];
    copy[head as number] = setAt(copy[head as number], rest, next);
    return copy;
  }
  const record = isPlainObject(value) ? value : {};
  return { ...record, [head]: setAt(record[head], rest, next) };
};

/** Structural equality the way JSON sees it: key order and `undefined` properties do not count. */
export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keysA = Object.keys(a).filter((key) => a[key] !== undefined);
  const keysB = Object.keys(b).filter((key) => b[key] !== undefined);
  return keysA.length === keysB.length && keysA.every((key) => deepEqual(a[key], b[key]));
};
