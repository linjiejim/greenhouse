/**
 * GUARD + BEHAVIOR TEST — the auth public-path fork extension point.
 *
 * SECURITY-SENSITIVE: upstream must ship ZERO fork public paths (an OSS build
 * must never expose an unauthenticated endpoint). A fork adds OAuth-callback
 * paths and isPublicPath() honours them without editing middleware.ts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { EXTENSION_PUBLIC_PATHS, EXTENSION_PUBLIC_PATH_PREFIXES } from './extensions.js';
import { isPublicPath } from './middleware.js';

afterEach(() => {
  EXTENSION_PUBLIC_PATHS.length = 0;
  EXTENSION_PUBLIC_PATH_PREFIXES.length = 0;
});

describe('auth public-path extension seam', () => {
  it('ships no fork public paths upstream (OSS invariant)', () => {
    expect(EXTENSION_PUBLIC_PATHS).toEqual([]);
    expect(EXTENSION_PUBLIC_PATH_PREFIXES).toEqual([]);
    // Core public path still public; an un-registered fork callback is NOT.
    expect(isPublicPath('/health')).toBe(true);
    expect(isPublicPath('/api/providers/feishu/callback')).toBe(false);
  });

  it('honours fork-registered exact paths and prefixes', () => {
    EXTENSION_PUBLIC_PATHS.push('/api/providers/feishu/callback');
    EXTENSION_PUBLIC_PATH_PREFIXES.push('/api/email/oauth/');
    expect(isPublicPath('/api/providers/feishu/callback')).toBe(true);
    expect(isPublicPath('/api/email/oauth/gmail/start')).toBe(true);
    // Unrelated private path stays gated.
    expect(isPublicPath('/api/crm/customers')).toBe(false);
  });
});
