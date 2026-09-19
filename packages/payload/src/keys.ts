import { parsePath, type Path, pathKey } from '@loqo/sdk';

/** Which document a resource belongs to. Globals are keyed under `globals/` so they cannot collide with a collection. */
export type DocumentRef = { collection: string; id: string } | { global: string };

export const documentPrefix = (ref: DocumentRef): string => ('global' in ref ? `globals/${ref.global}:` : `${ref.collection}/${ref.id}:`);

/** Every resource of a collection or global carries this tag: what a whole entity is addressed by. */
export const entityTag = (ref: DocumentRef | { collection: string }): string => ('global' in ref ? `global:${ref.global}` : `collection:${ref.collection}`);

/** `pages/<id>:hero.title` — the document prefix is what a single-document re-import prunes under. */
export const resourceKey = (ref: DocumentRef, path: Path): string => `${documentPrefix(ref)}${pathKey(path)}`;

export const parseResourceKey = (key: string): { ref: DocumentRef; path: (string | number)[] } | null => {
  const colon = key.indexOf(':');
  const slash = key.indexOf('/');
  if (colon <= 0 || slash <= 0 || slash > colon) return null;
  const entity = key.slice(0, slash);
  const id = key.slice(slash + 1, colon);
  if (id.length === 0) return null;
  const path = parsePath(key.slice(colon + 1));
  return { ref: entity === 'globals' ? { global: id } : { collection: entity, id }, path };
};

export const sameDocument = (a: DocumentRef, b: DocumentRef): boolean => documentPrefix(a) === documentPrefix(b);
