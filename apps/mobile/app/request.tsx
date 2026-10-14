/**
 * A 「需要你」 card in full (`/request?id=`, a full-height sheet): the only place a card is
 * decided — nothing is approved without being seen whole (CONV-17).
 *
 *  - approval: what the Agent wants to do and where (its tool's own description); 拒绝 / 批准;
 *  - proposal: new instructions (the text), a background run (its brief) or a skill to save;
 *    拒绝 / 同意 (开始运行);
 *  - question: the Agent's form — a text field or a choice per field, required ones marked;
 *    不回答 / 回答;
 *  - login: the site and the vault item; 拒绝 / 我自己登录 (take over the computer, then hand
 *    it back) / 允许登录 (the server fills it in);
 *  - takeover: why the member is needed; 接管电脑 opens the Agent's screen in control,
 *    交还 hands the computer back with a note for the Agent.
 *
 * Once decided (here or anywhere else) the buttons go and the outcome shows. The card is read
 * from the conversation's transcript when it is open, else from the API.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { listRequests } from '../src/api/requests';
import { useT } from '../src/lib/i18n';
import { relativeTimeNow } from '../src/lib/time-words';
import { softAskAfterDecision } from '../src/push/soft-ask';
import { decide, type Decision } from '../src/requests/decide';
import { KIND_ICON, cardActions, cardBody, checkAnswers, requestStatus, type CardAction } from '../src/requests/model';
import type { NeedsYou, QuestionField } from '../src/shared/contract';
import { useAuth } from '../src/store/auth';
import { useThreads } from '../src/store/threads';
import { useWorkspace } from '../src/store/workspace';
import { HIT, makeStyles, mono, radius, space, squircle, typo, useTheme, weight } from '../src/theme';
import { NativeButton } from '../src/ui/button';
import { Icon } from '../src/ui/core';
import { alertError, confirmAction } from '../src/ui/dialogs';
import { EmptyState, LoadingState } from '../src/ui/empty';
import { NativeMenu } from '../src/ui/menu';
import { SheetClose } from '../src/ui/sheet-chrome';

/** The card from an open transcript, else from the API (pending ones, and all of its conversation's). */
function useRequest(id: string): { request: NeedsYou | null; missing: boolean } {
  const fromThreads = useThreads((s) => {
    for (const entry of Object.values(s.threads)) {
      const found = entry.requests.find((request) => request.id === id);
      if (found) return found;
    }
    return null;
  });
  const [fetched, setFetched] = useState<NeedsYou | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (fromThreads) return;
    let live = true;
    void listRequests({ state: 'pending', limit: 200 }).then(async (pending) => {
      if (!live) return;
      const found = pending.ok ? pending.data.items.find((request) => request.id === id) : undefined;
      if (found) {
        setFetched(found);
        // keep it live: its conversation's cards follow realtime
        if (found.conversation_id) void useThreads.getState().open(found.conversation_id);
        return;
      }
      setMissing(true);
    });
    return () => {
      live = false;
    };
  }, [id, fromThreads]);
  return { request: fromThreads ?? fetched, missing: !fromThreads && !fetched && missing };
}

export default function RequestSheet() {
  const { id = '' } = useLocalSearchParams<{ id?: string }>();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const me = useAuth((s) => s.user);
  const agents = useWorkspace((s) => s.agents);
  const { request, missing } = useRequest(id);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<CardAction | null>(null);

  const computers = !!me?.modules.computer && !!me?.capabilities.sandbox;
  const body = useMemo(() => (request ? cardBody(request) : null), [request]);
  const actions = request ? cardActions(request, computers) : [];
  const agentName = request?.agent_id ? agents?.find((agent) => agent.id === request.agent_id)?.name : undefined;

  const run = async (action: CardAction) => {
    if (!request || busy) return;
    if (action === 'takeOver' || action === 'signInMyself') {
      if (request.agent_id) {
        router.push({ pathname: '/computer', params: { agent: request.agent_id, request: request.id, control: '1' } });
      }
      return;
    }
    let decision: Decision;
    if (action === 'answer') {
      const checked = checkAnswers(body?.fields ?? [], answers);
      if (!checked.ok) {
        alertError(t('composer.required', { name: checked.missing }));
        return;
      }
      decision = { action: 'answer', answers: checked.answers };
    } else if (action === 'handBack') {
      const ok = await confirmAction({
        title: t('requests.handBackTitle'),
        message: t('requests.handBackHint'),
        confirmLabel: t('requests.handBack'),
      });
      if (!ok) return;
      decision = { action: 'handBack' };
    } else {
      decision = { action };
    }
    setBusy(action);
    const outcome = await decide(request, decision);
    setBusy(null);
    if (outcome === 'done') {
      router.back();
      void softAskAfterDecision();
    }
  };

  if (!request) {
    return (
      <>
        <Stack.Screen options={{ title: t('requests.title') }} />
        <SheetClose />
        {missing ? <EmptyState icon="checkCircle" title={t('requests.gone')} /> : <LoadingState />}
      </>
    );
  }

  const status = requestStatus(request);
  const tone = status.tone === 'warning' ? c.orange : status.tone === 'success' ? c.green : c.secondaryLabel;
  const label = (action: CardAction) => {
    switch (action) {
      case 'approve':
        return request.subject === 'run_start'
          ? t('requests.startRun')
          : request.kind === 'login'
            ? t('requests.allowLogin')
            : request.kind === 'proposal'
              ? t('requests.accept')
              : t('requests.approve');
      case 'reject':
        return request.kind === 'question' ? t('requests.skip') : t('requests.reject');
      case 'answer':
        return t('requests.answer');
      case 'takeOver':
        return t('requests.takeOver');
      case 'signInMyself':
        return t('requests.signInMyself');
      case 'handBack':
        return t('requests.handBack');
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: t('requests.title') }} />
      <SheetClose />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <View style={styles.head}>
          <Icon name={KIND_ICON[request.kind]} size={20} color={request.status === 'pending' ? c.orange : c.secondaryLabel} />
          <Text style={styles.title}>{request.title}</Text>
        </View>
        <View style={styles.metaRow}>
          <View style={[styles.status, { borderColor: tone }]}>
            <Text style={[styles.statusText, { color: tone }]}>{t(`requests.status.${status.word}` as 'requests.status.needsYou')}</Text>
          </View>
          <Text style={styles.meta}>{[agentName, relativeTimeNow(request.created_at)].filter(Boolean).join(' · ')}</Text>
        </View>

        {body?.reason ? <Text style={styles.reason}>{body.reason}</Text> : null}
        {body?.details.length ? (
          <View style={styles.details}>
            {body.details.map((detail) => (
              <View key={detail.label} style={styles.detail}>
                <Text style={styles.detailLabel}>{detailLabel(t, detail.label)}</Text>
                <Text style={styles.detailValue} selectable>
                  {detail.value}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {body?.body ? (
          <View style={styles.block}>
            {body.bodyLabel ? <Text style={styles.blockLabel}>{t(`requests.body.${body.bodyLabel}`)}</Text> : null}
            <Text style={styles.blockText} selectable>
              {body.body}
            </Text>
          </View>
        ) : null}

        {request.kind === 'question' ? (
          <View style={styles.form}>
            {(body?.fields ?? []).map((field) => (
              <Field
                key={field.key}
                field={field}
                value={answers[field.key] ?? ''}
                disabled={request.status !== 'pending'}
                onChange={(value) => setAnswers((current) => ({ ...current, [field.key]: value }))}
              />
            ))}
          </View>
        ) : null}

        {request.status !== 'pending' && request.result ? (
          <Text style={styles.outcome}>{t(`requests.status.${status.word}` as 'requests.status.needsYou')}</Text>
        ) : null}

        {actions.length ? (
          <View style={styles.actions}>
            {actions.map((action, index) => (
              <NativeButton
                key={action}
                label={label(action)}
                variant={index === actions.length - 1 ? 'prominent' : 'tinted'}
                destructive={action === 'reject'}
                loading={busy === action}
                disabled={!!busy && busy !== action}
                fullWidth
                size="large"
                style={styles.button}
                onPress={() => void run(action)}
              />
            ))}
          </View>
        ) : null}
        {request.status === 'pending' && request.conversation_id ? (
          <Text style={styles.scope}>{t('requests.onlyThisOnce')}</Text>
        ) : null}
      </ScrollView>
    </>
  );
}

function detailLabel(t: ReturnType<typeof useT>, label: string): string {
  switch (label) {
    case 'site':
      return t('requests.loginSite');
    case 'item':
      return t('requests.loginItem');
    case 'run':
      return t('requests.runTitle');
    case 'skill':
      return t('requests.skillName');
    default:
      return label;
  }
}

function Field({
  field,
  value,
  disabled,
  onChange,
}: {
  field: QuestionField;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const label = `${field.label}${field.required !== false ? ' *' : ''}`;
  if (field.type === 'choice' && field.options?.length) {
    return (
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <NativeMenu
          items={field.options.map((option) => ({ id: option, title: option, checked: value === option }))}
          onSelect={onChange}
          fill={false}
        >
          <View style={[styles.choice, disabled && styles.disabled]} accessible accessibilityRole="button" accessibilityLabel={label}>
            <Text numberOfLines={1} style={value ? styles.choiceText : styles.placeholder}>
              {value || t('composer.choose')}
            </Text>
            <Icon name="chevUpDown" size={12} color={c.secondaryLabel} />
          </View>
        </NativeMenu>
      </View>
    );
  }
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        multiline
        placeholder={t('requests.answerPlaceholder')}
        placeholderTextColor={c.placeholder}
        style={styles.input}
        accessibilityLabel={label}
      />
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  content: { padding: space.margin, paddingBottom: space.xxxl, gap: space.md },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  title: { flex: 1, ...typo.title3, fontWeight: weight.semibold, color: c.label },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  status: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 1 },
  statusText: { ...typo.caption1, fontWeight: weight.semibold },
  meta: { flex: 1, ...typo.footnote, color: c.secondaryLabel },
  reason: { ...typo.body, color: c.label },
  details: { borderRadius: radius.lg, backgroundColor: c.secondaryGroupedBackground, padding: space.md, gap: space.sm, ...squircle },
  detail: { gap: 2 },
  detailLabel: { ...typo.footnote, color: c.secondaryLabel },
  detailValue: { ...typo.body, color: c.label },
  block: { gap: space.xs },
  blockLabel: { ...typo.footnote, fontWeight: weight.semibold, color: c.secondaryLabel },
  blockText: {
    ...typo.subheadline,
    fontFamily: mono,
    color: c.label,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: c.secondaryGroupedBackground,
    ...squircle,
  },
  form: { gap: space.md },
  field: { gap: space.xs },
  fieldLabel: { ...typo.footnote, fontWeight: weight.semibold, color: c.secondaryLabel },
  input: {
    ...typo.body,
    color: c.label,
    minHeight: HIT,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.md,
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: HIT,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  choiceText: { flex: 1, ...typo.body, color: c.label },
  placeholder: { flex: 1, ...typo.body, color: c.placeholder },
  disabled: { opacity: 0.5 },
  outcome: { ...typo.subheadline, color: c.secondaryLabel },
  actions: { gap: space.sm, marginTop: space.sm },
  button: { alignSelf: 'stretch' },
  scope: { ...typo.footnote, color: c.tertiaryLabel, textAlign: 'center' },
}));
