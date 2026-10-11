import { describe, expect, it } from 'vitest';
import {
  APP_SANDBOX_CSP,
  APP_SANDBOX_ERRORS,
  APP_SANDBOX_LIMITS,
  APP_SANDBOX_PRELUDE,
  APP_SANDBOX_PROTOCOL_VERSION,
  APP_SANDBOX_STANDARD_VARIABLES,
  APP_SANDBOX_THEME_TOKENS,
  appSandboxError,
  appSandboxInitializeResult,
  appSandboxThemeVariables,
  appSandboxToolResult,
  buildAppSandboxDocument,
  escapeCssValue,
  isAppSandboxThemeVariable,
  parseAppSandboxMessage,
  parseAppSandboxToolCall,
  sanitizeThemeVariables,
  utf8ByteLength,
} from './app-sandbox.js';

describe('the component document', () => {
  const html = '<div id="root"></div><script>window.greenhouse.ready.then(() => {})</script>';

  it('puts the CSP first in <head>, then the theme style, then the prelude, then the body', () => {
    const doc = buildAppSandboxDocument({ html, theme: 'dark', variables: { '--t-fg': '#fff' } });
    const head = doc.slice(doc.indexOf('<head>') + '<head>'.length);
    expect(
      head.trimStart().startsWith(`<meta http-equiv="Content-Security-Policy" content="${APP_SANDBOX_CSP}">`),
    ).toBe(true);
    const csp = doc.indexOf('Content-Security-Policy');
    const dns = doc.indexOf('x-dns-prefetch-control');
    const style = doc.indexOf('<style>');
    const prelude = doc.indexOf('<script>(function () {');
    const body = doc.indexOf('<body>');
    const component = doc.indexOf(html);
    expect(csp).toBeGreaterThan(0);
    expect(dns).toBeGreaterThan(csp);
    expect(style).toBeGreaterThan(dns);
    expect(prelude).toBeGreaterThan(style);
    expect(body).toBeGreaterThan(prelude);
    expect(component).toBeGreaterThan(body);
    // The component's code is the only thing in the body.
    expect(doc.indexOf('</head>')).toBeLessThan(body);
  });

  it('is the CSP of the spec, word for word', () => {
    expect(APP_SANDBOX_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'",
    );
  });

  it('writes only whitelisted, safe theme variables into the style', () => {
    const doc = buildAppSandboxDocument({
      html: '',
      theme: 'light',
      variables: {
        '--t-fg': 'rgb(20 20 20)',
        '--t-surface-card': '</style><script>alert(1)</script>',
        '--evil': 'red',
        '--color-text-primary': 'rgb(20 20 20)',
        '--primary-500': '53 133 102',
      },
    });
    const style = doc.slice(doc.indexOf('<style>'), doc.indexOf('</style>') + '</style>'.length);
    expect(style).toContain('--t-fg:rgb(20 20 20);');
    expect(style).toContain('--color-text-primary:rgb(20 20 20);');
    expect(style).toContain('--primary-500:53 133 102;');
    expect(style).toContain('color-scheme:light;');
    expect(style).not.toContain('--evil');
    expect(style).not.toContain('alert');
    // One closing tag only: the escape attempt never reached the document.
    expect(doc.split('</style>')).toHaveLength(2);
    expect(doc).toContain('<html data-theme="light">');
  });

  it('never lets a theme name be anything but light or dark', () => {
    const doc = buildAppSandboxDocument({
      html: '',
      theme: '"><script>' as unknown as 'light',
      variables: {},
    });
    expect(doc).toContain('<html data-theme="light">');
  });

  it('carries a prelude that parses, never closes its own script tag, and speaks the pinned protocol', () => {
    expect(() => new Function(APP_SANDBOX_PRELUDE)).not.toThrow();
    expect(APP_SANDBOX_PRELUDE).not.toMatch(/<\/script/i);
    expect(APP_SANDBOX_PRELUDE).toContain(`protocolVersion: '${APP_SANDBOX_PROTOCOL_VERSION}'`);
    expect(APP_SANDBOX_PRELUDE).toContain('RTCPeerConnection');
  });
});

describe('the bridge prelude, run against a fake window', () => {
  function harness() {
    const posted: Array<Record<string, unknown>> = [];
    const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
    const properties = new Map<string, string>();
    const attributes = new Map<string, string>();
    const parent = { postMessage: (message: Record<string, unknown>) => posted.push(message) };
    const windowLike: Record<string, unknown> = {
      parent,
      RTCPeerConnection: function RTCPeerConnection() {},
      addEventListener: (type: string, listener: (event: { source: unknown; data: unknown }) => void) => {
        if (type === 'message') listeners.push(listener);
      },
    };
    const documentLike = {
      body: null,
      addEventListener: () => {},
      documentElement: {
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        style: {
          colorScheme: '',
          setProperty: (name: string, value: string) => properties.set(name, value),
        },
      },
    };
    new Function('window', 'document', APP_SANDBOX_PRELUDE)(windowLike, documentLike);
    const deliver = (data: unknown, source: unknown = parent) => {
      for (const listener of listeners) listener({ source, data });
    };
    return { posted, deliver, properties, attributes, windowLike, documentLike };
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('takes WebRTC away, initializes, applies the host context and calls tools through the host', async () => {
    const { posted, deliver, properties, attributes, windowLike, documentLike } = harness();
    expect(windowLike.RTCPeerConnection).toBeUndefined();
    const api = windowLike.greenhouse as {
      query: (id: string, args?: unknown) => Promise<unknown>;
      action: (id: string, args: unknown) => Promise<unknown>;
    };
    expect(Object.isFrozen(api)).toBe(true);

    const init = posted[0]!;
    expect(init).toMatchObject({ jsonrpc: '2.0', method: 'ui/initialize' });
    expect(parseAppSandboxMessage(init)).toMatchObject({ ok: true, message: { type: 'initialize' } });

    const queried = api.query('tasks', { cursor: 'c1' });
    // A message from anywhere but the host is ignored.
    deliver({ jsonrpc: '2.0', id: init.id, result: { hostContext: { theme: 'light' } } }, {});
    await flush();
    expect(posted).toHaveLength(1);

    deliver(
      appSandboxResultFor(
        init.id as string,
        appSandboxInitializeResult({
          theme: 'dark',
          locale: 'zh-CN',
          styles: { variables: { '--t-fg': '#eee' } },
        }),
      ),
    );
    await flush();
    expect(attributes.get('data-theme')).toBe('dark');
    expect(documentLike.documentElement.style.colorScheme).toBe('dark');
    expect(properties.get('--t-fg')).toBe('#eee');
    expect(posted[1]).toEqual({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });

    const call = posted[2]!;
    expect(call).toMatchObject({
      method: 'tools/call',
      params: { name: 'query.tasks', arguments: { cursor: 'c1' } },
    });
    const parsed = parseAppSandboxMessage(call);
    expect(parsed).toMatchObject({
      ok: true,
      message: { type: 'tools/call', call: { kind: 'query', bindingId: 'tasks', arguments: { cursor: 'c1' } } },
    });
    const answer = { kind: 'kpi' as const, value: 3 };
    deliver(appSandboxResultFor(call.id as string, appSandboxToolResult(answer)));
    await expect(queried).resolves.toEqual(answer);

    // An action the host declines rejects with the bridge's code.
    const acted = api.action('approve', { recordId: 4 });
    await flush();
    const actionCall = posted[3]!;
    deliver(appSandboxError(actionCall.id as string, APP_SANDBOX_ERRORS.declined, 'Declined'));
    await expect(acted).rejects.toMatchObject({ code: APP_SANDBOX_ERRORS.declined });

    // Host context changes apply without a reload.
    deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light' } });
    expect(attributes.get('data-theme')).toBe('light');
  });
});

function appSandboxResultFor(id: string, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

describe('theme variables', () => {
  it('whitelists our tokens and the MCP Apps standard names, nothing else', () => {
    expect(isAppSandboxThemeVariable('--t-surface-card')).toBe(true);
    expect(isAppSandboxThemeVariable('--primary-500')).toBe(true);
    expect(isAppSandboxThemeVariable('--color-background-primary')).toBe(true);
    expect(isAppSandboxThemeVariable('--t-sidebar-active')).toBe(false);
    expect(isAppSandboxThemeVariable('--anything')).toBe(false);
    for (const token of Object.values(APP_SANDBOX_STANDARD_VARIABLES)) {
      expect(APP_SANDBOX_THEME_TOKENS).toContain(token);
    }
  });

  it('accepts real token values and refuses anything that could leave the declaration', () => {
    expect(escapeCssValue(' rgb(53 133 102 / 0.12) ')).toBe('rgb(53 133 102 / 0.12)');
    expect(escapeCssValue('"Nunito Variable", ui-sans-serif, system-ui')).toBe(
      '"Nunito Variable", ui-sans-serif, system-ui',
    );
    expect(escapeCssValue('#0f766e')).toBe('#0f766e');
    expect(escapeCssValue('0.75rem')).toBe('0.75rem');
    for (const bad of [
      'red; background: url(x)',
      '</style><script>',
      'a { b',
      'url(https://evil)',
      'expression(alert(1))',
      '@import "x"',
      '"unbalanced',
      'back\\slash',
      'tick`',
      'line\nbreak',
      '',
      'x'.repeat(APP_SANDBOX_LIMITS.variableValueLength + 1),
    ]) {
      expect(escapeCssValue(bad), bad).toBeNull();
    }
    expect(escapeCssValue(42)).toBeNull();
  });

  it('drops unknown names and refused values, and gives every alias its token value', () => {
    const values: Record<string, string> = {
      '--t-fg': '#111',
      '--t-surface-card': '</style>',
      '--radius-md': '0.5rem',
    };
    const variables = appSandboxThemeVariables((token) => values[token]);
    expect(variables['--t-fg']).toBe('#111');
    expect(variables['--color-text-primary']).toBe('#111');
    expect(variables['--border-radius-md']).toBe('0.5rem');
    expect(variables).not.toHaveProperty('--t-surface-card');
    expect(variables).not.toHaveProperty('--color-background-primary');
    expect(sanitizeThemeVariables({ '--x': 'red', '--t-fg': 'red' })).toEqual({ '--t-fg': 'red' });
  });
});

describe('incoming bridge messages', () => {
  it('parses the four methods the bridge answers', () => {
    expect(
      parseAppSandboxMessage({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: 'x' } }),
    ).toEqual({ ok: true, message: { type: 'initialize', id: 1, params: { protocolVersion: 'x' } } });
    expect(parseAppSandboxMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' })).toEqual({
      ok: true,
      message: { type: 'initialized' },
    });
    expect(
      parseAppSandboxMessage({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: 99999 } }),
    ).toEqual({ ok: true, message: { type: 'size-changed', height: APP_SANDBOX_LIMITS.maxHeight } });
    expect(
      parseAppSandboxMessage(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 'a',
          method: 'tools/call',
          params: {
            name: 'action.approve',
            arguments: { recordId: 3, revision: 2, values: [{ fieldId: 5, value: 'x' }] },
          },
        }),
      ),
    ).toEqual({
      ok: true,
      message: {
        type: 'tools/call',
        id: 'a',
        call: {
          kind: 'action',
          actionId: 'approve',
          arguments: { recordId: 3, revision: 2, values: [{ fieldId: 5, value: 'x' }] },
        },
      },
    });
  });

  it('answers malformed requests with an error and drops what is not a request', () => {
    expect(parseAppSandboxMessage('not json')).toMatchObject({ ok: false, id: null });
    expect(parseAppSandboxMessage({ hello: 'world' })).toMatchObject({ ok: false, id: null });
    expect(parseAppSandboxMessage({ jsonrpc: '2.0', id: 7, method: 'ui/open-link', params: {} })).toEqual({
      ok: false,
      id: 7,
      error: { code: APP_SANDBOX_ERRORS.methodNotFound, message: 'Unknown method "ui/open-link"' },
    });
    expect(parseAppSandboxMessage({ jsonrpc: '2.0', method: 'tools/call', params: {} })).toMatchObject({
      ok: false,
      id: null,
    });
    expect(parseAppSandboxMessage({ jsonrpc: '2.0', id: 8, method: 'ui/initialize' })).toMatchObject({
      ok: false,
      id: 8,
      error: { code: APP_SANDBOX_ERRORS.invalidParams },
    });
    const big = {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'query.a', arguments: { cursor: 'x'.repeat(APP_SANDBOX_LIMITS.messageBytes) } },
    };
    expect(parseAppSandboxMessage(big)).toMatchObject({
      ok: false,
      id: 9,
      error: { code: APP_SANDBOX_ERRORS.tooLarge },
    });
    expect(parseAppSandboxMessage(JSON.stringify(big))).toMatchObject({ ok: false, id: null });
  });

  it('accepts only query.<binding>, action.<action> and action.$create calls with their own arguments', () => {
    expect(parseAppSandboxToolCall('query.tasks', undefined)).toEqual({
      ok: true,
      call: { kind: 'query', bindingId: 'tasks', arguments: {} },
    });
    expect(parseAppSandboxToolCall('action.$create', { values: [{ fieldId: 1, value: 'a' }] })).toEqual({
      ok: true,
      call: { kind: 'create', arguments: { values: [{ fieldId: 1, value: 'a' }] } },
    });
    expect(parseAppSandboxToolCall('fetch.url', {})).toMatchObject({
      ok: false,
      code: APP_SANDBOX_ERRORS.methodNotFound,
    });
    expect(parseAppSandboxToolCall('query.Bad Id', {})).toMatchObject({
      ok: false,
      code: APP_SANDBOX_ERRORS.notAllowed,
    });
    expect(parseAppSandboxToolCall('query.tasks', { where: {} })).toMatchObject({
      ok: false,
      code: APP_SANDBOX_ERRORS.invalidParams,
    });
    expect(parseAppSandboxToolCall('action.approve', {})).toMatchObject({
      ok: false,
      code: APP_SANDBOX_ERRORS.invalidParams,
    });
    expect(parseAppSandboxToolCall('action.approve', { recordId: 1, values: [{ fieldId: 'x' }] })).toMatchObject({
      ok: false,
    });
    expect(parseAppSandboxToolCall('action.approve', { recordId: 1, delete: true })).toMatchObject({ ok: false });
  });

  it('counts UTF-8 bytes the way the limits mean them', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('审批')).toBe(6);
    expect(utf8ByteLength('😀')).toBe(4);
  });
});
