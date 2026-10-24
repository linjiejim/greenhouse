import { describe, expect, it } from 'vitest';
import { classifyLink, domainOf, meaningfulLabel } from './link-chip';

const BASE = 'https://green.example.com';

describe('link chips', () => {
  it('turns station links and app routes into object chips', () => {
    const doc = classifyLink('#/knowledge/doc/12-weekly', '10 月广告周报', BASE);
    expect(doc).toMatchObject({ kind: 'object', type: 'doc', label: '10 月广告周报' });
    expect(doc.kind === 'object' && doc.resolveUrl).toBe('https://green.example.com/#/knowledge/doc/12-weekly');
    expect(classifyLink(`${BASE}/#/projects/3?task=9`, undefined, BASE)).toMatchObject({ kind: 'object', type: 'task' });
    expect(classifyLink('#/files?shelf=team&folder=4', 'x', BASE)).toMatchObject({ kind: 'object', type: 'folder' });
    expect(classifyLink('#/chat?session=abc', 'chat', BASE)).toMatchObject({ kind: 'object', type: 'chat' });
  });

  it('turns files the station serves into file chips', () => {
    expect(classifyLink('/api/chat-files/f_1/content', '投放明细.xlsx', BASE)).toMatchObject({
      kind: 'file',
      id: 'f_1',
      label: '投放明细.xlsx',
      resolveUrl: 'https://green.example.com/api/chat-files/f_1/content',
    });
    expect(classifyLink(`${BASE}/api/drive/files/7/content`, undefined, BASE)).toMatchObject({ kind: 'file', id: '7' });
  });

  it('collapses other addresses into their domain', () => {
    const long = 'https://www.amazon.com/gp/help/customer/display.html?nodeId=GZ8D3PFRQG4YM4WK&ref=xyz';
    expect(classifyLink(long, long, BASE)).toEqual({ kind: 'site', url: long, domain: 'amazon.com', label: null });
    expect(classifyLink('https://amazon.com/ads', '广告帮助', BASE)).toMatchObject({ kind: 'site', label: '广告帮助' });
  });

  it('leaves mail and phone links, and what is not a link, as plain text', () => {
    expect(classifyLink('mailto:a@b.c', 'a', BASE).kind).toBe('plain');
    expect(classifyLink('javascript:alert(1)', 'x', BASE).kind).toBe('plain');
  });

  it('drops words that only repeat the address', () => {
    expect(meaningfulLabel('https://x.com/a/', 'https://x.com/a')).toBeNull();
    expect(meaningfulLabel('x.com/a', 'https://x.com/a')).toBeNull();
    expect(meaningfulLabel('  ', 'https://x.com')).toBeNull();
    expect(meaningfulLabel('Docs', 'https://x.com')).toBe('Docs');
    expect(domainOf('not a url')).toBe('not a url');
  });
});
