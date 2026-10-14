import { ScrollView } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Comments } from '../src/knowledge/comments';
import { useT } from '../src/lib/i18n';
export default function CommentPage() {
  const { id = '', kind = 'doc' } = useLocalSearchParams<{ id: string; kind: 'doc' | 'record' }>();
  const t = useT();
  return (
    <>
      <Stack.Screen options={{ title: t('work.comments') }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 40 }}
      >
        <Comments id={id} kind={kind} />
      </ScrollView>
    </>
  );
}
