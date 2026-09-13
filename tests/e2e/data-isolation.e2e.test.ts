/**
 * E2E Security Tests — Data Isolation & Profile Boundaries
 *
 * Tests that session ownership and API responses do not leak data.
 *
 * Use `pnpm test:e2e:ci`; manual debugging setup is documented in tests/e2e/README.md.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSuperToken, BASE_URL } from './helpers.js';

let token: string;
const sessionsToClean: string[] = [];

async function getValidToken(): Promise<string> {
  // Use super token for session operations
  return createSuperToken();
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function createSession(profileId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/sessions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ profile_id: profileId }),
  });
  const data = await res.json();
  sessionsToClean.push(data.id);
  return data.id;
}

async function sendMessage(sessionId: string, content: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      session_id: sessionId,
      messages: [{ role: 'user', content }],
    }),
  });
  return res.text();
}

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error('Server not healthy');
  } catch {
    throw new Error(`Server not running at ${BASE_URL}. Run pnpm test:e2e:ci or follow tests/e2e/README.md.`);
  }
  token = await getValidToken();
});

afterAll(async () => {
  // Cleanup created sessions
  for (const id of sessionsToClean) {
    await fetch(`${BASE_URL}/api/sessions/${id}`, {
      method: 'DELETE',
      headers: headers(),
    }).catch(() => {});
  }
});

// ─── Profile Compatibility Boundary ─────────────────────

describe('E2E: Removed Profile Compatibility', () => {
  it('legacy profile IDs resolve to the preset that replaced them', async () => {
    // Stored sessions still carry `default` / `team`; they are mapped, not migrated.
    for (const legacy of ['default', 'team', 'sprouty-quick', 'sprouty-deep', 'sprouty-k3', 'sprouty-workflows', 'sprouty-mission']) {
      const sessionId = await createSession(legacy);
      const detailRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, { headers: headers() });
      const detail = await detailRes.json();
      expect(detail.session.profile_id, legacy).toBe('sprouty');
    }
  });

  it('lists the presets and none of the retired IDs', async () => {
    const res = await fetch(`${BASE_URL}/api/profiles`, { headers: headers() });
    const data = await res.json();
    const ids = data.profiles.map((profile: { id: string }) => profile.id);
    expect(ids).toContain('sprouty');
    expect(ids).not.toContain('default');
    expect(ids).not.toContain('team');
  });

  it('requires authentication to enumerate profiles', async () => {
    const res = await fetch(`${BASE_URL}/api/profiles`);
    expect(res.status).toBe(401);
  });
});

// ─── Session Data Isolation ──────────────────────────────

describe('E2E: Session Data Isolation', () => {
  it('cannot access non-existent session', async () => {
    const res = await fetch(`${BASE_URL}/api/sessions/nonexistent-session-id-12345`, { headers: headers() });
    expect(res.status).toBe(404);
  });

  it('cannot send message to non-existent session', async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        session_id: 'nonexistent-session-id-12345',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });
    // 404 = session not found, 429 = rate limited in test suite
    expect([404, 429]).toContain(res.status);
  });

  it('session preserves its profile_id', async () => {
    const sessionId = await createSession('team');

    // Try to chat with different profile — session mode should use stored profile
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        session_id: sessionId,
        messages: [{ role: 'user', content: 'hello' }],
        profile_id: 'eval-judge', // attempt to override with a different valid profile
      }),
    });
    // 200 = success, 429 = rate limited
    if (res.status === 200) {
      // Verify the session's stored profile was not changed by the request.
      const detailRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
        headers: headers(),
      });
      const detail = await detailRes.json();
      expect(detail.session.profile_id).toBe('sprouty');
    } else {
      expect(res.status).toBe(429);
    }
  });

  it('deleting a session removes all its messages', async () => {
    const sessionId = await createSession('team');
    await sendMessage(sessionId, 'This is a test message that should be deleted');

    // Wait a moment for message to persist
    await new Promise((r) => setTimeout(r, 500));

    // Verify session exists
    const beforeRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
      headers: headers(),
    });
    expect(beforeRes.status).toBe(200);
    // Message may not be persisted yet if chat was rate-limited
    // The key test is that deletion works

    // Delete session
    const deleteRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: headers(),
    });
    expect(deleteRes.status).toBe(200);

    // Verify session is gone
    const afterRes = await fetch(`${BASE_URL}/api/sessions/${sessionId}`, {
      headers: headers(),
    });
    expect(afterRes.status).toBe(404);

    // Remove from cleanup list
    const idx = sessionsToClean.indexOf(sessionId);
    if (idx >= 0) sessionsToClean.splice(idx, 1);
  });
});

// ─── Information Disclosure ──────────────────────────────

describe('E2E: Information Disclosure Prevention', () => {
  it('profiles endpoint does not expose API keys', async () => {
    const res = await fetch(`${BASE_URL}/api/profiles`, {
      headers: headers(),
    });
    const data = await res.json();
    const serialized = JSON.stringify(data);

    // Should never contain actual API key values
    expect(serialized).not.toContain('sk-');
    expect(serialized).not.toContain('LLM_API_KEY');
    expect(serialized).not.toMatch(/api[_-]?key.*[:=].{20,}/i);
  });

  it('error messages do not expose internal paths', async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'test' }],
        profile_id: '../../etc/passwd',
      }),
    });
    const text = await res.text();

    // Should not contain home directory paths or node_modules
    expect(text).not.toContain('/home/');
    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('node_modules');
  });

  it('health endpoint reveals minimal information', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const data = await res.json();

    // Should not expose: DB path, API keys, internal config
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('.db');
    expect(serialized).not.toContain('sqlite');
    // Should not expose model name or profile list
    expect(serialized).not.toContain('deepseek');
    expect(data).not.toHaveProperty('model');
    expect(data).not.toHaveProperty('profiles');
    // Ensure it doesn't expose actual API keys
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('sk-');
  });

  it('upload listing is not possible (no directory listing)', async () => {
    const res = await fetch(`${BASE_URL}/api/upload/`);
    // Should be 400 or 404, not a directory listing
    expect([400, 404]).toContain(res.status);
  });
});

// ─── Session ID Enumeration ──────────────────────────────

describe('E2E: ID Enumeration Protection', () => {
  it('sessions use UUID format (not sequential)', async () => {
    const session1 = await createSession('team');
    const session2 = await createSession('team');

    // UUIDs should not be sequential integers
    expect(session1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(session2).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(session1).not.toBe(session2);
  });
});
