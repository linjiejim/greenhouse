import { describe, expect, it } from 'vitest';
import { isEmptyRichBlock, richSegment } from './rich';

describe('mobile rich fences', () => {
  it('drops an empty block instead of rendering its JSON', () => {
    expect(isEmptyRichBlock('steps', '{"title":"","items":[]}')).toBe(true);
    expect(isEmptyRichBlock('steps', '{"items":[{"title":"Build","status":"active"}]}')).toBe(false);
    expect(isEmptyRichBlock('steps', '{"items":[{"title":"Build","status":"doing"}]}')).toBe(false);
  });

  it('validates the business blocks with the shared parser', () => {
    expect(richSegment('stats', '{"items":[{"label":"New","value":128}]}')?.type).toBe('stats');
    expect(richSegment('cards', '{"items":[{"title":"Doc","url":"javascript:x"}]}')).toBeNull();
  });
});
