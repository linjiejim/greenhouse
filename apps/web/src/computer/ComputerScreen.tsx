import { lazy, Suspense } from 'react';
import { Skeleton } from '@greenhouse/ui/kit';
import { useT } from '../lib/i18n';

const Screen = lazy(() => import('./ComputerScreenView').then((module) => ({ default: module.ComputerScreen })));

export function ComputerScreen(props: {
  agentId: string;
  control: boolean;
  onControlChange?: (control: boolean) => void;
}) {
  const t = useT();
  return (
    <Suspense
      fallback={
        <div className="app-screen" role="status" aria-label={t('computer.connecting')}>
          <div className="app-screen-bar">{t('computer.connecting')}</div>
          <div className="app-screen-canvas app-screen-loading">
            <Skeleton lines={6} />
          </div>
        </div>
      }
    >
      <Screen {...props} />
    </Suspense>
  );
}
