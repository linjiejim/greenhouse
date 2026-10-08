/**
 * The thread's filler-line check (./filler.ts) against the server's own wording: copy.ts is read
 * as text (the mobile app can't import the API), so a reworded placeholder turns this red instead
 * of quietly showing up in threads again.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isFillerReply } from './filler';

const COPY = readFileSync(
  fileURLToPath(new URL('../../../../api/src/bots/engine/copy.ts', import.meta.url)),
  'utf8',
);

describe('isFillerReply', () => {
  it('matches each placeholder the server writes, in both languages', () => {
    for (const line of [
      '轮到你了：请看上面的卡片。',
      'Over to you — see the card above.',
      '（已完成上面的步骤）',
      '(Done — see the steps above.)',
    ]) {
      expect(COPY).toContain(`'${line}'`);
      expect(isFillerReply(line)).toBe(true);
    }
    expect(COPY).toContain('`（已交给 ${names.join(');
    expect(COPY).toContain('`(Handed over to ${names.join(');
    expect(isFillerReply('（已交给 蒲蒲、muse）')).toBe(true);
    expect(isFillerReply('(Handed over to Fern, Sage.)')).toBe(true);
  });

  it('leaves real replies alone', () => {
    expect(isFillerReply('Over to you — see the card above. Also, the draft is ready.')).toBe(false);
    expect(isFillerReply('已交给 蒲蒲')).toBe(false);
    expect(isFillerReply('Done.')).toBe(false);
  });
});
