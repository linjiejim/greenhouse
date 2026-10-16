import { describe, expect, it } from 'vitest';
import { defineExtension, selectExtensions } from '../define.js';
import { extensionTools } from '../host.js';
import type { Services } from '../../app.js';

it('rejects ambiguous registrations and names outside an extension namespace', () => {
  expect(() => defineExtension({ id: '../escape', name: 'Bad' })).toThrow();
  expect(() => defineExtension({ id: 'notes', name: 'Notes', pages: ['one', 'one'] })).toThrow();
  expect(() =>
    defineExtension({ id: 'example', name: 'Example', providerAdapters: [{ kind: 'openai-compatible' } as never] }),
  ).toThrow('namespaced');
  const one = defineExtension({ id: 'one', name: 'One' });
  expect(selectExtensions([one], [])).toEqual([]);
  expect(selectExtensions([one], 'all')).toEqual([one]);
  expect(() => selectExtensions([one], ['missing'])).toThrow('not compiled');
  expect(() => selectExtensions([one, one], 'all')).toThrow('Duplicate');
});

describe('extension tools', () => {
  it('cannot shadow core tools', () => {
    const extension = defineExtension({ id: 'example', name: 'Example', tools: () => [{ name: 'memory' } as never] });
    expect(() => extensionTools([extension], {} as Services)).toThrow('namespaced');
  });
});
