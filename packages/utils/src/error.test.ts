import { describe, it, expect } from 'vitest';
import { isUniqueViolation, toErrorMessage } from './error.js';

describe('toErrorMessage', () => {
  it('reads Error.message and stringifies anything else', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
    expect(toErrorMessage('boom')).toBe('boom');
    expect(toErrorMessage(42)).toBe('42');
  });
});

describe('isUniqueViolation', () => {
  it('matches a raw postgres.js error', () => {
    expect(isUniqueViolation(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe(true);
  });

  it('matches a drizzle-wrapped error, where the code hides on cause', () => {
    // The regression this helper exists for: Tables checked only the top level,
    // so every duplicate name came back as a 500 instead of a 409.
    const wrapped = Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('duplicate key value'), { code: '23505' }),
    });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('falls back to the message when a wrapper dropped the code', () => {
    expect(isUniqueViolation(new Error('violates unique constraint'))).toBe(true);
    expect(isUniqueViolation({ cause: { message: 'violates unique constraint' } })).toBe(true);
  });

  it('does not match unrelated failures', () => {
    expect(isUniqueViolation(new Error('connection refused'))).toBe(false);
    expect(isUniqueViolation(Object.assign(new Error('fk'), { code: '23503' }))).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});
