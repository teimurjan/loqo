import { createHeadlessEditor } from '@lexical/headless';
import { $generateNodesFromDOM } from '@lexical/html';
import { convertLexicalToHTMLAsync, defaultHTMLConvertersAsync, type HTMLConverterAsync, LinkHTMLConverterAsync, TextHTMLConverterAsync } from '@payloadcms/richtext-lexical/html-async';
import { defaultEditorConfig, defaultEditorFeatures, getEnabledNodes, sanitizeServerEditorConfig } from '@payloadcms/richtext-lexical';
import { JSDOM } from 'jsdom';
import { $getRoot, $getSelection } from 'lexical';
import type { Payload } from 'payload';
import { type LexicalCodec, type LexicalNode, linkHref } from './rich-text';
import { markTextState, restoreTextState, textStateAttribute } from './text-state';

/**
 * The real Lexical ↔ HTML codec, built from the app's sanitized editor config so every enabled node
 * type (links, uploads, blocks) is known on the way back in. Kept in its own entry point: it pulls
 * in `jsdom` and the Lexical runtime, which nothing else in the package needs.
 */

/**
 * A newline inside text would be collapsed to a space (or become a LineBreakNode); escape it so the
 * conversion keeps it and put it back after. Text nodes only: converters also put newlines inside
 * tags (`<li\n value="1">`), and escaping those turns the tag into garbage.
 */
const escapeTextNewlines = (document: Document): void => {
  const walker = document.createTreeWalker(document.body, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeValue?.includes('\n')) node.nodeValue = node.nodeValue.replaceAll('\n', '\\n');
  }
};

const unescapeNewlines = (value: unknown): unknown => {
  if (typeof value === 'string') return value.replaceAll('\\n', '\n');
  if (Array.isArray(value)) return value.map(unescapeNewlines);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, unescapeNewlines(entry)]));
  }
  return value;
};

type Globals = { window: unknown; document: unknown; DocumentFragment: unknown; navigator: unknown };

/**
 * `$generateNodesFromDOM` reads the globals; swap them in for the synchronous update and back out
 * after. One jsdom window serves the codec's lifetime — a window costs ~0.5 MB that `close()` does
 * not give back, and a sync of a large site parses tens of thousands of fragments — and each
 * fragment gets its own lightweight `Document` from `DOMParser`.
 */
const createDomParser = () => {
  const { window } = new JSDOM('');
  const parser = new window.DOMParser();
  const install = (globals: Globals) => {
    for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  };
  return <T>(html: string, run: (document: Document) => T): T => {
    const document = parser.parseFromString(html, 'text/html');
    const previous: Globals = { window: globalThis.window, document: globalThis.document, DocumentFragment: globalThis.DocumentFragment, navigator: globalThis.navigator };
    install({ window, document, DocumentFragment: window.DocumentFragment, navigator: window.navigator });
    try {
      return run(document);
    } finally {
      install(previous);
    }
  };
};

/** An internal link's target is a relation `restoreLinks` gives back; the href only has to identify it. */
const internalDocToHref = ({ linkNode }: { linkNode: { fields: unknown } }): string => linkHref({ ...(linkNode.fields as object), linkType: 'internal' }) ?? '#';

/** A text node's `$` (a custom per-node property: size, transform, color) travels as a `span` attribute the parser cannot lose. */
const textWithState: HTMLConverterAsync<{ type: 'text'; text: string; format: number; $?: unknown }> = async (args) => {
  const inner = TextHTMLConverterAsync.text as (args: unknown) => Promise<string> | string;
  const html = await inner(args);
  const attribute = textStateAttribute(args.node.$);
  return attribute === undefined ? html : `<span data-s="${attribute}">${html}</span>`;
};

export const lexicalHtml = async (payload: Payload): Promise<LexicalCodec> => {
  const editorConfig = await sanitizeServerEditorConfig({ ...defaultEditorConfig, features: [...defaultEditorFeatures] }, payload.config);
  const nodes = getEnabledNodes({ editorConfig });
  const converters = { ...defaultHTMLConvertersAsync, ...LinkHTMLConverterAsync({ internalDocToHref }), text: textWithState };
  // One editor and one DOM for the codec's lifetime; each parse clears the editor. `discrete` updates are synchronous, so calls never overlap.
  const editor = createHeadlessEditor({ nodes });
  const withDom = createDomParser();

  return {
    toHtml: (node) =>
      convertLexicalToHTMLAsync({
        converters,
        data: { root: { type: 'root', format: '', indent: 0, version: 1, direction: null, children: [node] } } as Parameters<typeof convertLexicalToHTMLAsync>[0]['data'],
        disableContainer: true,
      }),

    fromHtml: (html) => {
      editor.update(
        () => {
          withDom(html, (document) => {
            escapeTextNewlines(document);
            markTextState(document);
            const parsed = $generateNodesFromDOM(editor, document);
            $getRoot().clear();
            $getRoot().select();
            $getSelection()?.insertNodes(parsed);
          });
        },
        { discrete: true },
      );
      const state = unescapeNewlines(editor.getEditorState().toJSON()) as { root?: { children?: LexicalNode[] } };
      const block = state.root?.children?.[0];
      return block && restoreTextState(block);
    },
  };
};
