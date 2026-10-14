import { View } from 'react-native';
import { useT } from '../lib/i18n';
import { LoadingState } from '../ui/loading-state';
import { EmptyState } from '../ui/empty';
export function ResourceState({ loading, retry }: { loading: boolean; retry: () => void }) {
  const t = useT();
  return (
    <View style={{ flex: 1, justifyContent: 'center' }}>
      {loading ? <LoadingState /> : <EmptyState icon="alert" title={t('work.loadFailed')} onRetry={retry} />}
    </View>
  );
}
