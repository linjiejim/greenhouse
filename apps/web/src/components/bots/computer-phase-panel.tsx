/**
 * Everything the computer pane shows instead of the live screen: unavailable
 * (team members get the "why", supers get the way to fix it), asleep, starting,
 * queued, stopping, checking and error. Copy per phase lives here so the pane
 * itself stays an orchestrator.
 */

import React from 'react';
import type { ComputerRuntimeView } from '@greenhouse/types/bots';
import { Button, EmptyState, Spinner } from '../ui';
import { AlertTriangle, Monitor, Play } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { reasonKey, type ComputerPhase } from './computer-phase';

const ADMIN_PATH = '#/administration/bot-computers';

export function ComputerPhasePanel({
  phase,
  isSuper,
  starting,
  onStart,
}: {
  phase: ComputerPhase;
  isSuper: boolean;
  starting: boolean;
  onStart: () => void;
}) {
  const t = useT();
  switch (phase.kind) {
    case 'unavailable':
      return <UnavailablePanel runtime={phase.runtime} isSuper={isSuper} />;
    case 'asleep': {
      // Why it sleeps (idle timeout, made room for a colleague) when the server says so.
      const why = phase.reason === 'idle' || phase.reason === 'lru' ? reasonKey(phase.reason) : null;
      return (
        <EmptyState
          variant="compact"
          icon={Monitor}
          title={t('botsComputer.state_asleep')}
          description={why ? `${t(why)} ${t('botsComputer.state_asleepKept')}` : t('botsComputer.state_asleepDesc')}
          action={
            <Button size="sm" onClick={onStart} disabled={starting} data-testid="computer-start">
              {starting ? <Spinner className="mr-1" /> : <Play size={14} className="mr-1" aria-hidden="true" />}
              {t('botsComputer.start')}
            </Button>
          }
        />
      );
    }
    case 'error': {
      const key = reasonKey(phase.reason);
      return (
        <EmptyState
          variant="compact"
          tone="danger"
          icon={AlertTriangle}
          title={t('botsComputer.state_error')}
          description={key ? t(key) : t('botsComputer.reason_unknown')}
          action={
            <Button size="sm" onClick={onStart} disabled={starting} data-testid="computer-start">
              {starting ? <Spinner className="mr-1" /> : <Play size={14} className="mr-1" aria-hidden="true" />}
              {t('botsComputer.startAgain')}
            </Button>
          }
        />
      );
    }
    case 'starting':
    case 'queued':
    case 'stopping':
    case 'checking': {
      const copy: Record<typeof phase.kind, { title: string; description?: string }> = {
        starting: { title: t('botsComputer.state_starting'), description: t('botsComputer.state_startingDesc') },
        queued: {
          title: t('botsComputer.state_queued'),
          description: t('botsComputer.state_queuedDesc', { position: phase.kind === 'queued' ? phase.position : 1 }),
        },
        stopping: { title: t('botsComputer.state_stopping') },
        checking: { title: t('botsComputer.state_checking') },
      };
      const { title, description } = copy[phase.kind];
      return (
        <div className="flex flex-col items-center gap-2 px-3 py-10 text-center" role="status">
          <Spinner className="h-5 w-5 text-primary-fg" />
          <p className="text-sm font-semibold text-fg-secondary">{title}</p>
          {description && <p className="max-w-xs text-xs leading-5 text-fg-muted">{description}</p>}
        </div>
      );
    }
    default:
      return null;
  }
}

function UnavailablePanel({ runtime, isSuper }: { runtime: ComputerRuntimeView; isSuper: boolean }) {
  const t = useT();
  if (!isSuper) {
    return (
      <EmptyState
        variant="compact"
        tone="neutral"
        icon={Monitor}
        title={t('botsComputer.unavailableTeamTitle')}
        description={t('botsComputer.unavailableTeamDesc')}
      />
    );
  }
  const key = reasonKey(runtime.reason);
  const why = key ? t(key) : runtime.reason;
  return (
    <EmptyState
      variant="compact"
      tone="neutral"
      icon={Monitor}
      title={
        runtime.state === 'disabled'
          ? t('botsComputer.unavailableSuperTitleDisabled')
          : t('botsComputer.unavailableSuperTitleBroken')
      }
      description={why ? `${why} ${t('botsComputer.unavailableSuperDesc')}` : t('botsComputer.unavailableSuperDesc')}
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            window.location.hash = ADMIN_PATH;
          }}
          data-testid="computer-open-admin"
        >
          {t('botsComputer.openAdmin')}
        </Button>
      }
    />
  );
}
