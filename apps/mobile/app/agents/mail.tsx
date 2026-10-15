import { useCallback, useState } from 'react';
import { relativeTimeNow } from '../../src/lib/time-words';
import { ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { mailDetail, releaseMail } from '../../src/api/mail';
import { useResource } from '../../src/data/use-resource';
import { ResourceState } from '../../src/knowledge/state';
import { useT } from '../../src/lib/i18n';
import { ListSection, ListRow } from '../../src/ui/list';
import { NativeButton } from '../../src/ui/button';
import { SheetActions } from '../../src/ui/sheet-actions';
import { SheetClose } from '../../src/ui/sheet-chrome';
import { saveFile } from '../../src/chat/file-card';
import { alertError, confirmAction } from '../../src/ui/dialogs';
import { useTheme, typo, space } from '../../src/theme';
export default function Mail() {
  const { id = '', mail = '' } = useLocalSearchParams<{ id: string; mail: string }>();
  const t = useT();
  const { colors: c } = useTheme();
  const r = useResource(
    useCallback(() => mailDetail(id, mail), [id, mail]),
    ['message.created'],
  );
  const [busy, setBusy] = useState(false);
  const release = async () => {
    const current = r.captureWrite();
    if (
      busy ||
      !(await confirmAction({
        title: t('work.releaseConfirm'),
        message: r.data?.from.address,
        confirmLabel: t('work.release'),
      }))
    )
      return;
    if (!current()) return;
    setBusy(true);
    const result = await releaseMail(id, mail);
    if (!current()) return;
    setBusy(false);
    if (!result.ok) alertError(t('work.saveFailed'), undefined, result.message);
    else void r.refresh();
  };
  return (
    <>
      <Stack.Screen options={{ title: r.data?.subject || t('work.mail') }} />
      <SheetClose />
      {!r.data ? (
        <ResourceState loading={r.loading} retry={() => void r.refresh()} />
      ) : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: 40 }}>
          <ListSection>
            <ListRow title={r.data.from.name || r.data.from.address} subtitle={r.data.from.address} />
            <ListRow
              title={r.data.to.map((a) => a.name || a.address).join(', ')}
              subtitle={relativeTimeNow(r.data.at)}
            />
          </ListSection>
          {r.data.status === 'screened' ? (
            <ListSection>
              <View style={{ padding: space.margin }}>
                {r.data.verified && r.data.screen_reason === 'sender' ? (
                  <SheetActions>
                    <NativeButton
                      label={t('work.release')}
                      variant="prominent"
                      fullWidth
                      size="large"
                      loading={busy}
                      onPress={() => void release()}
                    />
                  </SheetActions>
                ) : (
                  <Text style={{ ...typo.body, color: c.secondaryLabel }}>{t('work.unverified')}</Text>
                )}
              </View>
            </ListSection>
          ) : null}
          <View style={{ padding: space.margin }}>
            <Text selectable style={{ ...typo.body, color: c.label }}>
              {r.data.text}
            </Text>
          </View>
          {r.data.attachments.length ? (
            <ListSection header={t('work.attachment')}>
              {r.data.attachments.map((file, i) => (
                <ListRow
                  key={i}
                  title={file.name}
                  icon="attach"
                  disabled={!file.url}
                  onPress={file.url ? () => saveFile(file.url!, file.name) : undefined}
                  accessory={file.url ? 'chevron' : 'none'}
                />
              ))}
            </ListSection>
          ) : null}
        </ScrollView>
      )}
    </>
  );
}
