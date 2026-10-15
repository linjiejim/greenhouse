import { expect, it } from 'vitest';
import { operationErrorText } from './operation-error';

it('maps every operation switch and unknown switches without displaying server text', () => {
  const t = (key: string) => key;
  for (const [operation, key] of [
    ['disable_computers', 'computersDisabled'],
    ['pause_background_runs', 'backgroundPaused'],
    ['disable_outbound_mail', 'outboundMailDisabled'],
    ['unknown', 'operationPaused'],
  ])
    expect(operationErrorText({ code: 'operation_disabled', details: { switch: operation } }, t)).toBe(
      `integration.${key}`,
    );
  expect(operationErrorText({ code: 'network' }, t)).toBeUndefined();
});
