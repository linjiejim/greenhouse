import { describe, expect, it } from 'vitest';
import { CONNECTOR_APP_REDIRECT, connectorSections, needsConnection, parseConnectorReturn } from './model';
import type { MyConnector } from '../api/connectors';

const connector = (over: Partial<MyConnector>): MyConnector => ({
  id: 'mcc_1',
  scope: 'team',
  slug: 'desk',
  handle: 'desk',
  name: 'Desk',
  description: null,
  auth_mode: 'per_member',
  auth_kind: 'oauth',
  status: 'not_connected',
  ...over,
});

describe('connector sign-in return', () => {
  it('reads the code and state on our address only', () => {
    expect(parseConnectorReturn(`${CONNECTOR_APP_REDIRECT}?code=abc&state=s1`)).toEqual({
      kind: 'code',
      code: 'abc',
      state: 's1',
    });
    expect(parseConnectorReturn(`${CONNECTOR_APP_REDIRECT}?error=access_denied&connector_id=x`)).toEqual({
      kind: 'error',
      reason: 'access_denied',
    });
    expect(parseConnectorReturn('greenhouse://auth/feishu?code=abc&state=s1')).toEqual({ kind: 'cancel' });
    expect(parseConnectorReturn(null)).toEqual({ kind: 'cancel' });
  });

  it('the address equals the server constant', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const server = readFileSync(resolve(__dirname, '../../../api/src/connectors/oauth.ts'), 'utf8');
    expect(server).toContain(`'${CONNECTOR_APP_REDIRECT}'`);
  });
});

describe('connector lists', () => {
  it('splits what needs me from what is ready', () => {
    const sections = connectorSections({
      team: [connector({ id: 'a' }), connector({ id: 'b', auth_mode: 'none', auth_kind: null, status: 'not_needed' })],
      personal: [connector({ id: 'c', scope: 'personal', auth_mode: 'per_member', auth_kind: 'key' })],
    });
    expect(sections.mine.map((c) => c.id)).toEqual(['a', 'c']);
    expect(sections.ready.map((c) => c.id)).toEqual(['b']);
  });
});

describe('needs_connection', () => {
  it('reads mcp_call’s connect-first answer and nothing else', () => {
    expect(
      needsConnection({
        needs_connection: true,
        connector: 'desk',
        connector_id: 'mcc_1',
        connector_name: 'Desk',
        auth_kind: 'oauth',
        reason: 'needs_reauth',
        error: 'x',
      }),
    ).toEqual({ connectorId: 'mcc_1', name: 'Desk', authKind: 'oauth', reason: 'needs_reauth' });
    expect(needsConnection({ connector: 'desk', result: 'ok' })).toBeNull();
    expect(needsConnection(null)).toBeNull();
  });
});
