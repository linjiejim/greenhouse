/** Compact transcript card. The native form lives in /sheets/ask-user. */
import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useT } from '../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme } from '../theme';
import { Icon, Touchable } from '../ui/core';
import { askFormKey, useAskForms } from './ask-user-store';
import { parseAnswers, type AskUserData } from './ask-user-model';
export { isAskUserData, type AskUserData } from './ask-user-model';

export function AskUserCard({
  data,
  followUp,
  onReply,
}: {
  data: AskUserData;
  followUp?: string;
  onReply?: (text: string) => Promise<boolean>;
}) {
  const t = useT();
  const router = useRouter();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [key] = useState(askFormKey);
  const form = useAskForms((s) => s.forms[key]);
  const posted = form?.status === 'sent' ? form.message : followUp;
  const submitted = posted != null;
  const summary = useMemo(() => parseAnswers(data.questions, posted), [data.questions, posted]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => () => useAskForms.getState().remove(key), [key]);
  useEffect(() => {
    if (form?.status !== 'queued' || !form.message || !onReply) return;
    const store = useAskForms.getState();
    // Claim synchronously: a repeated effect / tap cannot send twice.
    if (store.forms[key]?.status !== 'queued') return;
    store.patch(key, { status: 'sending' });
    void onReply(form.message).then(
      (ok) => store.patch(key, { status: ok ? 'sent' : 'failed' }),
      () => store.patch(key, { status: 'failed' }),
    );
  }, [key, form?.status, form?.message, onReply]);

  return (
    <View style={styles.card}>
      <Touchable
        accessibilityRole="button"
        accessibilityLabel={`${data.title || t('chat.askTitle')}, ${t(submitted ? 'chat.askSubmitted' : 'chat.askOpen')}`}
        onPress={() => {
          if (submitted) {
            setExpanded((v) => !v);
            return;
          }
          useAskForms.getState().open(key, data, !onReply);
          router.push({ pathname: '/sheets/ask-user', params: { k: key } });
        }}
        style={styles.head}
      >
        <View style={styles.tile}>
          <Icon name={submitted ? 'checkCircleFill' : 'form'} size={20} color={submitted ? c.green : c.accent} />
        </View>
        <View style={styles.texts}>
          <Text style={styles.title} numberOfLines={2}>
            {data.title || t('chat.askTitle')}
          </Text>
          <Text style={styles.meta}>{t(submitted ? 'chat.askSubmitted' : 'chat.askOpen')}</Text>
        </View>
        <Icon name={expanded ? 'chevD' : 'chevR'} size={14} color={c.secondaryLabel} />
      </Touchable>
      {submitted && expanded ? (
        <View style={styles.summary}>
          {data.questions.map((q, i) => (
            <Text key={i} style={styles.meta}>
              {q.label}：{summary.get(i + 1) || '—'}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}
const useStyles = makeStyles((c) => ({
  card: { borderWidth: 0.5, borderColor: c.separator, borderRadius: radius.lg, ...squircle },
  head: { flexDirection: 'row', alignItems: 'center', padding: space.md, gap: space.md, minHeight: 76 },
  tile: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: c.accentFill,
    alignItems: 'center',
    justifyContent: 'center',
    ...squircle,
  },
  texts: { flex: 1, gap: space.xs },
  title: { ...typo.headline, color: c.label },
  meta: { ...typo.subheadline, color: c.secondaryLabel },
  summary: { padding: space.md, paddingTop: 0, gap: space.sm },
}));
