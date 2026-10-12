import { describe, expect, it } from 'vitest';
import { templateInstallable } from './templates';

describe('template install entry', () => {
  it('requires approval for reviewed templates, including their publisher’s versions', () => {
    expect(templateInstallable({ reviewStatus: 'pending' })).toBe(false);
    expect(templateInstallable({ reviewStatus: 'rejected' })).toBe(false);
    expect(templateInstallable({ reviewStatus: 'approved' })).toBe(true);
    expect(templateInstallable({ reviewStatus: 'not_required' })).toBe(true);
    expect(templateInstallable({})).toBe(true);
  });
});
