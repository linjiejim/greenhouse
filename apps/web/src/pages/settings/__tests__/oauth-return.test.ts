import { describe, expect, it } from 'vitest';
import { returnsTo } from '../../ConsentPage';
import { readOAuthReturn } from '../oauth-return';

describe('a connector sign-in coming back', () => {
  it('finishes with the state and code the callback handed over', () => {
    expect(readOAuthReturn('#/settings/connections?connector=con_1&oauth_state=s%2B1&oauth_code=c1')).toEqual({
      kind: 'finish',
      connector: 'con_1',
      state: 's+1',
      code: 'c1',
    });
  });

  it('says what the provider refused, and ignores everything else', () => {
    expect(
      readOAuthReturn('#/settings/connections?connector=con_1&oauth_error=access_denied&oauth_error_description=No'),
    ).toEqual({ kind: 'failed', connector: 'con_1', error: 'access_denied', description: 'No' });
    expect(readOAuthReturn('#/settings/connections?oauth_error=invalid_state')).toEqual({
      kind: 'failed',
      connector: null,
      error: 'invalid_state',
      description: null,
    });
    expect(readOAuthReturn('#/settings/connections')).toBeNull();
    expect(readOAuthReturn('#/settings/connections?oauth_state=s')).toBeNull();
  });
});

describe('where consent sends the access', () => {
  it('names the host of a web address and the scheme of an app’s own one', () => {
    expect(returnsTo('https://claude.ai/api/mcp/auth_callback')).toBe('claude.ai');
    expect(returnsTo('http://127.0.0.1:33418/callback')).toBe('127.0.0.1:33418');
    expect(returnsTo('cursor://anysphere.cursor-mcp/oauth/callback')).toBe('cursor://anysphere.cursor-mcp');
    expect(returnsTo('com.example.app:/oauth')).toBe('com.example.app:');
  });
});
