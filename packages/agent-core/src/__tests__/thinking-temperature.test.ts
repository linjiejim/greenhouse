/**
 * DeepSeek ignores temperature while thinking and @ai-sdk/deepseek warns on
 * every such call. The concrete-provider wrapper drops it on exactly the calls
 * the client would treat as thinking, and nowhere else.
 */

import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { stripThinkingTemperature } from '../model.js';

const call = (extra: Partial<LanguageModelV3CallOptions> = {}): LanguageModelV3CallOptions =>
  ({ prompt: [], temperature: 0.4, ...extra }) as LanguageModelV3CallOptions;
const thinking = (type: string) => ({ providerOptions: { deepseek: { thinking: { type } } } });

describe('stripThinkingTemperature', () => {
  it('drops temperature when thinking is switched on explicitly', () => {
    expect(stripThinkingTemperature('deepseek.chat', 'deepseek-chat', call(thinking('enabled')))).not.toHaveProperty(
      'temperature',
    );
  });

  it('drops temperature on a model that thinks by default when nothing switched it off', () => {
    for (const model of ['deepseek-v4-flash', 'deepseek-flash', 'deepseek-pro', 'deepseek-reasoner']) {
      expect(stripThinkingTemperature('deepseek.chat', model, call()), model).not.toHaveProperty('temperature');
    }
  });

  it('keeps temperature when thinking is disabled', () => {
    expect(stripThinkingTemperature('deepseek.chat', 'deepseek-v4-flash', call(thinking('disabled')))).toMatchObject({
      temperature: 0.4,
    });
  });

  it('keeps temperature on a non-thinking DeepSeek model and on other providers', () => {
    expect(stripThinkingTemperature('deepseek.chat', 'deepseek-chat', call())).toMatchObject({ temperature: 0.4 });
    expect(stripThinkingTemperature('openai.chat', 'gpt-4o-mini', call(thinking('enabled')))).toMatchObject({
      temperature: 0.4,
    });
  });
});
