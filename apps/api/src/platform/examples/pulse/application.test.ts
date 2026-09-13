import { describe, expect, it, vi } from 'vitest';
import { ApplicationRegistry, AuthorizationDeniedError, type ActorContext } from '@greenhouse/platform-kernel';
import { pulseRegistration, type PulseContext } from './registration.js';

const actor: ActorContext = {
  actorId: 'pulse-user',
  actorType: 'human',
  orgId: 'default',
  requestId: 'pulse-request',
  authMethod: 'session',
};

describe('Pulse reference Platform application', () => {
  it('registers and dispatches without any kernel modification', async () => {
    const audit = vi.fn();
    const registry = new ApplicationRegistry<PulseContext>({
      authorize: () => ({ allowed: true, reason: 'reference-test' }),
      audit,
    });
    registry.register(pulseRegistration);
    const context: PulseContext = { signals: [] };

    const created = await registry.dispatch(
      {
        actor,
        appId: 'pulse',
        actionId: 'publishSignal',
        payload: { title: 'API healthy', severity: 'info' },
      },
      context,
    );
    expect(created).toMatchObject({
      ok: true,
      data: { id: 1, title: 'API healthy', ownerId: 'pulse-user' },
    });
    expect(
      await registry.dispatch(
        {
          actor,
          appId: 'pulse',
          actionId: 'listSignals',
          payload: {},
        },
        context,
      ),
    ).toEqual({ ok: true, data: context.signals });
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it('keeps an unauthorized new application fail-closed', async () => {
    const handlerContext: PulseContext = { signals: [] };
    const registry = new ApplicationRegistry<PulseContext>({
      authorize: () => ({ allowed: false, reason: 'default-deny' }),
      audit: () => undefined,
    });
    registry.register(pulseRegistration);

    await expect(
      registry.dispatch(
        {
          actor,
          appId: 'pulse',
          actionId: 'publishSignal',
          payload: { title: 'Must not persist', severity: 'critical' },
        },
        handlerContext,
      ),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    expect(handlerContext.signals).toEqual([]);
  });
});
