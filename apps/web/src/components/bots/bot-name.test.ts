import { describe, expect, it } from 'vitest';
import { botNameIssueFromCode, validateBotName } from './bot-name';

const context = { otherNames: ['Sage', '小文'], nickname: 'Jim' };

describe('validateBotName', () => {
  it('accepts an ordinary name', () => {
    expect(validateBotName('Fern', context)).toBeNull();
    expect(validateBotName('  小青  ', context)).toBeNull();
  });

  it('requires a name within the length limit (counted in characters, not UTF-16 units)', () => {
    expect(validateBotName('   ', context)).toBe('required');
    expect(validateBotName('a'.repeat(25), context)).toBe('too_long');
    expect(validateBotName('研'.repeat(24), context)).toBeNull();
  });

  it('rejects characters that would forge speaker tags', () => {
    expect(validateBotName('[Sage]', context)).toBe('chars');
    expect(validateBotName('Bot: x', context)).toBe('chars');
    expect(validateBotName('小研：', context)).toBe('chars');
    expect(validateBotName('two\nlines', context)).toBe('chars');
  });

  it('rejects reserved words, the member nickname and duplicates, case-insensitively', () => {
    expect(validateBotName('System', context)).toBe('reserved');
    expect(validateBotName('用户', context)).toBe('reserved');
    expect(validateBotName('jim', context)).toBe('is_you');
    expect(validateBotName('sage', context)).toBe('taken');
  });

  it('maps API codes onto the same vocabulary', () => {
    expect(botNameIssueFromCode('bot_name_taken')).toBe('taken');
    expect(botNameIssueFromCode('bot_limit')).toBe('limit');
    expect(botNameIssueFromCode(null)).toBeNull();
  });
});
