/**
 * The public-read carve-out is images ONLY.
 *
 * `GET /api/upload/:id` is exempt from the central bearer check for exactly one
 * reason: a browser `<img src>` cannot send an Authorization header. That
 * reason does not extend to any other file type, and now that chat accepts
 * arbitrary attachments the temptation to widen it is real — a PDF served from
 * a public URL is a PDF anyone with the link can read, forever, with no session
 * policy in the way.
 *
 * This test pins the boundary at the routing layer, where it is decided.
 */

import { describe, it, expect } from 'vitest';
import { isPublicPath } from '../../auth/middleware.js';

describe('public-read boundary', () => {
  it('exempts fetching an image object', () => {
    expect(isPublicPath('/api/upload/1712345678-abcdef')).toBe(true);
  });

  it('does not exempt the upload endpoint itself', () => {
    expect(isPublicPath('/api/upload')).toBe(false);
  });

  it('never exempts chat attachments — they are session-policy protected', () => {
    expect(isPublicPath('/api/chat-files/upload')).toBe(false);
    expect(isPublicPath('/api/chat-files/abc-123/content')).toBe(false);
  });

  it('never exempts mission attachment or artifact downloads', () => {
    expect(isPublicPath('/api/missions/attachments/download')).toBe(false);
    expect(isPublicPath('/api/missions/runs/car_1/artifacts/2/download')).toBe(false);
    expect(isPublicPath('/api/cloud-agent/attachments/download')).toBe(false);
    expect(isPublicPath('/api/cloud-agent/runs/car_1/artifacts/2/download')).toBe(false);
  });

  it('exempts only the run-bound Mission runner subtree', () => {
    expect(isPublicPath('/api/missions/internal/runs/car_1/events')).toBe(true);
    expect(isPublicPath('/api/cloud-agent/internal/runs/car_1/events')).toBe(true);
    expect(isPublicPath('/api/missions/internal')).toBe(false);
  });
});
