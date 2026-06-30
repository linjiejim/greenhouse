/**
 * E2E Security Tests — Authentication & Authorization
 *
 * These tests run against a live server instance and validate
 * real security boundaries. Run manually only:
 *
 *   API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm vitest run tests/e2e/ --config vitest.e2e.config.ts
 *
 * Prerequisites:
 *   - Server running on the configured port
 *   - ACCESS_PASSWORD set to a known value
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createTestToken, BASE_URL, PASSWORD } from './helpers.js';

async function getValidToken(): Promise<string> {
  return createTestToken('e2e-auth-test', 'super');
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

describe("E2E: Authentication Security", () => {
  let validToken: string;

  beforeAll(async () => {
    // Verify server is running
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (!res.ok) throw new Error("Server not healthy");
    } catch {
      throw new Error(
        `Server not running at ${BASE_URL}. Start it with: API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm api`,
      );
    }
    validToken = await getValidToken();
  });

  // ─── Token Validation ───────────────────────────────────

  it("rejects requests without token", async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.needsAuth).toBe(true);
  });

  it("rejects requests with invalid token", async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      headers: { Authorization: "Bearer invalid-token-value" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with expired token", async () => {
    // Craft a token with an expired timestamp (year 2020)
    const expiredHex = Math.floor(
      new Date("2020-01-01").getTime() / 1000,
    ).toString(16);
    const fakeToken = `${expiredHex}.0000000000000000000000000000000000000000000000000000000000000000`;
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      headers: { Authorization: `Bearer ${fakeToken}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with tampered token signature", async () => {
    // Take a valid token and completely replace the signature
    const parts = validToken.split(".");
    const tamperedSig = "0".repeat(parts[1].length);
    const tamperedToken = `${parts[0]}.${tamperedSig}`;
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      headers: { Authorization: `Bearer ${tamperedToken}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with malformed bearer header", async () => {
    const variants = [
      "Bearer",           // no token
      "Bearer ",          // empty token
      `Basic ${validToken}`, // wrong scheme
      validToken,         // no scheme prefix
    ];

    for (const auth of variants) {
      const res = await fetch(`${BASE_URL}/api/sessions`, {
        headers: { Authorization: auth },
      });
      expect(res.status).toBe(401);
    }
  });

  it("accepts valid token for protected endpoint", async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      headers: authHeaders(validToken),
    });
    expect(res.status).toBe(200);
  });

  // ─── Public Paths ──────────────────────────────────────

  it("allows unauthenticated access to health endpoint", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.status).toBe(200);
  });

  it("allows unauthenticated access to auth status", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/status`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.authEnabled).toBe(true);
  });

  it("allows unauthenticated access to frontend root", async () => {
    const res = await fetch(`${BASE_URL}/`);
    // May be 200 (frontend built) or 404 (not built)
    expect([200, 404]).toContain(res.status);
  });

  // ─── Password Brute Force ─────────────────────────────

  it("rejects incorrect passwords", async () => {
    const attempts = ["wrong", "admin", "password123", "greenhouse"];

    for (const pw of attempts) {
      const res = await fetch(`${BASE_URL}/api/auth/login/external`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      // External login: 400 for missing/empty, 401 for wrong password
      expect([400, 401, 429]).toContain(res.status);
    }
  });

  it("rejects empty body on auth endpoint", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login/external`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect([400, 401, 429]).toContain(res.status);
  });

  it("rejects non-string password values", async () => {
    const payloads = [
      { password: 123 },
      { password: null },
      { password: true },
      { password: [] },
      { password: {} },
    ];

    for (const payload of payloads) {
      const res = await fetch(`${BASE_URL}/api/auth/login/external`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect([400, 401, 429]).toContain(res.status);
    }
  });
});

describe("E2E: Authorization — Profile Access Control", () => {
  let validToken: string;

  beforeAll(async () => {
    validToken = await getValidToken();
  });

  it("allows creating session with public profile (internal user)", async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      method: "POST",
      headers: authHeaders(validToken),
      body: JSON.stringify({ profile_id: "default" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.profile_id).toBe("default");
    // Cleanup
    await fetch(`${BASE_URL}/api/sessions/${data.id}`, {
      method: "DELETE", headers: authHeaders(validToken),
    });
  });

  it("rejects non-existent profile in stateless chat", async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: authHeaders(validToken),
      body: JSON.stringify({
        messages: [{ role: "user", content: "test" }],
        profile_id: "nonexistent-profile",
      }),
    });
    // 400 (invalid profile), 403 (access denied), or 429 (rate limited in test suite)
    expect([400, 403, 429]).toContain(res.status);
  });

  it("session detail does not expose system prompts to unauthenticated users", async () => {
    // Create a session first
    const createRes = await fetch(`${BASE_URL}/api/sessions`, {
      method: "POST",
      headers: authHeaders(validToken),
    });
    const session = await createRes.json();

    // Try to access without auth
    const detailRes = await fetch(`${BASE_URL}/api/sessions/${session.id}`);
    expect(detailRes.status).toBe(401);
  });
});
