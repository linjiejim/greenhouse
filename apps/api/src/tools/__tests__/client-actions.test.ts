/**
 * Client action tools — verifies (1) the client-declared action descriptors are
 * validated/clamped safely, and (2) each generated tool round-trips through the
 * browser bridge (legacy `local-tool-request` event → client posts result → model
 * receives the real UI output).
 */

import { describe, it, expect, vi } from 'vitest';
import { sanitizeClientActions, createClientActionTools } from '../client-actions.js';
import { createClientActionBridge } from '../client-action-bridge.js';
import { resolveClientActionResult } from '../client-action-pending.js';

const objSchema = { type: 'object', properties: { module: { type: 'string' } }, required: ['module'] };

describe('sanitizeClientActions', () => {
  it('returns [] for non-array input', () => {
    expect(sanitizeClientActions(undefined)).toEqual([]);
    expect(sanitizeClientActions(null)).toEqual([]);
    expect(sanitizeClientActions('nope')).toEqual([]);
  });

  it('keeps a well-formed action', () => {
    const out = sanitizeClientActions([{ name: 'crm_navigate', description: 'open a page', parameters: objSchema }]);
    expect(out).toEqual([{ name: 'crm_navigate', description: 'open a page', parameters: objSchema }]);
  });

  it('drops malformed actions (bad name, empty desc, non-object params)', () => {
    const out = sanitizeClientActions([
      { name: 'Bad-Name', description: 'x', parameters: objSchema }, // illegal chars
      { name: '1leading', description: 'x', parameters: objSchema }, // leading digit
      { name: 'no_desc', description: '   ', parameters: objSchema }, // blank desc
      { name: 'bad_params', description: 'x', parameters: [] }, // array, not object
      { name: 'ok_one', description: 'good', parameters: objSchema }, // the only valid one
    ]);
    expect(out.map((a) => a.name)).toEqual(['ok_one']);
  });

  it('dedupes by name and caps the count at 32', () => {
    const dup = sanitizeClientActions([
      { name: 'a', description: 'first', parameters: objSchema },
      { name: 'a', description: 'second', parameters: objSchema },
    ]);
    expect(dup).toHaveLength(1);
    expect(dup[0].description).toBe('first');

    const many = Array.from({ length: 50 }, (_, i) => ({
      name: `act_${i}`,
      description: 'x',
      parameters: objSchema,
    }));
    expect(sanitizeClientActions(many)).toHaveLength(32);
  });

  it('clamps an over-long description', () => {
    const out = sanitizeClientActions([{ name: 'a', description: 'x'.repeat(5000), parameters: objSchema }]);
    expect(out[0].description.length).toBe(2000);
  });

  it('warns when the cap drops actions, naming what was lost', async () => {
    // The desktop's native capabilities plus the browser bridge already claim 20 of
    // the 32 slots, so hitting the cap silently means screenshot/selection/clipboard
    // can disappear from the model's tool list with nothing to explain it.
    const { logger } = await import('@greenhouse/utils/logger');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const many = Array.from({ length: 34 }, (_, i) => ({
        name: `act_${i}`,
        description: 'x',
        parameters: objSchema,
      }));
      expect(sanitizeClientActions(many)).toHaveLength(32);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][1]).toMatchObject({
        cap: 32,
        kept: 32,
        dropped: 2,
        dropped_names: ['act_32', 'act_33'],
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('stays quiet when nothing is dropped', async () => {
    const { logger } = await import('@greenhouse/utils/logger');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      sanitizeClientActions([{ name: 'ok', description: 'good', parameters: objSchema }]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('createClientActionTools round-trip', () => {
  it('emits a local-tool-request with the action name and resolves with the client UI result', async () => {
    const sessionId = `sess-${Math.random().toString(36).slice(2)}`;
    const events: Record<string, unknown>[] = [];
    const userId = 'user-a';
    const bridge = createClientActionBridge(userId, sessionId);
    bridge.setWriter(async (event) => {
      events.push(event);
    });

    const tools = createClientActionTools(
      [{ name: 'crm_navigate', description: 'open a CRM page', parameters: objSchema }],
      bridge,
    );
    expect(Object.keys(tools)).toEqual(['crm_navigate']);

    // Invoke exactly as the AI SDK would: execute(input, { toolCallId }).
    const execPromise = tools.crm_navigate.execute({ module: 'deals' }, { toolCallId: 'c1' });

    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toEqual({
      type: 'local-tool-request',
      toolCallId: 'c1',
      toolId: 'crm_navigate',
      params: { module: 'deals' },
    });

    // The browser executes crm_navigate and posts its result back.
    await vi.waitFor(() =>
      expect(resolveClientActionResult(userId, sessionId, 'c1', { ok: true, navigatedTo: '#/crm/deals' })).toBe(true),
    );

    await expect(execPromise).resolves.toEqual({ ok: true, navigatedTo: '#/crm/deals' });
  });
});
