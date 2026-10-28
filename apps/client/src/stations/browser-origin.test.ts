import { expect, it } from 'vitest';
import { browserStationId, browserStorageKey } from './browser-origin';
it('binds persisted sessions and offline copies to the actual browser API origin', () => {
  expect(browserStationId('https://one.test')).not.toBe(browserStationId('https://two.test'));
  expect(browserStationId('https://one.test/')).toBe(browserStationId('https://one.test'));
  const key = `greenhouse_access_token__${browserStationId('https://one.test')}`;
  expect(browserStorageKey(key, 'https://one.test', 'https://one.test')).toBe('greenhouse_access_token');
  expect(browserStorageKey(key, 'https://one.test', 'http://localhost:18921')).toBe(key);
});
