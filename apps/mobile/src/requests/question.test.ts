import { describe, expect, it } from 'vitest';
import { inlineQuestion } from './question';
const question = (fields: unknown[]) => ({ kind: 'question' as const, subject: 'ask_user', payload: { fields } });
const choice = { key: 'city', label: 'City', type: 'choice', required: true, options: ['Kyoto', 'Osaka'] };
describe('inline single-choice questions', () => {
  it('keeps the original key and option values, including optional fields', () => {
    expect(inlineQuestion(question([choice]))).toBe(choice);
    expect(inlineQuestion(question([{ ...choice, required: false }]))?.options).toEqual(choice.options);
  });
  it('uses the form for input, multiple fields, empty and long option lists', () => {
    for (const fields of [
      [],
      [{ ...choice, type: 'text' }],
      [choice, choice],
      [{ ...choice, options: [] }],
      [{ ...choice, options: Array.from({ length: 7 }, (_, i) => `${i}`) }],
      [{ ...choice, options: 'not an array' }],
    ])
      expect(inlineQuestion(question(fields))).toBeNull();
    expect(
      inlineQuestion(question([{ ...choice, options: Array.from({ length: 6 }, (_, i) => `${i}`) }])),
    ).not.toBeNull();
  });
  it('never settles an approval or another kind of request inline', () => {
    expect(inlineQuestion({ ...question([choice]), kind: 'approval' })).toBeNull();
    expect(inlineQuestion({ ...question([choice]), subject: 'tool_write' })).toBeNull();
  });
});
