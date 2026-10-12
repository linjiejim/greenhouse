/** Authenticated local cache → iOS Quick Look. Sharing is an explicit secondary action. */
import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { FilePreviewView } from '../modules/file-preview';
import { downloadFile, type CachedFile } from '../src/lib/share-file';
import { useT } from '../src/lib/i18n';
import { useStations } from '../src/store/stations';
import { space, typo, useTheme } from '../src/theme';
import { EmptyState, LoadingState } from '../src/ui/empty';
import { NativeButton } from '../src/ui/button';
import { SheetClose } from '../src/ui/sheet-chrome';
import { toolbarIcon } from '../src/ui/toolbar-icon';
import { alertError } from '../src/ui/dialogs';

export default function FilePreview() {
  const { path = '', name = 'download' } = useLocalSearchParams<{ path?: string; name?: string }>();
  const station = useStations((s) => s.activeId);
  const [owner] = useState(station);
  const [file, setFile] = useState<CachedFile | null>(null);
  const [failed, setFailed] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [attempt, retry] = useState(0);
  const [sharing, setSharing] = useState(false);
  const t = useT();
  const { colors } = useTheme();
  useEffect(() => {
    const abort = new AbortController();
    let cached: CachedFile | undefined;
    setFile(null);
    setFailed(false);
    setUnsupported(false);
    if (station !== owner) return;
    void downloadFile(path, name, abort.signal)
      .then((result) => {
        if (abort.signal.aborted) {
          result.dispose();
          return;
        }
        cached = result;
        setFile(result);
      })
      .catch(() => {
        if (!abort.signal.aborted) setFailed(true);
      });
    return () => {
      abort.abort();
      cached?.dispose();
    };
  }, [path, name, station, owner, attempt]);
  const share = async () => {
    if (!file || sharing || station !== owner) return;
    setSharing(true);
    try {
      await Sharing.shareAsync(file.uri, { mimeType: file.mimeType, dialogTitle: file.name });
    } catch {
      alertError(t('chat.downloadFailed'));
    } finally {
      setSharing(false);
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ title: file?.name ?? name }} />
      <SheetClose />
      {file && station === owner ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon={toolbarIcon('share')}
            accessibilityLabel={t('chat.fileShare')}
            disabled={sharing}
            onPress={() => void share()}
          />
        </Stack.Toolbar>
      ) : null}
      {station !== owner ? (
        <EmptyState icon="file" title={t('chat.expired')} style={{ flex: 1 }} />
      ) : failed ? (
        <EmptyState
          icon="file"
          title={t('chat.downloadFailed')}
          onRetry={() => retry((n) => n + 1)}
          style={{ flex: 1 }}
        />
      ) : !file ? (
        <LoadingState style={{ flex: 1 }} />
      ) : file.previewText !== undefined ? (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.margin }}>
          <Text selectable style={{ ...typo.body, color: colors.label }}>
            {file.previewText}
          </Text>
          {file.previewTruncated ? (
            <Text style={{ ...typo.footnote, color: colors.secondaryLabel, marginTop: space.md }}>
              {t('chat.fileTextTruncated')}
            </Text>
          ) : null}
        </ScrollView>
      ) : !FilePreviewView || unsupported ? (
        <EmptyState
          icon="file"
          title={t('chat.fileUnsupported')}
          message={file.name}
          style={{ flex: 1 }}
          action={
            <NativeButton label={t('chat.fileShare')} icon="share" onPress={() => void share()} disabled={sharing} />
          }
        />
      ) : (
        <FilePreviewView uri={file.uri} onUnsupported={() => setUnsupported(true)} style={{ flex: 1 }} />
      )}
    </View>
  );
}
