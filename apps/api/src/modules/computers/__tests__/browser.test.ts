/** The browser's pure parts: page snapshots, text, redaction, which URLs open, which keys exist. */

import { describe, expect, it } from 'vitest';
import { browsableUrl, BrowserRefusal, ownOrigins, parseKey, readableUrl } from '../browser.js';
import { buildSnapshot, compactText, redactor, windowOf, type AxNode } from '../snapshot.js';

let next = 0;
function node(role: string, name = '', extra: Partial<AxNode> = {}, children: AxNode[] = []): AxNode[] {
  const id = `n${next++}`;
  const own: AxNode = {
    nodeId: id,
    role: { value: role },
    name: { value: name },
    childIds: children.filter((child) => !child.parentId).map((child) => child.nodeId),
    ...extra,
  };
  for (const child of children) if (!child.parentId) child.parentId = id;
  return [own, ...children];
}
/** Builds a tree from nested lists: each list is a node followed by its subtree. */
function tree(role: string, name: string, extra: Partial<AxNode>, ...kids: AxNode[][]): AxNode[] {
  const flat = kids.flat();
  const roots = kids.map((kid) => kid[0]!);
  const id = `n${next++}`;
  for (const root of roots) root.parentId = id;
  return [
    { nodeId: id, role: { value: role }, name: { value: name }, childIds: roots.map((root) => root.nodeId), ...extra },
    ...flat,
  ];
}

describe('page snapshots', () => {
  const login = () =>
    tree(
      'RootWebArea',
      'Sign in',
      {},
      tree('heading', 'Sign in to Example', { properties: [{ name: 'level', value: { value: 1 } }] }),
      tree('generic', '', {}, node('StaticText', 'Use your work'), node('StaticText', 'account.')),
      tree(
        'form',
        '',
        {},
        node('textbox', 'Email', { backendDOMNodeId: 11, value: { value: 'lin@example.com' } }),
        node('textbox', 'Password', { backendDOMNodeId: 12, value: { value: '••••••••' } }),
        node('checkbox', 'Remember me', {
          backendDOMNodeId: 13,
          properties: [{ name: 'checked', value: { value: 'false' } }],
        }),
        node('button', 'Sign in', { backendDOMNodeId: 14, properties: [{ name: 'disabled', value: { value: true } }] }),
      ),
      tree('generic', '', { ignored: true }, node('link', 'Forgot password?', { backendDOMNodeId: 15 })),
      tree(
        'table',
        '',
        {},
        tree(
          'row',
          '',
          {},
          tree('cell', '', {}, node('StaticText', 'Plan')),
          tree('cell', '', {}, node('StaticText', 'Free')),
        ),
      ),
    );

  it('folds the tree into short lines with a ref on everything that acts', () => {
    const snapshot = buildSnapshot(login());
    expect(snapshot.lines).toEqual([
      '- heading h1 "Sign in to Example"',
      '- text: Use your work account.',
      '- form',
      '  - textbox "Email" value="lin@example.com" [e1]',
      '  - textbox "Password" [e2]',
      '  - checkbox "Remember me" (unchecked) [e3]',
      '  - button "Sign in" (disabled) [e4]',
      '- link "Forgot password?" [e5]',
      '- table',
      '  - row: Plan | Free',
    ]);
    expect([...snapshot.refs]).toEqual([
      ['e1', 11],
      ['e2', 12],
      ['e3', 13],
      ['e4', 14],
      ['e5', 15],
    ]);
  });

  it('redacts vault values before anything is shortened', () => {
    const secret = 'correct-horse-battery-staple';
    const nodes = tree(
      'RootWebArea',
      '',
      {},
      node('textbox', 'Password', { backendDOMNodeId: 1, value: { value: secret } }),
      node('StaticText', `Your password is ${secret}${'!'.repeat(400)}`),
      node('link', `${'x'.repeat(110)}${secret}`, { backendDOMNodeId: 2 }),
    );
    const text = buildSnapshot(nodes, redactor([secret])).lines.join('\n');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(secret.slice(0, 8));
    expect(text).toContain('[hidden]');
  });

  it('shows the first choices of a long list and says how many more there are', () => {
    const options = Array.from({ length: 30 }, (_, index) =>
      node('option', `Country ${index + 1}`, { backendDOMNodeId: 100 + index }),
    );
    const lines = buildSnapshot(tree('listbox', 'Country', { backendDOMNodeId: 99 }, ...options)).lines;
    expect(lines[0]).toBe('- listbox "Country" [e1]');
    expect(lines[1]).toBe('  - option "Country 1" [e2]');
    expect(lines).toHaveLength(27);
    expect(lines.at(-1)).toBe('  - … 5 more');
  });

  it('pages a long snapshot by line within a size', () => {
    const lines = Array.from({ length: 10 }, (_, index) => `- text: line ${index + 1}`);
    const first = windowOf(lines, 1, 40);
    expect(first.text.split('\n')).toEqual(['- text: line 1', '- text: line 2']);
    expect(first.next).toBe(3);
    const rest = windowOf(lines, 9, 1000);
    expect(rest).toMatchObject({ first: 9, last: 10, total: 10, next: null });
  });

  it('compacts visible text and redacts the longest value first', () => {
    expect(compactText('  a   b\r\n\n\n\nc\t\td  ')).toBe('a b\n\nc d');
    const redact = redactor(['abc', 'secret', 'secret-longer']);
    expect(redact('secret-longer and secret and abc')).toBe('[hidden] and [hidden] and abc');
    expect(redactor([])('anything')).toBe('anything');
  });
});

describe('what the browser opens and reads', () => {
  const own = ownOrigins({ PUBLIC_URL: 'https://gh.example.com/', corsAllowedOrigins: ['https://app.example.com'] });

  it('knows Greenhouse’s own origins', () => {
    expect(own).toEqual(['https://gh.example.com', 'https://app.example.com']);
  });

  it('opens http and https only, never with a login inside or onto Greenhouse', () => {
    expect(browsableUrl('example.com/path?q=1', own)).toEqual({ url: 'https://example.com/path?q=1' });
    expect(browsableUrl('http://localhost:8765/login', own)).toEqual({ url: 'http://localhost:8765/login' });
    expect(browsableUrl('about:blank', own)).toEqual({ url: 'about:blank' });
    for (const url of [
      'file:///etc/passwd',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'javascript:alert(1)',
      'data:text/html,hi',
      'view-source:https://example.com',
      'chrome-extension://abc/page.html',
      'about:config',
      'ftp://example.com',
    ]) {
      expect(browsableUrl(url, own)).toMatchObject({ code: 'url_forbidden' });
    }
    expect(browsableUrl('https://user:pw@example.com', own)).toMatchObject({ code: 'url_forbidden' });
    expect(browsableUrl('https://gh.example.com/#/agents', own)).toMatchObject({ code: 'url_forbidden' });
    expect(browsableUrl('', own)).toBeInstanceOf(BrowserRefusal);
    expect(browsableUrl('http://[bad', own)).toMatchObject({ code: 'url_invalid' });
  });

  it('reads web pages, a blank tab, the error page and the welcome page, nothing else', () => {
    for (const url of [
      'https://example.com/',
      'about:blank',
      'chrome-error://chromewebdata/',
      'file:///opt/greenhouse/welcome.html',
    ]) {
      expect(readableUrl(url, own)).toBe(true);
    }
    for (const url of [
      'file:///home/browser/chromium/Default/Cookies',
      'chrome://newtab/',
      'https://app.example.com/',
    ]) {
      expect(readableUrl(url, own)).toBe(false);
    }
  });

  it('presses named keys, letters, digits and shortcuts', () => {
    expect(parseKey('Enter')).toMatchObject({ def: { key: 'Enter', keyCode: 13, text: '\r' }, modifiers: 0 });
    expect(parseKey('a')).toMatchObject({ def: { key: 'a', code: 'KeyA', text: 'a' } });
    expect(parseKey('Shift+a')).toMatchObject({ def: { key: 'A', text: 'A' }, modifiers: 8 });
    expect(parseKey('Control+A')?.def.text).toBeUndefined();
    expect(parseKey('Control+A')?.modifiers).toBe(2);
    expect(parseKey('F5')).toMatchObject({ def: { keyCode: 116 } });
    expect(parseKey('Hyper+A')).toBeNull();
    expect(parseKey('Enterprise')).toBeNull();
  });
});
