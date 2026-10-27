import { it, expect } from 'vitest';
import { bodyUnderTitle } from './doc-body';

it('drops a leading heading that repeats the title', () => {
  expect(bodyUnderTitle('# Docs Style Guide\n\nHow we write.', 'Docs Style Guide')).toBe('How we write.');
  expect(bodyUnderTitle('\n#  **Docs style guide** #\nBody', 'Docs Style Guide')).toBe('Body');
});

it('keeps everything else', () => {
  expect(bodyUnderTitle('# Another heading\nBody', 'Docs Style Guide')).toBe('# Another heading\nBody');
  expect(bodyUnderTitle('## Docs Style Guide\nBody', 'Docs Style Guide')).toBe('## Docs Style Guide\nBody');
  expect(bodyUnderTitle(null, 'x')).toBe('');
});
