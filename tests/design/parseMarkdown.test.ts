import {
  MAX_MARKDOWN_SOURCE_BYTES,
  parseMarkdown,
  safeLinkHost,
  type BlockNode,
  type InlineNode,
} from '../../src/design/markdown/parseMarkdown';

function collect(blocks: BlockNode[]): {texts: string[]; links: {href: string; hostname: string}[]; types: string[]} {
  const texts: string[] = [];
  const links: {href: string; hostname: string}[] = [];
  const types: string[] = [];
  const inline = (nodes: InlineNode[]) => {
    for (const n of nodes) {
      types.push(n.type);
      if (n.type === 'text' || n.type === 'code') {
        texts.push(n.value);
      } else if (n.type === 'link') {
        links.push({href: n.href, hostname: n.hostname});
        inline(n.children);
      } else if (n.type !== 'break') {
        inline(n.children);
      }
    }
  };
  const block = (nodes: BlockNode[]) => {
    for (const b of nodes) {
      types.push(b.type);
      if (b.type === 'paragraph' || b.type === 'heading') {
        inline(b.children);
      } else if (b.type === 'list') {
        b.items.forEach(block);
      } else if (b.type === 'blockquote') {
        block(b.children);
      } else if (b.type === 'codeBlock') {
        texts.push(b.value);
      } else if (b.type === 'table') {
        b.header.forEach(inline);
        b.rows.forEach(r => r.forEach(inline));
      }
    }
  };
  block(blocks);
  return {texts, links, types};
}

describe('S04 supported Markdown', () => {
  it('parses paragraphs, emphasis, lists, quotes, code, links and tables', () => {
    const {blocks, plainFallback} = parseMarkdown(
      ['# Title', '', 'Some **bold** and *italic* and `code`.', '', '- one', '- two', '', '1. first', '',
        '> quoted', '', '```', 'x = 1', '```', '', '[site](https://example.org/path)', '',
        '| a | b |', '|---|---|', '| 1 | 2 |'].join('\n'),
    );
    expect(plainFallback).toBe(false);
    const {types, links} = collect(blocks);
    for (const t of ['heading', 'paragraph', 'strong', 'em', 'code', 'list', 'blockquote', 'codeBlock', 'link', 'table']) {
      expect(types).toContain(t);
    }
    expect(links).toEqual([{href: 'https://example.org/path', hostname: 'example.org'}]);
  });
});

describe('T20 hostile Markdown', () => {
  it('renders HTML as inert text', () => {
    const {blocks} = parseMarkdown('<script>alert(1)</script>\n\n<img src="https://tracker.example/p.gif" onerror="x()">');
    const {texts, types} = collect(blocks);
    expect(texts.join(' ')).toContain('<script>alert(1)</script>');
    expect(types.every(t => ['paragraph', 'text'].includes(t))).toBe(true);
  });

  it('never produces an image node or a fetchable image URL', () => {
    const {blocks} = parseMarkdown('![alt text](https://tracker.example/pixel.png)');
    const {types, links} = collect(blocks);
    expect(types).not.toContain('image');
    expect(links).toEqual([]);
    expect(collect(blocks).texts.join('')).toBe('alt text');
  });

  it('drops javascript:, data:, file:, intent: and custom-scheme links but keeps their text', () => {
    const source = [
      '[a](javascript:alert(1))', '[b](data:text/html;base64,AAAA)', '[c](file:///etc/passwd)',
      '[d](intent://evil#Intent;end)', '[e](namu://secret)', '[f](JaVaScRiPt:alert(1))', '[ok](http://example.com)',
    ].join(' ');
    const {links, texts} = collect(parseMarkdown(source).blocks);
    expect(links).toEqual([{href: 'http://example.com', hostname: 'example.com'}]);
    expect(texts.join('')).toContain('ok');
  });

  it('shows the real host, not the userinfo decoy', () => {
    expect(safeLinkHost('https://bank.example@evil.example/login')).toBe('evil.example');
    expect(safeLinkHost('https://example.org:8443/x')).toBe('example.org');
    expect(safeLinkHost('//example.org')).toBeNull();
    expect(safeLinkHost('https://')).toBeNull();
    expect(safeLinkHost(' https://ok.example ')).toBe('ok.example');
  });

  it('bounds deep nesting without throwing or hanging', () => {
    const deepQuote = '>'.repeat(200) + ' deep';
    const deepList = Array.from({length: 60}, (_, i) => `${'  '.repeat(i)}- level ${i}`).join('\n');
    const deepEmphasis = '*'.repeat(400) + 'x' + '*'.repeat(400);
    for (const source of [deepQuote, deepList, deepEmphasis]) {
      const started = Date.now();
      const parsed = parseMarkdown(source);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(parsed.blocks.length).toBeGreaterThan(0);
      let depth = 0;
      const walk = (b: BlockNode[], d: number) => {
        depth = Math.max(depth, d);
        for (const n of b) {
          if (n.type === 'blockquote') {
            walk(n.children, d + 1);
          } else if (n.type === 'list') {
            n.items.forEach(item => walk(item, d + 1));
          }
        }
      };
      walk(parsed.blocks, 0);
      expect(depth).toBeLessThanOrEqual(13);
    }
  });

  it('falls back to plain text above 64 KiB of source', () => {
    const big = '**bold** '.repeat(Math.ceil(MAX_MARKDOWN_SOURCE_BYTES / 9) + 10);
    const parsed = parseMarkdown(big);
    expect(parsed.plainFallback).toBe(true);
    expect(parsed.blocks).toEqual([{type: 'paragraph', children: [{type: 'text', value: big}]}]);
  });

  it('preserves Hausa letters and accents exactly', () => {
    const {texts} = collect(parseMarkdown('Ƙasa ɗaya, ɓangare — l’école ƴaƴa').blocks);
    expect(texts.join('')).toBe('Ƙasa ɗaya, ɓangare — l’école ƴaƴa');
  });
});
