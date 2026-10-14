import { describe, expect, it } from 'vitest';
import { isFilePath, parseAppPath } from './app-links';

describe('the web app’s routes as places in the app (PRD §6.4)', () => {
  it('reads conversations, Agents, runs and the rest, with or without the hash', () => {
    expect(parseAppPath('#/c/conv-1')).toEqual({ kind: 'conversation', id: 'conv-1' });
    expect(parseAppPath('/c/conv-1')).toEqual({ kind: 'conversation', id: 'conv-1' });
    expect(parseAppPath('/c/main')).toEqual({ kind: 'main' });
    expect(parseAppPath('#/')).toEqual({ kind: 'main' });
    expect(parseAppPath('/c/new')).toEqual({ kind: 'new-chat' });
    expect(parseAppPath('#/agents')).toEqual({ kind: 'agents' });
    expect(parseAppPath('#/agents/ag_1')).toEqual({ kind: 'agent', id: 'ag_1' });
    expect(parseAppPath('/runs/run-9')).toEqual({ kind: 'run', id: 'run-9' });
    expect(parseAppPath('/runs?state=done')).toEqual({ kind: 'runs' });
    expect(parseAppPath('/notifications')).toEqual({ kind: 'notifications' });
    expect(parseAppPath('#/settings/notifications')).toEqual({ kind: 'settings' });
  });

  it('leaves knowledge, tables and apps to the web app for now', () => {
    expect(parseAppPath('#/knowledge/doc-1')).toEqual({ kind: 'web', path: '/knowledge/doc-1' });
    expect(parseAppPath('/knowledge/folder/f-1')).toEqual({ kind: 'web', path: '/knowledge/folder/f-1' });
    expect(parseAppPath('#/tables/t1/rows/r1')).toEqual({ kind: 'web', path: '/tables/t1/rows/r1' });
  });

  it('follows nothing else', () => {
    expect(parseAppPath('https://example.com/c/1')).toBeNull();
    expect(parseAppPath('/api/files/f1/content')).toBeNull();
    expect(parseAppPath('/c/../../etc')).toBeNull();
    expect(parseAppPath('/c/conv-1/extra')).toBeNull();
    expect(parseAppPath('/elsewhere')).toBeNull();
    expect(parseAppPath('c/conv-1')).toBeNull();
  });

  it('knows a signed file of this station by its path', () => {
    expect(isFilePath('/api/files/f_1/content?exp=1&m=r&sig=abc')).toBe(true);
    expect(isFilePath('/api/files/f_1/content')).toBe(true);
    expect(isFilePath('/api/files/../content')).toBe(false);
    expect(isFilePath('https://x.example/api/files/f_1/content')).toBe(false);
  });
});
