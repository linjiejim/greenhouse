import { describe, expect, it } from 'vitest';
import { plainText } from './plain-text';

describe('plainText', () => {
  it('drops Markdown marks and fenced blocks', () => {
    expect(plainText('## Done\n\n**3** rows [updated](https://x)\n```json\n{"a":1}\n```\n- next', { oneLine: true })).toBe(
      'Done 3 rows updated next',
    );
    expect(plainText('a\n\n\n\nb')).toBe('a\n\nb');
    expect(plainText(null)).toBe('');
  });
});
