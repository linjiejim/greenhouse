import { describe, expect, it } from 'vitest';
import type { Connector, ConnectorTool } from '@greenhouse/contract';
import {
  allowTool,
  blankDraft,
  createInput,
  disconnectsMembers,
  draftOf,
  draftProblem,
  slugFrom,
  updateInput,
  vouchTool,
  withChange,
} from '../connector-draft';
import { draftFromRegistry } from '../AddConnectorDrawer';

const tool = (name: string, flags: Partial<ConnectorTool> = {}): ConnectorTool => ({
  name,
  description: '',
  input_schema: {},
  declared_read_only: false,
  destructive: false,
  allowed: true,
  read_only: false,
  ...flags,
});

const connector = (fields: Partial<Connector> = {}): Connector => ({
  id: 'con_1',
  slug: 'desk',
  name: 'Desk',
  description: '',
  url: 'https://desk.example/mcp',
  transport: 'streamable_http',
  auth_mode: 'per_member',
  auth_header: 'X-Api-Key',
  auth_query_param: null,
  auth_prefix: null,
  shared_key_set: false,
  key_help: 'A desk API key',
  key_help_url: null,
  oauth_scope: null,
  oauth_client: null,
  enabled: true,
  allowed_tools: null,
  read_only_tools: [],
  catalog_id: null,
  tools: [
    tool('lookup', { declared_read_only: true, read_only: true }),
    tool('create'),
    tool('drop', { destructive: true }),
  ],
  tools_refreshed_at: null,
  last_error: null,
  connection_count: 2,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...fields,
});

describe('the connector form', () => {
  it('suggests a slug from the name, else from the address', () => {
    expect(slugFrom('Help Desk')).toBe('help-desk');
    expect(slugFrom('42 Things')).toBe('things');
    expect(slugFrom('工单', 'https://mcp.linear.app/mcp')).toBe('linear');
    expect(slugFrom('', 'https://docs.mcp.cloudflare.com/sse')).toBe('cloudflare');
    expect(slugFrom('', 'http://127.0.0.1:4592/mcp')).toBe('');
    expect(slugFrom('A'.repeat(40))).toHaveLength(32);
  });

  it('says what to fix first', () => {
    const draft = { ...blankDraft(), name: 'Desk', slug: 'desk', url: 'https://desk.example/mcp' };
    expect(draftProblem(draft, null)).toBeNull();
    expect(draftProblem({ ...draft, name: ' ' }, null)?.field).toBe('name');
    expect(draftProblem({ ...draft, slug: '9lives' }, null)?.field).toBe('slug');
    expect(draftProblem({ ...draft, url: 'ftp://desk.example' }, null)?.field).toBe('url');
    expect(draftProblem({ ...draft, auth_mode: 'per_member', header: 'Bad Header' }, null)?.field).toBe('header');
    expect(draftProblem({ ...draft, auth_mode: 'shared' }, null)?.field).toBe('shared_key');
    expect(draftProblem({ ...draft, auth_mode: 'shared', shared_key: 'k' }, null)).toBeNull();
    // Already shared: its key is kept unless replaced.
    expect(draftProblem({ ...draft, auth_mode: 'shared' }, connector({ auth_mode: 'shared' }))).toBeNull();
    expect(draftProblem({ ...draft, auth_mode: 'per_member', key_help_url: 'http://help.example' }, null)?.field).toBe(
      'key_help_url',
    );
  });

  it('installs with only what its auth mode uses', () => {
    const draft = { ...blankDraft(), name: ' Desk ', slug: 'desk', url: 'https://desk.example/mcp ' };
    expect(createInput(draft)).toEqual({
      slug: 'desk',
      name: 'Desk',
      url: 'https://desk.example/mcp',
      transport: 'streamable_http',
      auth_mode: 'none',
    });
    expect(
      createInput({ ...draft, auth_mode: 'shared', place: 'query', query: 'key', shared_key: ' secret ', prefix: '' }),
    ).toMatchObject({
      auth_mode: 'shared',
      auth_header: null,
      auth_query_param: 'key',
      auth_prefix: null,
      shared_key: 'secret',
    });
    expect(
      createInput({ ...draft, auth_mode: 'oauth', oauth_client_id: 'abc', oauth_client_secret: 's' }),
    ).toMatchObject({ auth_mode: 'oauth', oauth_scope: null, oauth_client_id: 'abc', oauth_client_secret: 's' });
  });

  it('sends only what an edit changed, and knows when members are disconnected', () => {
    const before = connector();
    const draft = draftOf(before);
    expect(updateInput(draft, before)).toEqual({});
    expect(updateInput({ ...draft, name: 'Help desk', prefix: 'Bearer ' }, before)).toEqual({
      name: 'Help desk',
      auth_prefix: 'Bearer ',
    });
    const moved = updateInput({ ...draft, url: 'https://new.example/mcp' }, before);
    expect(moved).toEqual({ url: 'https://new.example/mcp' });
    expect(disconnectsMembers(moved)).toBe(true);
    expect(updateInput({ ...draft, auth_mode: 'shared', shared_key: 'k' }, before)).toEqual({
      auth_mode: 'shared',
      shared_key: 'k',
    });
    expect(disconnectsMembers({ name: 'x' })).toBe(false);
  });
});

describe('tool switches', () => {
  it('turn every tool (null) into a list and keep the server order', () => {
    const desk = connector();
    expect(allowTool(desk, 'create', false)).toEqual(['lookup', 'drop']);
    expect(allowTool({ ...desk, allowed_tools: ['drop'] }, 'lookup', true)).toEqual(['lookup', 'drop']);
    expect(vouchTool(desk, 'create', true)).toEqual(['create']);
    expect(vouchTool({ ...desk, read_only_tools: ['create', 'gone'] }, 'create', false)).toEqual(['gone']);
  });

  it('redraw the tools the way the server decides', () => {
    const desk = withChange(connector(), { allowed_tools: ['lookup'], read_only_tools: ['create', 'drop'] });
    expect(desk.tools.map((item) => [item.name, item.allowed, item.read_only])).toEqual([
      ['lookup', true, true],
      ['create', false, true],
      // A destructive tool never runs without approval, vouched or not.
      ['drop', false, false],
    ]);
    expect(withChange(desk, { allowed_tools: null }).tools.every((item) => item.allowed)).toBe(true);
    expect(withChange(desk, { enabled: false }).enabled).toBe(false);
  });
});

describe('a Registry result', () => {
  it('fills the address form, guessing each member’s key from a secret header', () => {
    expect(
      draftFromRegistry({
        name: 'io.example/desk',
        title: 'Example Desk',
        description: 'Tickets',
        version: '1.0.0',
        website_url: null,
        remotes: [
          {
            transport: 'streamable_http',
            url: 'https://mcp.example.io/mcp',
            headers: [{ name: 'X-Desk-Key', description: null, required: true, secret: true }],
          },
        ],
        catalog_id: null,
      }),
    ).toEqual({
      name: 'Example Desk',
      slug: 'example-desk',
      description: 'Tickets',
      url: 'https://mcp.example.io/mcp',
      transport: 'streamable_http',
      auth_mode: 'per_member',
      place: 'header',
      header: 'X-Desk-Key',
    });
  });
});
