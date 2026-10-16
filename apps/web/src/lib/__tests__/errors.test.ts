import { expect, it } from 'vitest';
import { ApiClientError } from '@greenhouse/contract/client';
import { errorText } from '../errors';
import type { Translate } from '../i18n';

it('maps memory protection codes to the member dictionary', () => {
  const t = ((key: string) => key) as Translate;
  expect(errorText(new ApiClientError(403, 'memory_background_read_only', 'private'), t)).toBe(
    'errors.memoryBackgroundReadOnly',
  );
  expect(errorText(new ApiClientError(403, 'memory_untrusted_content', 'private'), t)).toBe(
    'errors.memoryUntrustedContent',
  );
});

it.each([
  [403, 'errors.permission'],
  [404, 'errors.missing'],
  [409, 'errors.conflict'],
  [504, 'errors.requestTimeout'],
  [500, 'errors.temporarilyUnavailable'],
  [400, 'errors.invalidInput'],
] as const)('keeps server internals out of a localized %s error', (status, expected) => {
  const t = ((key: string) => key) as Translate;
  expect(errorText(new ApiClientError(status, 'unknown_code', 'agent_id agt_private internal details'), t)).toBe(
    expected,
  );
});
