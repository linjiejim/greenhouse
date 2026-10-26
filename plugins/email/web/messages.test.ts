import { describe, it, expect } from 'vitest';
import { EMAIL_PRESETS } from '@greenhouse/types/email';
import { messages } from './messages';
function get(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), obj);
}
describe('email preset instructions', () => {
  it.each(EMAIL_PRESETS)('$id has instructions in both locales', (preset) => {
    expect(get(messages.en, preset.help_key)).toBeTruthy();
    expect(get(messages.zh, preset.help_key)).toBeTruthy();
  });
});
