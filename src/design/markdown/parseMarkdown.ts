// markdown-it 15 ships its own type declarations.
import MarkdownIt, {type Token} from 'markdown-it';

/**
 * Safe, bounded Markdown → Namu AST (S04, SEC-003, T20).
 *  - HTML is disabled: tags render as literal text.
 *  - Images are never loaded: they degrade to their alt text.
 *  - Only http/https links survive, carrying the real hostname for the
 *    Open link confirmation; every other scheme degrades to text.
 *  - Nesting is limited to 12 and source size to 64 KiB; larger content falls
 *    back to plain text. Nothing here performs I/O.
 */
export const MAX_MARKDOWN_NESTING = 12;
export const MAX_MARKDOWN_SOURCE_BYTES = 64 * 1024;

export type InlineNode =
  | {type: 'text'; value: string}
  | {type: 'strong' | 'em' | 'strike'; children: InlineNode[]}
  | {type: 'code'; value: string}
  | {type: 'link'; href: string; hostname: string; children: InlineNode[]}
  | {type: 'break'};

export type BlockNode =
  | {type: 'paragraph'; children: InlineNode[]}
  | {type: 'heading'; level: number; children: InlineNode[]}
  | {type: 'list'; ordered: boolean; start: number; items: BlockNode[][]}
  | {type: 'blockquote'; children: BlockNode[]}
  | {type: 'codeBlock'; value: string}
  | {type: 'rule'}
  | {type: 'table'; header: InlineNode[][]; rows: InlineNode[][][]};

export interface ParsedMarkdown {
  blocks: BlockNode[];
  /** True when limits forced the plain-text fallback. */
  plainFallback: boolean;
}

const md = new MarkdownIt({html: false, linkify: false, typographer: false, breaks: false, maxNesting: MAX_MARKDOWN_NESTING});
// Images stay enabled in the parser only so they can be recognised and
// replaced by their alt text below; no image node exists and nothing is fetched.

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Returns the host to show the user, or null when the link is not allowed. */
export function safeLinkHost(href: string): string | null {
  const match = /^(https?):\/\/([^/?#\s\\]+)/i.exec(href.trim());
  if (!match) {
    return null;
  }
  // The real host is after any userinfo ("https://trusted.example@evil.example").
  const authority = match[2]!;
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  const host = hostPort.replace(/:\d+$/, '').toLowerCase();
  if (host.length === 0 || !/^[a-z0-9.\-[\]:_~%¡-￿]+$/i.test(host)) {
    return null;
  }
  return host;
}

export function plainText(source: string): ParsedMarkdown {
  return {blocks: [{type: 'paragraph', children: [{type: 'text', value: source}]}], plainFallback: true};
}

export function parseMarkdown(source: string): ParsedMarkdown {
  if (utf8ByteLength(source) > MAX_MARKDOWN_SOURCE_BYTES) {
    return plainText(source);
  }
  let tokens: Token[];
  try {
    tokens = md.parse(source, {});
  } catch {
    return plainText(source);
  }
  try {
    const cursor = {i: 0};
    const blocks = readBlocks(tokens, cursor, null, 0);
    return {blocks, plainFallback: false};
  } catch {
    return plainText(source);
  }
}

class TooDeep extends Error {}

function readBlocks(tokens: Token[], cursor: {i: number}, until: string | null, depth: number): BlockNode[] {
  if (depth > MAX_MARKDOWN_NESTING) {
    throw new TooDeep();
  }
  const out: BlockNode[] = [];
  while (cursor.i < tokens.length) {
    const token = tokens[cursor.i]!;
    if (until !== null && token.type === until) {
      cursor.i++;
      return out;
    }
    cursor.i++;
    switch (token.type) {
      case 'paragraph_open':
        out.push({type: 'paragraph', children: readInlineUntil(tokens, cursor, 'paragraph_close')});
        break;
      case 'heading_open':
        out.push({
          type: 'heading',
          level: Number(token.tag.slice(1)) || 1,
          children: readInlineUntil(tokens, cursor, 'heading_close'),
        });
        break;
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const ordered = token.type === 'ordered_list_open';
        const close = ordered ? 'ordered_list_close' : 'bullet_list_close';
        const items: BlockNode[][] = [];
        while (cursor.i < tokens.length && tokens[cursor.i]!.type !== close) {
          if (tokens[cursor.i]!.type === 'list_item_open') {
            cursor.i++;
            items.push(readBlocks(tokens, cursor, 'list_item_close', depth + 1));
          } else {
            cursor.i++;
          }
        }
        cursor.i++;
        out.push({type: 'list', ordered, start: Number(token.attrGet('start') ?? 1) || 1, items});
        break;
      }
      case 'blockquote_open':
        out.push({type: 'blockquote', children: readBlocks(tokens, cursor, 'blockquote_close', depth + 1)});
        break;
      case 'fence':
      case 'code_block':
        out.push({type: 'codeBlock', value: token.content.replace(/\n$/, '')});
        break;
      case 'hr':
        out.push({type: 'rule'});
        break;
      case 'table_open':
        out.push(readTable(tokens, cursor));
        break;
      case 'inline':
        out.push({type: 'paragraph', children: inlineNodes(token.children ?? [])});
        break;
      default:
        // Unsupported block constructs degrade to their text content.
        if (token.content) {
          out.push({type: 'paragraph', children: [{type: 'text', value: token.content}]});
        }
    }
  }
  return out;
}

function readInlineUntil(tokens: Token[], cursor: {i: number}, close: string): InlineNode[] {
  let children: InlineNode[] = [];
  while (cursor.i < tokens.length && tokens[cursor.i]!.type !== close) {
    const token = tokens[cursor.i]!;
    if (token.type === 'inline') {
      children = children.concat(inlineNodes(token.children ?? []));
    }
    cursor.i++;
  }
  cursor.i++;
  return children;
}

function readTable(tokens: Token[], cursor: {i: number}): BlockNode {
  const header: InlineNode[][] = [];
  const rows: InlineNode[][][] = [];
  let current: InlineNode[][] | null = null;
  let inHead = false;
  while (cursor.i < tokens.length && tokens[cursor.i]!.type !== 'table_close') {
    const token = tokens[cursor.i]!;
    cursor.i++;
    if (token.type === 'thead_open') {
      inHead = true;
    } else if (token.type === 'thead_close') {
      inHead = false;
    } else if (token.type === 'tr_open') {
      current = [];
    } else if (token.type === 'tr_close') {
      if (current) {
        if (inHead) {
          header.push(...current);
        } else {
          rows.push(current);
        }
      }
      current = null;
    } else if (token.type === 'inline' && current) {
      current.push(inlineNodes(token.children ?? []));
    }
  }
  cursor.i++;
  return {type: 'table', header, rows};
}

function inlineNodes(tokens: Token[]): InlineNode[] {
  const root: InlineNode[] = [];
  const stack: InlineNode[][] = [root];
  const top = () => stack[stack.length - 1]!;
  const open = (node: InlineNode & {children: InlineNode[]}) => {
    if (stack.length > MAX_MARKDOWN_NESTING) {
      throw new TooDeep();
    }
    top().push(node);
    stack.push(node.children);
  };
  const close = () => {
    if (stack.length > 1) {
      stack.pop();
    }
  };
  /** Links with a disallowed scheme render only their text. */
  const linkIsReal: boolean[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        top().push({type: 'text', value: token.content});
        break;
      case 'code_inline':
        top().push({type: 'code', value: token.content});
        break;
      case 'softbreak':
        top().push({type: 'text', value: '\n'});
        break;
      case 'hardbreak':
        top().push({type: 'break'});
        break;
      case 'strong_open':
        open({type: 'strong', children: []});
        break;
      case 'em_open':
        open({type: 'em', children: []});
        break;
      case 's_open':
        open({type: 'strike', children: []});
        break;
      case 'strong_close':
      case 'em_close':
      case 's_close':
        close();
        break;
      case 'link_open': {
        const href = String(token.attrGet('href') ?? '');
        const hostname = safeLinkHost(href);
        if (hostname) {
          linkIsReal.push(true);
          open({type: 'link', href, hostname, children: []});
        } else {
          linkIsReal.push(false);
        }
        break;
      }
      case 'link_close':
        if (linkIsReal.pop()) {
          close();
        }
        break;
      case 'image':
        // SEC-003: Markdown images are disabled; only the alt text is shown.
        if (token.content) {
          top().push({type: 'text', value: token.content});
        }
        break;
      default:
        if (token.content) {
          top().push({type: 'text', value: token.content});
        }
    }
  }
  return root;
}

/** Plain-text projection used for previews and clipboard-free summaries. */
export function markdownToPlainText(source: string, maxLength = 160): string {
  const flat = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_~>#]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1).trimEnd()}…` : flat;
}
