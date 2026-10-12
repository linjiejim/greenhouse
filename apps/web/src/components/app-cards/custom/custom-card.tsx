/** Custom code execution stays disabled until nested-frame WebRTC isolation is enforceable. */
import { useT } from '../../../lib/i18n';
import type { AppCardRendererProps } from '../types';

export function AppCustomCard({ card }: AppCardRendererProps<'custom'>) {
  const t = useT();
  return (
    <div
      className="rounded-lg border border-edge bg-surface-muted p-4 text-sm text-fg-muted"
      data-testid={`app-custom-${card.id}`}
    >
      {t('apps.sandbox.executionUnavailable')}
    </div>
  );
}
