import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { post, seg } from '../api/client';
import { ChatCard } from '../chat/chat-card';
import { captureIdentity } from '../data/identity';
import { useT } from '../lib/i18n';
import type { MessageItem } from '../shared/contract';
import { useAuth } from '../store/auth';
import { makeStyles, space, typo, useTheme, weight } from '../theme';
import { useFontScaleKey } from '../ui/font-scale';
import { NativeButton } from '../ui/button';
import { alertError } from '../ui/dialogs';

export function WriteReceipt({ message }: { message: MessageItem }) {
  const t = useT();
  const fontKey = useFontScaleKey();
  const { colors } = useTheme();
  const styles = useStyles(colors);
  const member = useAuth((s) => s.user?.id);
  const [undone, setUndone] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const event = message.event;
  const done = undone || event?.undone === true;
  const undo = async () => {
    if (pending.current || done || typeof event?.step_id !== 'string' || event.member_id !== member) return;
    const current = captureIdentity();
    pending.current = true;
    setBusy(true);
    const result = await post<void>(`/api/runs/steps/${seg(event.step_id)}/undo`);
    pending.current = false;
    if (!current()) return;
    setBusy(false);
    if (result.ok || result.code === 'already_undone') setUndone(true);
    else
      alertError(
        t(['stale_version', 'stale_revision'].includes(result.code) ? 'integration.undoConflict' : 'work.saveFailed'),
        undefined,
        result.message,
      );
  };
  return (
    <ChatCard inset style={styles.card}>
      <View key={fontKey} style={styles.texts}>
        <Text style={styles.title}>{t('integration.receipt')}</Text>
        <Text selectable style={styles.body}>
          {message.content}
        </Text>
      </View>
      {event?.member_id === member && typeof event?.step_id === 'string' ? (
        <View style={styles.action}>
          <NativeButton
            label={t(done ? 'integration.undone' : 'integration.undo')}
            icon="rotate"
            loading={busy}
            disabled={done}
            onPress={() => void undo()}
          />
        </View>
      ) : null}
    </ChatCard>
  );
}
const useStyles = makeStyles((c) => ({
  card: { padding: space.md, gap: space.sm },
  texts: { gap: space.sm },
  title: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
  body: { ...typo.body, color: c.label },
  action: { alignSelf: 'flex-end' },
}));
