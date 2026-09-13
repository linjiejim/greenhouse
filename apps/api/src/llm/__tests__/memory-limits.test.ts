/**
 * Memory write guard + friction redaction (pure functions, no DB).
 *
 * The sensitive-data rules are the load-bearing part: a memory is replayed at
 * the top of every future conversation, so a leaked secret leaks forever. The
 * prompt asks the model to behave; these are what actually stop it.
 */

import { describe, expect, it } from 'vitest';
import { validateMemoryText, redactEvidence, MEMORY_TITLE_MAX, MEMORY_CONTENT_MAX } from '../memory-limits.js';

describe('validateMemoryText', () => {
  it('accepts a well-formed memory', () => {
    expect(
      validateMemoryText({
        title: 'Prefers CRM figures grouped by 客户类型, not by country',
        content: 'When asked for a CRM breakdown, group by 客户类型 first.',
      }),
    ).toEqual({ ok: true });
  });

  it('keeps CJK literals intact rather than treating them as suspicious', () => {
    // The whole point of the "keep literals verbatim" rule: enum values must
    // survive the guard, or memories about 潜在/新线索 become unwritable.
    const result = validateMemoryText({ title: 'CRM status 潜在 means prospect', content: '潜在 = prospect stage' });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['an email address', 'reach them at zoe.chen@example.com'],
    ['a phone number', 'call +86 138 0013 8000 first'],
    ['an API key', 'the key is sk-abcdefghijklmnop12345'],
    ['a JWT', 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r'],
    ['a hex secret', 'signing key 0123456789abcdef0123456789abcdef'],
    ['a password assignment', 'password: hunter2'],
  ])('rejects content carrying %s', (_label, content) => {
    const result = validateMemoryText({ content });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refusing to store/i);
  });

  it('checks the title as well as the body', () => {
    expect(validateMemoryText({ title: 'login for ops@example.com' }).ok).toBe(false);
  });

  it.each([
    ['an ISO date', 'For B2B acquisition (started 2026-08-11), user decided: US-market only'],
    ['a date range', 'Batch scheduled 2026-08-11 to 2026-08-13, 30 companies/day'],
    ['a timestamp', 'Kickoff 2026/08/11 09:30, review at 2026-08-11T14:30:00'],
    ['a day-first date', 'Release v0.50.1 shipped 11/08/2026'],
    ['a compact date', 'Price list revision 20260811 supersedes the previous one'],
    ['a grouped number', 'Revenue target 1,234,567 USD for the quarter'],
  ])('does not mistake %s for a phone number', (_label, content) => {
    // A date is eight digits joined by separators — the same shape as a phone
    // number without a country code. Six consecutive refusals on dev (2026-08-13)
    // were a memory whose only "phone number" was the date the work started.
    expect(validateMemoryText({ content })).toEqual({ ok: true });
  });

  it('names the offending fragment so the model can fix it', () => {
    // Without the excerpt the model cannot tell which of 2000 characters
    // tripped the guard, so it retries the memory verbatim.
    const result = validateMemoryText({ content: 'Owner is Zoe, reach her at zoe.chen@example.com' });
    expect(result.error).toContain('"zoe.chen@example.com"');
  });

  it('routes contact details to the CRM rather than only refusing', () => {
    // The information is worth keeping — just not in a fragment replayed into
    // every future prompt, with no owner and no access control.
    for (const content of ['call +86 138 0013 8000 first', 'reach them at zoe@example.com']) {
      expect(validateMemoryText({ content }).error).toMatch(/crm_mutation/);
    }
  });

  it('offers no CRM routing for secrets, which belong nowhere', () => {
    expect(validateMemoryText({ content: 'password: hunter2' }).error).not.toMatch(/crm_mutation/);
  });

  it('rejects empty and over-long fields', () => {
    expect(validateMemoryText({ title: '   ' }).ok).toBe(false);
    expect(validateMemoryText({ content: '  ' }).ok).toBe(false);
    expect(validateMemoryText({ title: 'x'.repeat(MEMORY_TITLE_MAX + 1) }).ok).toBe(false);
    expect(validateMemoryText({ content: 'x'.repeat(MEMORY_CONTENT_MAX + 1) }).ok).toBe(false);
  });

  it('validates only the fields actually supplied', () => {
    // PATCH sends one field at a time; an absent field must not fail as empty.
    expect(validateMemoryText({ title: 'A valid title' }).ok).toBe(true);
    expect(validateMemoryText({}).ok).toBe(true);
  });
});

describe('redactEvidence', () => {
  it('redacts secrets instead of dropping the sample', () => {
    // Frictions are diagnostic evidence: rejecting the whole sample would throw
    // away the reason it was collected.
    const out = redactEvidence('failed for user@example.com with key sk-abcdefghijklmnop12345');
    expect(out).not.toContain('user@example.com');
    expect(out).not.toContain('sk-abcdefghijklmnop12345');
    expect(out).toContain('failed for');
  });

  it('replaces every occurrence, not just the first', () => {
    const out = redactEvidence('a@b.com and c@d.com');
    expect(out).toBe('[redacted] and [redacted]');
  });

  it('leaves ordinary tool errors untouched', () => {
    const text = 'id and type (contact/company) are required';
    expect(redactEvidence(text)).toBe(text);
  });

  it('keeps dates readable in the evidence', () => {
    // Friction evidence is read by a human deciding what to fix; when the sample
    // happened is often the most useful part of it.
    expect(redactEvidence('run started 2026-08-11, called +1 415 555 0132')).toBe(
      'run started 2026-08-11, called [redacted]',
    );
  });

  it('redacts overlapping matches exactly once', () => {
    // Two patterns can claim the same span; a naive pass would splice twice and
    // corrupt the surrounding text.
    const out = redactEvidence('key sk-abcdefghijklmnop12345 and mail a@b.com');
    expect(out).toBe('key [redacted] and mail [redacted]');
  });
});
