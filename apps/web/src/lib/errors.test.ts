import { expect, it } from 'vitest';
import { ApiClientError } from '@greenhouse/contract/client';
import { errorText } from './errors';
import { translate } from './i18n';

it('localizes all three switches and the generic pause in both languages', () => {
  for (const locale of ['zh', 'en'] as const) {
    const t = translate.bind(null, locale);
    for (const [operation, key] of [
      ['disable_computers', 'errors.computersDisabled'],
      ['pause_background_runs', 'errors.backgroundPaused'],
      ['disable_outbound_mail', 'errors.outboundMailDisabled'],
      ['unknown', 'errors.operationDisabled'],
    ] as const) {
      const error = new ApiClientError(503, 'operation_disabled', 'An admin temporarily paused this operation.', {
        switch: operation,
      });
      expect(errorText(error, t)).toBe(t(key));
    }
  }
});
