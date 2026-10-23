/**
 * A Files file in Quick Look (`/file-preview?id=&name=`): downloaded with this station's session
 * into a private cache directory that goes when the page closes (src/lib/share-file.ts); text
 * formats read as plain selectable text. Share opens the system sheet (save to Files, AirDrop…).
 */

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
import { toolbarIcon } from '../src/ui/toolbar-icon';
import { alertError } from '../src/ui/dialogs';

export default function FilePreview() {
  const { id = '', name = '' } = useLocalSearchParams<{ id?: string; name?: string }>();
  const path = /^[0-9]+$/.test(id) ? `/api/drive/files/${id}/content` : '';
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
    if (station !== owner || !path) {
      setFailed(true);
      return;
    }
    void downloadFile(path, name || 'download', abort.signal)
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
      alertError(t('files.shareFailed'));
    } finally {
      setSharing(false);
    }
  };
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Stack.Screen options={{ title: file?.name ?? name }} />
      {file && station === owner ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon={toolbarIcon('share')}
            accessibilityLabel={t('files.share')}
            disabled={sharing}
            onPress={() => void share()}
          />
        </Stack.Toolbar>
      ) : null}
      {failed ? (
        <EmptyState icon="file" title={t('files.downloadFailed')} onRetry={() => retry((n) => n + 1)} style={{ flex: 1 }} />
      ) : !file ? (
        <LoadingState style={{ flex: 1 }} />
      ) : file.previewText !== undefined ? (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: space.margin }}>
          <Text selectable style={{ ...typo.body, color: colors.label }}>
            {file.previewText}
          </Text>
          {file.previewTruncated ? (
            <Text style={{ ...typo.footnote, color: colors.secondaryLabel, marginTop: space.md }}>
              {t('files.textTruncated')}
            </Text>
          ) : null}
        </ScrollView>
      ) : !FilePreviewView || unsupported ? (
        <EmptyState
          icon="file"
          title={t('files.unsupported')}
          message={file.name}
          style={{ flex: 1 }}
          action={<NativeButton label={t('files.share')} icon="share" onPress={() => void share()} disabled={sharing} />}
        />
      ) : (
        <FilePreviewView uri={file.uri} onUnsupported={() => setUnsupported(true)} style={{ flex: 1 }} />
      )}
    </View>
  );
}
