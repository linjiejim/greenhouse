import { ScrollView } from 'react-native';
import type { ApiMiss } from '../api/client';
import { useT } from '../lib/i18n';
import { LoadingState } from '../ui/loading-state';
import { EmptyState } from '../ui/empty';
export function ResourceState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error?: ApiMiss | null;
  retry: () => void;
}) {
  const t = useT();
  const unavailable = error?.status === 403 || error?.status === 404;
  const message =
    error?.code === 'network'
      ? t('work.offlineHint')
      : error?.status === 403
        ? t('work.noAccessHint')
        : error?.status === 404
          ? t('work.missingHint')
          : t('work.retryHint');
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
    >
      {loading ? (
        <LoadingState />
      ) : (
        <EmptyState
          icon={unavailable ? 'shieldCheck' : 'alert'}
          title={t(unavailable ? 'work.unavailable' : 'work.loadFailed')}
          message={message}
          onRetry={retry}
        />
      )}
    </ScrollView>
  );
}
