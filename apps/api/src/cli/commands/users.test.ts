import { describe, expect, it } from 'vitest';

import { passwordValidationError } from './users.js';

describe('CLI user password validation', () => {
  it('keeps the normal account minimum at eight characters', () => {
    expect(passwordValidationError('hengsen')).toBe('Password must be at least 8 characters');
    expect(passwordValidationError('12345678')).toBeNull();
  });

  it('allows the seven-character run-dev password only with the explicit override', () => {
    expect(passwordValidationError('hengsen', true)).toBeNull();
    expect(passwordValidationError('123456', true)).toBe('Password must be at least 7 characters');
  });
});
