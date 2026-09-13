import { describe, expect, it } from 'vitest';
import { reasoningHeadline } from './reasoning-panel';

describe('reasoningHeadline', () => {
  it('shows the first line of the most recently completed paragraph', () => {
    expect(reasoningHeadline('Inspect the request\nwith details\n\nCheck permissions\nthen render')).toBe(
      'Inspect the request',
    );
  });

  it('keeps the live first paragraph quiet and bounds a promoted summary', () => {
    expect(reasoningHeadline('Still streaming')).toBe('');
    expect(reasoningHeadline(`${'x'.repeat(240)}\n\nNext paragraph`)).toHaveLength(180);
  });
});
