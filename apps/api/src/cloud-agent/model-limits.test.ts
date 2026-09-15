import { describe, expect, it } from 'vitest';
import { RELAY_DEFAULT_OUTPUT_TOKENS, relayOutputLimits } from './model-limits.js';

const lookup = (id: string) =>
  (
    ({
      flash: { options: { max_tokens: 16000 } },
      pro: { options: {} },
      weird: { options: { max_tokens: -5 } },
    }) as Record<string, { options?: { max_tokens?: number } }>
  )[id];

describe('relayOutputLimits', () => {
  it('uses the catalog cap and falls back to the relay default', () => {
    expect(relayOutputLimits(['flash', 'pro', 'unknown', 'weird'], lookup)).toEqual({
      flash: 16000,
      pro: RELAY_DEFAULT_OUTPUT_TOKENS,
      unknown: RELAY_DEFAULT_OUTPUT_TOKENS,
      weird: RELAY_DEFAULT_OUTPUT_TOKENS,
    });
  });

  it('drops empty ids and repeats', () => {
    expect(relayOutputLimits(['flash', null, undefined, '', 'flash'], lookup)).toEqual({ flash: 16000 });
  });
});
