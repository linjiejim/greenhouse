import { describe, it, expect, afterEach } from 'vitest';
import { getAppVersion, getAppRevision, getVersionInfo } from './version.js';

const ORIGINAL_VERSION = process.env.APP_VERSION;
const ORIGINAL_REVISION = process.env.APP_REVISION;

afterEach(() => {
  restore('APP_VERSION', ORIGINAL_VERSION);
  restore('APP_REVISION', ORIGINAL_REVISION);
});

function restore(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('version info', () => {
  it('reflects the injected build env', () => {
    process.env.APP_VERSION = 'v0.2.0';
    process.env.APP_REVISION = 'abc1234';
    expect(getAppVersion()).toBe('v0.2.0');
    expect(getAppRevision()).toBe('abc1234');
    expect(getVersionInfo()).toEqual({ version: 'v0.2.0', revision: 'abc1234' });
  });

  it('falls back to dev sentinels when unset', () => {
    delete process.env.APP_VERSION;
    delete process.env.APP_REVISION;
    expect(getAppVersion()).toBe('0.0.0-dev');
    expect(getAppRevision()).toBe('unknown');
  });
});
