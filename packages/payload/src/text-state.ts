import { isPlainObject } from '@opendeepl/sdk';
import type { LexicalNode } from './rich-text';

/**
 * `$` on a text node — a custom property the site's editor adds (text size, case transform, color)
 * that neither the HTML converter nor the HTML parser knows. On the way out it becomes a
 * `data-s` attribute on a `span`; on the way in, before the parser flattens spans away, the span's
 * boundaries are written into the text as private-use markers, and the parsed text nodes are split
 * on them afterwards. Text runs Lexical would merge stay apart wherever their `$` differs.
 */

const OPEN = '';
const CLOSE = '';
const END = '';
const MARKER = /([^]*)|/;

const encode = (value: string): string => encodeURIComponent(value);

/** `size=h2;transform=uppercase`, or nothing for a `$` with no string values. */
export const textStateAttribute = (state: unknown): string | undefined => {
  if (!isPlainObject(state)) return undefined;
  const pairs = Object.entries(state).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return pairs.length === 0 ? undefined : pairs.map(([key, value]) => `${encode(key)}=${encode(value)}`).join(';');
};

const parseTextState = (attribute: string): Record<string, string> =>
  Object.fromEntries(
    attribute
      .split(';')
      .filter((pair) => pair.includes('='))
      .map((pair) => {
        const at = pair.indexOf('=');
        return [decodeURIComponent(pair.slice(0, at)), decodeURIComponent(pair.slice(at + 1))];
      }),
  );

/** Writes each `span[data-s]`'s state and extent into its text, where the parser will keep them. */
export const markTextState = (document: Document): void => {
  for (const span of document.querySelectorAll('span[data-s]')) {
    const attribute = span.getAttribute('data-s') ?? '';
    span.prepend(document.createTextNode(`${OPEN}${attribute}${CLOSE}`));
    span.append(document.createTextNode(END));
  }
};

type Walk = { current: Record<string, string> | undefined };

const splitText = (node: LexicalNode, walk: Walk): LexicalNode[] => {
  const pieces: LexicalNode[] = [];
  const push = (text: string) => {
    if (text.length > 0) pieces.push({ ...node, text, ...(walk.current ? { $: walk.current } : {}) });
  };
  let rest = String(node.text);
  for (let match = MARKER.exec(rest); match; match = MARKER.exec(rest)) {
    push(rest.slice(0, match.index));
    walk.current = match[1] === undefined ? undefined : parseTextState(match[1]);
    rest = rest.slice(match.index + match[0].length);
  }
  push(rest);
  return pieces;
};

const restoreChildren = (node: LexicalNode, walk: Walk): LexicalNode => {
  if (!node.children) return node;
  const children = node.children.flatMap((child) => (child.type === 'text' && typeof child.text === 'string' ? splitText(child, walk) : [restoreChildren(child, walk)]));
  return { ...node, children };
};

/** Splits parsed text on the markers `markTextState` wrote and puts `$` back on the runs between them. */
export const restoreTextState = (node: LexicalNode): LexicalNode => restoreChildren(node, { current: undefined });
