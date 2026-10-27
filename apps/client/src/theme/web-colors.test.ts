import { expect, it } from 'vitest';
import { color } from '../../../../packages/ui/src/tokens/tokens';
import { webColors } from './web-colors.generated';
it('keeps the browser surface palette identical to the shared token source', () => {
  for (const mode of ['light', 'dark'] as const)
    expect(webColors[mode]).toEqual(
      Object.fromEntries(Object.entries(color).map(([key, value]) => [key, value[mode]])),
    );
});
