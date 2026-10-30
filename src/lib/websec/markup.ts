// What a comment turns into once a browser parses it as HTML. The page never
// runs any of it: the browser's DOMParser builds an inert document (no scripts,
// no loading), the widget converts that into this plain tree, and these
// functions say which parts would have run had the comment been put into a
// live page as HTML.

export type MNode = { text: string } | { tag: string; attrs: [string, string][]; children: MNode[] };
export type Danger = { what: string; why: string };

// Formatting a comment may legitimately carry. Anything else is shown as a
// labelled box rather than recreated.
export const HARMLESS = new Set(['b', 'i', 'em', 'strong', 'u', 's', 'code', 'br', 'p', 'span']);

const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'data']);

export function dangersOf(node: MNode): Danger[] {
  if ('text' in node) return [];
  const out: Danger[] = [];
  const tag = node.tag.toLowerCase();
  if (tag === 'script') out.push({ what: '<script>', why: 'runs when a server puts it in the page. (Inserted later with innerHTML it stays inert - which is why attackers use the next kind instead.)' });
  for (const [name, value] of node.attrs) {
    const n = name.toLowerCase();
    if (n.startsWith('on')) out.push({ what: `<${tag} ${n}>`, why: 'is an event handler: its text runs as JavaScript, however the HTML got into the page.' });
    if (URL_ATTRS.has(n) && /^\s*javascript:/i.test(value)) out.push({ what: `<${tag} ${n}="javascript:...">`, why: 'runs code when the link is followed.' });
  }
  if (['iframe', 'object', 'embed'].includes(tag)) out.push({ what: `<${tag}>`, why: 'embeds another document inside this one, outside your control.' });
  return out.concat(node.children.flatMap(dangersOf));
}

export const hasMarkup = (nodes: MNode[]) => nodes.some((n) => !('text' in n));

/** What textContent does: every character is shown, nothing is parsed. */
export function asText(input: string): MNode[] {
  return input ? [{ text: input }] : [];
}
