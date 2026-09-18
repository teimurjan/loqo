import { type ExtractedField, isPlainObject, type Path, type RestorableField } from '@opendeepl/sdk';

export type LexicalNode = { type: string; children?: LexicalNode[]; [key: string]: unknown };

/**
 * Lexical ↔ HTML. The real one (`@opendeepl/payload/lexical`) needs the editor config that only the
 * running app has, which is why it is injected rather than imported.
 */
export type LexicalCodec = {
  toHtml(node: LexicalNode): Promise<string> | string;
  /** `undefined` when the HTML yields no node — the target is rejected rather than written as a string. */
  fromHtml(html: string): Promise<LexicalNode | undefined> | LexicalNode | undefined;
};

/** Node types translated as one HTML fragment each. */
const TRANSFORMABLE: ReadonlySet<string> = new Set(['paragraph', 'heading', 'list', 'quote', 'collapsible-title', 'text']);
/** Types the HTML converter does not know; they travel as paragraphs and get their type back on the way in. */
const AS_PARAGRAPH: ReadonlySet<string> = new Set(['collapsible-title']);

export const isLexicalNode = (value: unknown): value is LexicalNode => isPlainObject(value) && typeof value.type === 'string';

const hasText = (node: LexicalNode): boolean =>
  node.type === 'text' ? typeof node.text === 'string' && node.text.length > 0 : (node.children ?? []).some(hasText);

const hasBlockChildren = (node: LexicalNode): boolean => (node.children ?? []).some((child) => child.type !== 'text' && TRANSFORMABLE.has(child.type));

/** The HTML for a node the extractor would emit, or `undefined` when it is not one. */
export const nodeToHtml = async (node: unknown, codec: LexicalCodec): Promise<string | undefined> => {
  if (!isLexicalNode(node) || !TRANSFORMABLE.has(node.type) || !hasText(node) || hasBlockChildren(node)) return undefined;
  return codec.toHtml(AS_PARAGRAPH.has(node.type) ? { ...node, type: 'paragraph' } : node);
};

/** The node for a translated HTML fragment, typed back as the source node was. */
export const htmlToNode = async (html: string, subType: string | undefined, codec: LexicalCodec): Promise<LexicalNode | undefined> => {
  const node = await codec.fromHtml(html);
  return node && subType ? { ...node, type: subType } : node;
};

/**
 * One field per translatable block-level node. Empty paragraphs are skipped (their HTML
 * round-trips to nothing), nested block nodes are split so no `<p><p>` is ever produced.
 */
export const extractRichText = async (node: unknown, path: Path, codec: LexicalCodec): Promise<ExtractedField[]> => {
  if (!isLexicalNode(node)) return [];
  if (node.type === 'block') {
    const html = isPlainObject(node.fields) ? node.fields.html : undefined;
    return typeof html === 'string' ? [{ path: [...path, 'fields', 'html'], value: html, kind: 'text' }] : [];
  }
  const descend = async () =>
    (await Promise.all((node.children ?? []).map((child, index) => extractRichText(child, [...path, 'children', index], codec)))).flat();

  if (!TRANSFORMABLE.has(node.type)) return descend();
  if (!hasText(node)) return [];
  if (hasBlockChildren(node)) return descend();
  const html = await nodeToHtml(node, codec);
  if (html === undefined) return [];
  return [{ path, value: html, kind: 'richText', meta: AS_PARAGRAPH.has(node.type) ? { subType: node.type } : undefined }];
};

/** What the HTML round trip loses and the source tree must give back by position: whole upload nodes. */
export const extractRichTextRestorable = (node: unknown, path: Path): RestorableField[] => {
  if (!isLexicalNode(node)) return [];
  if (node.type === 'upload') return [{ path, value: node }];
  return (node.children ?? []).flatMap((child, index) => extractRichTextRestorable(child, [...path, 'children', index]));
};

const LINK_TYPES: ReadonlySet<string> = new Set(['link', 'autolink']);

/**
 * The `href` a link's fields serialize to, and so the key its parsed counterpart is matched on. An
 * internal link names its document; the target is a relation the model never needs to see.
 */
export const linkHref = (fields: unknown): string | undefined => {
  if (!isPlainObject(fields)) return undefined;
  if (fields.linkType === 'internal') {
    const doc = isPlainObject(fields.doc) ? fields.doc : undefined;
    const id = doc && isPlainObject(doc.value) ? doc.value.id : doc?.value;
    return typeof doc?.relationTo === 'string' && id !== undefined ? `#${doc.relationTo}/${String(id)}` : '#';
  }
  return typeof fields.url === 'string' ? fields.url : undefined;
};

const collectLinks = (node: LexicalNode, found: LexicalNode[] = []): LexicalNode[] => {
  if (LINK_TYPES.has(node.type)) found.push(node);
  for (const child of node.children ?? []) collectLinks(child, found);
  return found;
};

/**
 * What a translated block takes back from its source block: the block's own alignment and indent
 * (layout, not language — and `start` is not `left` in an RTL locale), and for every link its
 * fields, id and type. Translation moves and reorders inline nodes, so a link is matched by its
 * href, in order of appearance, never by position. An href the source does not have — the model
 * invented or mangled it — keeps what the parser made of it.
 */
export const restoreFromSource = (translated: LexicalNode, source: LexicalNode): LexicalNode => {
  const byHref = new Map<string, LexicalNode[]>();
  for (const link of collectLinks(source)) {
    const href = linkHref(link.fields);
    if (href !== undefined) byHref.set(href, [...(byHref.get(href) ?? []), link]);
  }
  const rebuild = (node: LexicalNode): LexicalNode => {
    if (LINK_TYPES.has(node.type)) {
      const href = isPlainObject(node.fields) && typeof node.fields.url === 'string' ? node.fields.url : undefined;
      const match = href === undefined ? undefined : byHref.get(href)?.shift();
      if (!match) return node;
      return { ...node, type: match.type, fields: match.fields, ...(match.id === undefined ? {} : { id: match.id }) };
    }
    return node.children ? { ...node, children: node.children.map(rebuild) } : node;
  };
  const layout = { ...(source.format === undefined ? {} : { format: source.format }), ...(source.indent === undefined ? {} : { indent: source.indent }) };
  return { ...rebuild(translated), ...layout };
};
