import { describe, expect, it } from 'vitest';
import type { PersonalConnector } from '../api/connectors';
import { dropsMyConnection, personalDraft, personalInput, personalReady, personalUpdate } from './personal-draft';

const existing: PersonalConnector = {
  id: 'mcc_1',
  scope: 'personal',
  slug: 'notes',
  handle: 'me/notes',
  name: 'Notes',
  description: null,
  auth_mode: 'per_member',
  auth_kind: 'key',
  status: 'connected',
  url: 'https://notes.example.com/mcp',
  transport: 'streamable_http',
  auth_header: 'Authorization',
  auth_query_param: null,
  auth_value_prefix: 'Bearer ',
  oauth_client: null,
  oauth_scope: null,
  tools: [],
};

describe('personal connector draft', () => {
  it('writes nothing a personal connector may not carry', () => {
    const body = personalInput({ ...personalDraft(), slug: 'notes', name: ' Notes ', url: 'https://n.example/mcp' });
    expect(body).toMatchObject({ slug: 'notes', name: 'Notes', auth_mode: 'none', auth_kind: null, auth_header: null });
    for (const key of ['shared_secret', 'private_network', 'allow_external_writes', 'enabled']) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('sends my key’s place and my sign-in’s client only for that sign-in kind', () => {
    const key = personalInput({ ...personalDraft(), auth: 'key', key_place: 'query', auth_query_param: 'api_key' });
    expect(key).toMatchObject({
      auth_mode: 'per_member',
      auth_kind: 'key',
      auth_header: null,
      auth_query_param: 'api_key',
    });
    const oauth = personalInput({
      ...personalDraft(),
      auth: 'oauth',
      oauth_client_id: 'cid',
      oauth_client_secret: 's',
    });
    expect(oauth).toMatchObject({
      auth_kind: 'oauth',
      oauth_client_id: 'cid',
      oauth_client_secret: 's',
      auth_header: null,
    });
    expect(personalInput({ ...personalDraft(), auth: 'oauth' })).not.toHaveProperty('oauth_client_secret');
  });

  it('edits keep the handle and say when my connection would be forgotten', () => {
    const draft = personalDraft(existing);
    expect(draft).toMatchObject({ auth: 'key', key_place: 'header', slug: 'notes' });
    expect(personalUpdate(draft)).not.toHaveProperty('slug');
    expect(dropsMyConnection(existing, draft)).toBe(false);
    expect(dropsMyConnection(existing, { ...draft, url: 'https://other.example/mcp' })).toBe(true);
    expect(dropsMyConnection(existing, { ...draft, auth: 'oauth' })).toBe(true);
  });

  it('needs a name, an address and, when new, a valid handle', () => {
    const draft = { ...personalDraft(), name: 'Notes', url: 'https://n.example/mcp' };
    expect(personalReady({ ...draft, slug: 'Notes!' }, false)).toBe(false);
    expect(personalReady({ ...draft, slug: 'notes' }, false)).toBe(true);
    expect(personalReady({ ...draft, slug: '' }, true)).toBe(true);
    expect(personalReady({ ...draft, url: ' ' }, true)).toBe(false);
  });
});
