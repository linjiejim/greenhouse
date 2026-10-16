import { useCallback } from 'react';
import { ScrollView, View, Text } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { knowledgeFile } from '../../src/api/knowledge';
import { fileUrl } from '../../src/api/files';
import { useResource } from '../../src/data/use-resource';
import { ResourceState } from '../../src/knowledge/state';
import { useT } from '../../src/lib/i18n';
import { saveFile } from '../../src/chat/file-card';
import { NativeButton } from '../../src/ui/button';
import { formatBytes } from '../../src/lib/format';
import { useTheme, space, typo } from '../../src/theme';
export default function File() {
  const { id = '' } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const { colors: c } = useTheme();
  const r = useResource(
    useCallback(() => knowledgeFile(id), [id]),
    ['knowledge.changed', 'doc.updated', 'comments.updated'],
  );
  return (
    <>
      <Stack.Screen options={{ title: r.data?.name ?? t('work.file') }} />
      {!r.data ? (
        <ResourceState error={r.error} loading={r.loading} retry={() => void r.refresh()} />
      ) : (
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingHorizontal: space.margin, gap: space.md }}
        >
          {r.data.preview === 'image' ? (
            <Image
              source={{ uri: fileUrl(r.data.url) }}
              style={{ width: '100%', height: 300 }}
              contentFit="contain"
              accessibilityLabel={r.data.name}
            />
          ) : null}
          <Text style={{ ...typo.body, color: c.secondaryLabel }}>{formatBytes(r.data.size_bytes ?? 0)}</Text>
          <View>
            <NativeButton label={t('work.openFile')} icon="open" onPress={() => saveFile(r.data!.url, r.data!.name)} />
          </View>
        </ScrollView>
      )}
    </>
  );
}
