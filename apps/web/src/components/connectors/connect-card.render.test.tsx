import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectorNeedsConnection } from '@greenhouse/types/connectors';
import { isArtifactCall, replacesTraceRow } from '../tool-call/body-artifacts';

vi.mock('../../lib/api/connectors', () => ({
  fetchMyConnectors: () => new Promise(() => undefined),
  startConnectorSignIn: vi.fn(),
  saveConnectorKey: vi.fn(),
}));

import { ConnectorConnectCard } from './connect-card';

const needs = (over: Partial<ConnectorNeedsConnection> = {}): ConnectorNeedsConnection => ({
  needs_connection: true,
  connector: 'desk',
  connector_id: 'mcc_1',
  connector_name: 'Desk',
  auth_kind: 'oauth',
  reason: 'not_connected',
  error: 'connect first',
  ...over,
});

describe('connector connect card', () => {
  it('only a needs_connection answer of mcp_call becomes a card', () => {
    expect(isArtifactCall({ name: 'mcp_call', output: needs() })).toBe(true);
    expect(replacesTraceRow({ name: 'mcp_call', output: needs() })).toBe(true);
    expect(isArtifactCall({ name: 'mcp_call', output: { connector: 'desk', result: 'ok' } })).toBe(false);
  });

  it('offers a sign-in for OAuth and a key for key connectors', () => {
    const oauth = renderToStaticMarkup(createElement(ConnectorConnectCard, { data: needs() }));
    expect(oauth).toContain('data-testid="connector-connect-button"');
    expect(oauth).toContain('Desk');
    const key = renderToStaticMarkup(createElement(ConnectorConnectCard, { data: needs({ auth_kind: 'key' }) }));
    expect(key).toContain('connector-connect-button');
    expect(key).not.toBe(oauth);
  });

  it('a read-only transcript shows the card without the button', () => {
    const html = renderToStaticMarkup(createElement(ConnectorConnectCard, { data: needs(), canAct: false }));
    expect(html).not.toContain('connector-connect-button');
  });
});
