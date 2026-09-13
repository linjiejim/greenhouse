import type { ApplicationRegistration, PlatformActionHandler } from '@greenhouse/platform-kernel';
import { pulseManifest } from './manifest.js';

export interface PulseSignal {
  id: number;
  title: string;
  ownerId: string;
  severity: 'info' | 'warning' | 'critical';
}

export interface PulseContext {
  signals: PulseSignal[];
}

const listSignals: PlatformActionHandler<PulseContext> = async (_request, context) => ({
  ok: true,
  data: context.signals,
});

const publishSignal: PlatformActionHandler<PulseContext> = async (request, context) => {
  const input = request.payload as Partial<PulseSignal>;
  if (typeof input.title !== 'string' || !['info', 'warning', 'critical'].includes(input.severity ?? '')) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'title and severity are required',
    };
  }
  const signal: PulseSignal = {
    id: context.signals.length + 1,
    title: input.title,
    ownerId: request.actor.actorId,
    severity: input.severity!,
  };
  context.signals.push(signal);
  return { ok: true, data: signal };
};

export const pulseRegistration: ApplicationRegistration<PulseContext> = {
  manifest: pulseManifest,
  handlers: { listSignals, publishSignal },
};
