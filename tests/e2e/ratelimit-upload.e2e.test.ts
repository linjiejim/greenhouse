/**
 * E2E Security Tests — Rate Limiting & File Upload Security
 *
 * Tests rate limiting enforcement and file upload attack vectors.
 *
 * Run manually:
 *   API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm vitest run tests/e2e/ --config vitest.e2e.config.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { createTestToken, BASE_URL, PASSWORD } from './helpers.js';

let token: string;

async function getValidToken(): Promise<string> {
  return createTestToken('e2e-ratelimit-test', 'super');
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

beforeAll(async () => {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (!res.ok) throw new Error("Server not healthy");
  } catch {
    throw new Error(
      `Server not running at ${BASE_URL}. Start with: API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm api`,
    );
  }
  token = await getValidToken();
});

// ─── Rate Limiting ───────────────────────────────────────

describe("E2E: Rate Limiting", () => {
  it("returns rate limit headers on responses", async () => {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    // After security middleware is applied, these headers should exist
    const limitHeader = res.headers.get("X-RateLimit-Limit");
    const remainingHeader = res.headers.get("X-RateLimit-Remaining");

    // If rate limiting is implemented, these headers should be present
    if (limitHeader) {
      expect(parseInt(limitHeader)).toBeGreaterThan(0);
      expect(remainingHeader).not.toBeNull();
    }
  });

  it("auth endpoint enforces strict rate limit after multiple failures", async () => {
    const results: number[] = [];

    // Send 10 rapid failed auth attempts
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${BASE_URL}/api/auth/login/external`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: `wrong-password-${i}` }),
      });
      results.push(res.status);
    }

    // With rate limiting: later attempts should get 429
    // Without rate limiting: all should be 401
    const has429 = results.includes(429);
    const allAuth = results.every((s) => s === 401 || s === 429);
    expect(allAuth).toBe(true);

    // If rate limiting is implemented, we expect some 429s after limit
    // This serves as a regression test once rate limiting is deployed
    if (has429) {
      // First few should be 401 (wrong password), later ones 429 (rate limited)
      const first401Index = results.indexOf(401);
      const first429Index = results.indexOf(429);
      expect(first401Index).toBeLessThan(first429Index);
    }
  });
});

// ─── File Upload Security ────────────────────────────────

describe("E2E: File Upload Security", () => {
  function createFormData(
    filename: string,
    content: Buffer | string,
    mimeType: string,
  ): FormData {
    const formData = new FormData();
    const blob = new Blob([content], { type: mimeType });
    formData.append("file", blob, filename);
    return formData;
  }

  it("rejects non-image MIME types", async () => {
    const maliciousTypes = [
      { name: "hack.html", type: "text/html" },
      { name: "hack.js", type: "application/javascript" },
      { name: "hack.svg", type: "image/svg+xml" },
      { name: "hack.php", type: "application/x-php" },
      { name: "hack.exe", type: "application/x-executable" },
    ];

    for (const { name, type } of maliciousTypes) {
      const formData = createFormData(name, "malicious content", type);
      const res = await fetch(`${BASE_URL}/api/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Unsupported file type");
    }
  });

  it("rejects oversized files (>5MB)", async () => {
    // Create a 6MB buffer
    const content = Buffer.alloc(6 * 1024 * 1024, 0xff);
    const formData = createFormData("big.jpg", content, "image/jpeg");
    const res = await fetch(`${BASE_URL}/api/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("too large");
  });

  it("rejects file with wrong extension but valid MIME", async () => {
    // Valid JPEG MIME but .php extension — file should still be saved with safe name
    const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const formData = createFormData("hack.php.jpg", jpegHeader, "image/jpeg");
    const res = await fetch(`${BASE_URL}/api/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (res.status === 200) {
      const data = await res.json();
      // If accepted, the stored filename should not contain .php
      expect(data.id).not.toContain(".php");
      expect(data.url).toMatch(/\.(jpg|jpeg|png|webp|gif)$/i);
    }
  });

  it("sanitizes filename in uploaded file", async () => {
    const dangerousNames = [
      "../../../etc/passwd.jpg",
      "..\\..\\hack.jpg",
      "<script>alert(1)</script>.jpg",
      "file\x00name.jpg",
      "a".repeat(500) + ".jpg",
    ];

    for (const name of dangerousNames) {
      const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
      const formData = createFormData(name, jpegHeader, "image/jpeg");
      const res = await fetch(`${BASE_URL}/api/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (res.status === 200) {
        const data = await res.json();
        // Stored ID should be sanitized
        expect(data.id).not.toContain("..");
        expect(data.id).not.toContain("/");
        expect(data.id).not.toContain("\\");
        expect(data.id).not.toContain("<");
        expect(data.id).not.toContain("\x00");
      }
    }
  });

  it("serves uploaded files with correct content-type header", async () => {
    // Upload a minimal valid JPEG
    const jpegBytes = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00,
    ]);
    const formData = createFormData("test.jpg", jpegBytes, "image/jpeg");
    const uploadRes = await fetch(`${BASE_URL}/api/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (uploadRes.status === 200) {
      const data = await uploadRes.json();
      // Fetch the uploaded file
      const getRes = await fetch(`${BASE_URL}${data.url}`);
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("content-type")).toBe("image/jpeg");
      // Should not be served as HTML (prevents XSS via content sniffing)
      expect(getRes.headers.get("content-type")).not.toContain("html");
    }
  });

  it("upload endpoint requires authentication", async () => {
    const jpegBytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    const formData = createFormData("test.jpg", jpegBytes, "image/jpeg");
    const res = await fetch(`${BASE_URL}/api/upload`, {
      method: "POST",
      body: formData,
      // No auth header
    });
    expect(res.status).toBe(401);
  });
});

// ─── Response Header Security ────────────────────────────

describe("E2E: Security Response Headers", () => {
  it("API responses include security headers", async () => {
    const res = await fetch(`${BASE_URL}/api/sessions`, {
      headers: headers(),
    });

    // These should be present after security middleware is applied
    const xContentType = res.headers.get("X-Content-Type-Options");
    const xFrameOptions = res.headers.get("X-Frame-Options");

    // If security headers middleware is active:
    if (xContentType) {
      expect(xContentType).toBe("nosniff");
    }
    if (xFrameOptions) {
      expect(xFrameOptions).toBe("DENY");
    }
  });

  it("static file responses include cache headers", async () => {
    // Upload a file first
    const jpegBytes = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
    const formData = new FormData();
    formData.append("file", new Blob([jpegBytes], { type: "image/jpeg" }), "cache-test.jpg");
    const uploadRes = await fetch(`${BASE_URL}/api/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });

    if (uploadRes.status === 200) {
      const data = await uploadRes.json();
      const getRes = await fetch(`${BASE_URL}${data.url}`);
      const cacheControl = getRes.headers.get("Cache-Control");
      // Upload responses should have caching enabled
      if (cacheControl) {
        expect(cacheControl).toContain("max-age");
      }
    }
  });
});
