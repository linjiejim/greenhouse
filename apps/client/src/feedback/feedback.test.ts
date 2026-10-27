import { describe, expect, it } from 'vitest';
import { feedbackContext, lastErrorLine, recordError } from './last-error';

describe('feedback context', () => {
  it('names the app, the platform and only the station host', () => {
    expect(feedbackContext({ version: '3.0.0 (45)', platform: 'ios 26.5', stationUrl: 'https://green.example.com/base', lastError: null })).toEqual({
      app: '3.0.0 (45)',
      platform: 'ios 26.5',
      station: 'green.example.com',
    });
    expect(feedbackContext({ version: '', platform: 'ios', stationUrl: 'not a url', lastError: null })).toEqual({ app: 'unknown', platform: 'ios' });
  });

  it('carries the last error shown, with how long ago', () => {
    expect(lastErrorLine()).toBeNull();
    recordError('Couldn’t load files', 'The station did not answer');
    const line = lastErrorLine(Date.now() + 3 * 60000);
    expect(line).toBe('Couldn’t load files — The station did not answer (3 min ago)');
    expect(feedbackContext({ version: '3', platform: 'ios', stationUrl: null, lastError: line }).last_error).toBe(line);
  });
});
