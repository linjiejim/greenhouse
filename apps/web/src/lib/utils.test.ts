import { describe, expect, it } from 'vitest';
import { formatDateInZone, markdownPreview } from './utils';

describe('markdownPreview', () => {
  it('drops Markdown syntax but keeps the words', () => {
    expect(
      markdownPreview(
        '## Standup digest — Sat\n\n**Headline: nothing moved.** See [the policy](https://x) and `code`.',
      ),
    ).toBe('Standup digest — Sat Headline: nothing moved. See the policy and code.');
  });

  it('flattens lists, quotes and fenced code into one line', () => {
    expect(markdownPreview('> note\n- first\n- *second*\n```sql\nselect 1\n```\nend')).toBe('note first second end');
  });

  it('is safe on empty input', () => {
    expect(markdownPreview(null)).toBe('');
    expect(markdownPreview('')).toBe('');
  });
});

describe('formatDateInZone', () => {
  it('renders the instant in the requested zone', () => {
    const iso = '2026-09-14T20:00:00.000Z';
    expect(formatDateInZone(iso, 'UTC')).toMatch(/Sep 14, 2026/);
    expect(formatDateInZone(iso, 'UTC')).toMatch(/8:00 PM/);
    expect(formatDateInZone(iso, 'Asia/Shanghai')).toMatch(/Sep 15, 2026/);
  });

  it('falls back to a plain date on an invalid zone and to empty on no date', () => {
    expect(formatDateInZone('2026-09-14T20:00:00.000Z', 'Not/AZone')).toMatch(/2026/);
    expect(formatDateInZone(null, 'UTC')).toBe('');
  });
});
