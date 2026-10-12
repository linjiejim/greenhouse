import { describe, expect, it } from 'vitest';
import { canSubmitAnswers, formatAnswers, parseAnswers, type Question } from './ask-user-model';
const questions: Question[] = [
  { id: 'period', label: '统计周期', type: 'single_choice', options: [{ label: '本月', value: 'month' }] },
  { id: 'notes', label: '补充说明', type: 'textarea', required: false },
];
describe('ask_user sheet answers', () => {
  it('submits the required choice without requesting optional information', () => {
    expect(canSubmitAnswers(questions, { period: 'month' })).toBe(true);
    const message = formatAnswers(questions, { period: 'month' });
    expect(message).toContain('**1. 统计周期**: 本月 (month)');
    expect(parseAnswers(questions, message).get(1)).toBe('本月');
  });
  it('rejects missing/unknown choices and whitespace-only required text', () => {
    expect(canSubmitAnswers(questions, {})).toBe(false);
    expect(canSubmitAnswers(questions, { period: 'unknown' })).toBe(false);
    expect(canSubmitAnswers([{ id: 'text', label: '说明', type: 'text' }], { text: '  ' })).toBe(false);
  });
});
