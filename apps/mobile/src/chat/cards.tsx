/**
 * The native cards of a reply (rules in ./parts.ts; web parity with
 * apps/web/src/components/tool-call/body-artifacts.tsx):
 *
 *  - `AskUserCard` — the assistant's questions as a small form; the answer is a normal message
 *    in the web's words. Answered (a later message of mine exists) → one quiet line.
 *  - `FileCard` / `AttachmentChip` — a file the reply made / one I attached: type icon, name cut
 *    in the middle, size; opens in Quick Look.
 *  - `GeneratedImage` — a picture a tool drew.
 *  - `TaskCaptureCard`, `SchemaPlanCard` — something to save or apply, once (receipts restore
 *    the outcome; src/api/artifacts.ts).
 *  - `ExtensionCard` — a card an extension's tool returns: its title and summary here, its own
 *    view on the web.
 *  - `ObjectCards` — documents, tasks, projects and files the reply cites or wrote.
 *
 * Content layer: solid colors inside ChatCard frames, never glass.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { applySchemaPlan, getReceipt, saveCapturedTask, type ActionReceipt, type PlanResult } from '../api/artifacts';
import { captureIdentity } from '../data/identity';
import { formatBytes } from '../lib/format';
import { useT } from '../lib/i18n';
import { openLink } from '../lib/links';
import { useOpenObject } from '../shell/open-object';
import { getApiBase } from '../store/stations';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { NativeButton } from '../ui/button';
import { Icon, Spinner, Touchable, type IconName } from '../ui/core';
import { alertError } from '../ui/dialogs';
import { Chip } from '../ui/chip';
import { FileIcon } from '../ui/file-icon';
import { useFontScaleKey } from '../ui/font-scale';
import { notifySuccess, selectionTick } from '../ui/haptics';
import { toast } from '../ui/toast';
import { ChatCard } from './chat-card';
import { askUserAnswer, type AskUser, type CitedObject, type SchemaPlan, type TaskCapture } from './parts';

const absolute = (url: string) => (/^https?:\/\//i.test(url) ? url : `${getApiBase()}${url}`);

/* ----------------------------- ask_user ----------------------------- */

export function AskUserCard({
  ask,
  answered,
  onAnswer,
}: {
  ask: AskUser;
  /** A later message of mine exists: the questions were answered (here or on the web). */
  answered: boolean;
  /** Send the answer as my next message; false when it was not sent. */
  onAnswer?: (text: string) => Promise<boolean>;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [sending, setSending] = useState(false);
  const complete = ask.questions.every((q) => {
    if (!q.required) return true;
    const value = answers[q.id];
    return Array.isArray(value) ? value.length > 0 : !!value?.trim();
  });

  if (answered) {
    return (
      <View style={styles.quietLine}>
        <Icon name="checkCircle" size={14} color={c.secondaryLabel} />
        <Text style={styles.quietText}>{t('cards.answered', { title: ask.title || t('cards.questions') })}</Text>
      </View>
    );
  }

  const choose = (id: string, value: string, multi: boolean) => {
    selectionTick();
    setAnswers((all) => {
      if (!multi) return { ...all, [id]: value };
      const current = Array.isArray(all[id]) ? (all[id] as string[]) : [];
      return { ...all, [id]: current.includes(value) ? current.filter((v) => v !== value) : [...current, value] };
    });
  };

  const submit = async () => {
    if (!onAnswer || sending || !complete) return;
    setSending(true);
    const sent = await onAnswer(askUserAnswer(ask, answers));
    setSending(false);
    if (!sent) alertError(t('cards.answerFailed'));
  };

  return (
    <ChatCard variant="fill" style={styles.card}>
      <View style={styles.head}>
        <Icon name="form" size={15} color={c.accent} />
        <Text style={styles.title}>{ask.title || t('cards.questions')}</Text>
      </View>
      {ask.description ? <Text style={styles.body}>{ask.description}</Text> : null}
      {ask.questions.map((q) => {
        const value = answers[q.id];
        return (
          <View key={q.id} style={styles.question}>
            <Text style={styles.label}>
              {q.label}
              {q.required ? <Text style={{ color: c.red }}> *</Text> : null}
            </Text>
            {q.type === 'single_choice' || q.type === 'multi_choice' ? (
              <View style={styles.options}>
                {(q.options ?? []).map((option) => {
                  const on = Array.isArray(value) ? value.includes(option.value) : value === option.value;
                  return (
                    <Touchable
                      key={option.value}
                      onPress={() => choose(q.id, option.value, q.type === 'multi_choice')}
                      style={[styles.option, on && styles.optionOn]}
                      accessibilityRole={q.type === 'multi_choice' ? 'checkbox' : 'radio'}
                      accessibilityState={{ checked: on }}
                    >
                      {on ? <Icon name="check" size={12} weight="bold" color={c.onAccent} /> : null}
                      <Text style={[styles.optionText, on && { color: c.onAccent }]}>{option.label}</Text>
                    </Touchable>
                  );
                })}
              </View>
            ) : (
              <TextInput
                value={typeof value === 'string' ? value : ''}
                onChangeText={(text) => setAnswers((all) => ({ ...all, [q.id]: text }))}
                placeholder={q.placeholder}
                placeholderTextColor={c.placeholder}
                multiline={q.type === 'textarea'}
                style={[styles.field, q.type === 'textarea' && styles.area]}
                accessibilityLabel={q.label}
              />
            )}
          </View>
        );
      })}
      <View style={styles.actions}>
        <NativeButton label={t('cards.answer')} variant="prominent" loading={sending} disabled={!complete || !onAnswer} onPress={() => void submit()} />
      </View>
    </ChatCard>
  );
}

/* ----------------------------- files ----------------------------- */

export function FileCard({ name, detail, onPress }: { name: string; detail?: string; onPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const fontKey = useFontScaleKey();
  const large = Number(fontKey) >= 1.5;
  return (
    <ChatCard onPress={onPress} accessibilityLabel={detail ? `${name}, ${detail}` : name} style={styles.fileCard}>
      <View style={styles.fileRow}>
        <FileIcon tile name={name} size={18} />
        <View key={fontKey} style={styles.fileTexts}>
          <Text numberOfLines={large ? 0 : 1} ellipsizeMode="middle" style={styles.fileName}>
            {name}
          </Text>
          {detail ? <Text style={styles.fileDetail}>{detail}</Text> : null}
        </View>
        <Icon name="chevR" size={14} weight="semibold" color={c.tertiaryLabel} />
      </View>
    </ChatCard>
  );
}

/** A file attached to a message of mine: a light capsule, same tap. */
export function AttachmentChip({ name, size, onPress }: { name: string; size?: number; onPress: () => void }) {
  return <Chip icon={<FileIcon name={name} size={13} />} label={name} tail={size != null ? formatBytes(size) : undefined} onPress={onPress} />;
}

/** A row of attached files under a message, scrolling sideways when they do not fit. */
export function AttachmentRow({ files, align }: { files: { id: string; name: string; size?: number }[]; align: 'start' | 'end' }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const openObject = useOpenObject();
  if (!files.length) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.attachRow}
      contentContainerStyle={[styles.attachInner, { justifyContent: align === 'end' ? 'flex-end' : 'flex-start', flexGrow: 1 }]}
    >
      {files.map((file) => (
        <AttachmentChip
          key={file.id}
          name={file.name}
          size={file.size}
          onPress={() => openObject({ kind: 'attachment', path: `/api/chat-files/${encodeURIComponent(file.id)}/content`, name: file.name })}
        />
      ))}
    </ScrollView>
  );
}

/** Pictures sent with a message (public by id, like the web). */
export function MessageImages({ images, align }: { images: { id: string; url: string }[]; align: 'start' | 'end' }) {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  if (!images.length) return null;
  return (
    <View style={[styles.images, { justifyContent: align === 'end' ? 'flex-end' : 'flex-start' }]}>
      {images.map((image) => (
        <Touchable
          key={image.id}
          onPress={() => void openLink(absolute(image.url), hex.accent)}
          accessibilityRole="imagebutton"
          accessibilityLabel={t('markdown.image')}
        >
          <Image source={{ uri: absolute(image.url) }} style={[styles.thumb, images.length === 1 && styles.thumbSingle]} contentFit="cover" transition={150} />
        </Touchable>
      ))}
    </View>
  );
}

export function GeneratedImage({ url, prompt }: { url: string; prompt?: string }) {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <Touchable onPress={() => void openLink(absolute(url), hex.accent)} accessibilityRole="imagebutton" accessibilityLabel={prompt || t('markdown.image')}>
      <Image source={{ uri: absolute(url) }} style={styles.generated} contentFit="cover" transition={200} />
    </Touchable>
  );
}

/* ----------------------------- save / apply once ----------------------------- */

function useReceipt(actionKey: string) {
  const [receipt, setReceipt] = useState<ActionReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    const current = captureIdentity();
    const result = await getReceipt(actionKey);
    if (!current()) return;
    setReceipt(result.ok ? result.data.receipt : null);
    setLoading(false);
  }, [actionKey]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { receipt, loading, refresh };
}

function OnceCard({
  icon,
  title,
  meta,
  children,
  state,
  doneLabel,
  actionLabel,
  onAction,
  error,
}: {
  icon: IconName;
  title: string;
  meta?: string;
  children?: React.ReactNode;
  state: 'loading' | 'ready' | 'working' | 'done' | 'failed';
  doneLabel: string;
  actionLabel: string;
  onAction?: () => void;
  error?: string | null;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <ChatCard variant={state === 'done' ? 'outline' : 'fill'} style={styles.card}>
      <View style={styles.head}>
        <Icon name={state === 'done' ? 'checkCircleFill' : icon} size={15} color={state === 'done' ? c.green : c.accent} />
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
      </View>
      {meta ? <Text style={styles.body}>{meta}</Text> : null}
      {state !== 'done' ? children : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        {state === 'loading' ? (
          <Spinner />
        ) : state === 'done' ? (
          <Text style={styles.doneText}>{doneLabel}</Text>
        ) : (
          <NativeButton label={actionLabel} variant="prominent" loading={state === 'working'} disabled={!onAction} onPress={() => onAction?.()} />
        )}
      </View>
    </ChatCard>
  );
}

export function TaskCaptureCard({ capture, actionKey, sessionId }: { capture: TaskCapture; actionKey: string; sessionId: string | null }) {
  const t = useT();
  const { receipt, loading, refresh } = useReceipt(actionKey);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!sessionId || saving) return;
    setSaving(true);
    const current = captureIdentity();
    const result = await saveCapturedTask(capture, actionKey, sessionId);
    if (!current()) return;
    setSaving(false);
    if (!result.ok) {
      alertError(t('cards.saveFailed'), result.message || undefined);
      return;
    }
    notifySuccess();
    toast(t('cards.taskSaved'), 'check');
    void refresh();
  };
  const state = loading ? 'loading' : saving || receipt?.status === 'processing' ? 'working' : receipt?.status === 'succeeded' ? 'done' : 'ready';
  return (
    <OnceCard
      icon="pin"
      title={t('cards.taskTitle')}
      meta={capture.title}
      state={state}
      doneLabel={t('cards.taskSaved')}
      actionLabel={t('cards.taskSave')}
      onAction={sessionId ? () => void save() : undefined}
      error={receipt?.status === 'failed' ? receipt.error : null}
    />
  );
}

const opName = (op: Record<string, unknown>): string => {
  const name = typeof op.name === 'string' ? op.name : '';
  const field = op.field && typeof op.field === 'object' ? (op.field as Record<string, unknown>).name : undefined;
  return name || (typeof field === 'string' ? field : '');
};

export function SchemaPlanCard({ plan, actionKey, sessionId }: { plan: SchemaPlan; actionKey: string; sessionId: string | null }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { receipt, loading, refresh } = useReceipt(actionKey);
  const [applying, setApplying] = useState(false);
  const outcome = receipt?.status === 'succeeded' ? (receipt.result as PlanResult | null) : null;
  const apply = async () => {
    if (!sessionId || applying) return;
    setApplying(true);
    const current = captureIdentity();
    const result = await applySchemaPlan(plan, actionKey, sessionId);
    if (!current()) return;
    setApplying(false);
    if (!result.ok) {
      alertError(t('cards.applyFailed'), result.message || undefined);
      return;
    }
    notifySuccess();
    void refresh();
  };
  const failed = outcome?.results?.filter((entry) => entry.status !== 'applied').length ?? 0;
  const state = loading ? 'loading' : applying || receipt?.status === 'processing' ? 'working' : outcome ? 'done' : 'ready';
  return (
    <OnceCard
      icon="table"
      title={t('cards.planTitle')}
      meta={plan.summary}
      state={state}
      doneLabel={failed ? t('cards.planPartly', { n: failed }) : t('cards.planApplied')}
      actionLabel={t('cards.planApply')}
      onAction={sessionId ? () => void apply() : undefined}
      error={receipt?.status === 'failed' ? receipt.error : null}
    >
      <View style={styles.ops}>
        {plan.operations.slice(0, 8).map((raw, index) => {
          const op = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
          return (
            <Text key={index} style={styles.op} numberOfLines={1}>
              {`· ${String(op.op ?? '')} ${opName(op)}`}
            </Text>
          );
        })}
        {plan.operations.length > 8 ? <Text style={styles.op}>{t('cards.planMore', { n: plan.operations.length - 8 })}</Text> : null}
      </View>
    </OnceCard>
  );
}

/* ----------------------------- extensions, objects, tools ----------------------------- */

export function ExtensionCard({ title, summary, url }: { title: string; summary?: string; url?: string }) {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <ChatCard
      onPress={url ? () => void openLink(absolute(url), hex.accent) : undefined}
      accessibilityLabel={title}
      style={styles.card}
    >
      <View style={styles.head}>
        <Icon name="wand" size={15} color={c.accent} />
        <Text style={styles.title} numberOfLines={2}>
          {title}
        </Text>
        {url ? <Icon name="open" size={13} color={c.tertiaryLabel} /> : null}
      </View>
      {summary ? <Text style={styles.body}>{summary}</Text> : null}
      {url ? <Text style={styles.quietText}>{t('cards.openOnWeb')}</Text> : null}
    </ChatCard>
  );
}

const OBJECT_ICON: Record<CitedObject['type'], IconName> = { doc: 'file', task: 'checkCircle', project: 'checklist', file: 'fileOther' };

export function ObjectCards({ objects }: { objects: CitedObject[] }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const openObject = useOpenObject();
  if (!objects.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.objects} style={styles.objectsRow}>
      {objects.map((object) => (
        <Chip
          key={`${object.type}-${object.id}`}
          tone="accent"
          icon={object.type === 'file' ? <FileIcon name={object.title} size={14} /> : <Icon name={OBJECT_ICON[object.type]} size={14} color={c.accentText} />}
          label={object.title}
          onPress={() =>
            object.type === 'task' && object.projectId
              ? openObject({ kind: 'task', projectId: object.projectId, id: object.id })
              : object.type === 'project'
                ? openObject({ kind: 'project', id: object.id })
                : object.type === 'file'
                  ? openObject({ kind: 'file', id: object.id, name: object.title })
                  : openObject({ kind: 'doc', id: object.id })
          }
        />
      ))}
    </ScrollView>
  );
}

const useStyles = makeStyles((c) => ({
  card: { gap: space.sm, marginVertical: space.xs, padding: space.lg },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  title: { ...typo.headline, color: c.label, flex: 1 },
  body: { ...typo.subheadline, color: c.secondaryLabel },
  error: { ...typo.footnote, color: c.red },
  question: { gap: space.xs },
  label: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  option: {
    minHeight: HIT - space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.full,
    backgroundColor: c.tertiaryFill,
  },
  optionOn: { backgroundColor: c.accent },
  optionText: { ...typo.subheadline, color: c.label },
  field: {
    ...typo.body,
    color: c.label,
    minHeight: HIT,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  area: { minHeight: HIT * 2, textAlignVertical: 'top' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  doneText: { ...typo.subheadline, fontWeight: weight.semibold, color: c.green },
  quietLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs, paddingVertical: space.xs },
  quietText: { ...typo.footnote, color: c.secondaryLabel },
  fileCard: { marginVertical: space.xs, padding: space.md },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  fileTexts: { flex: 1, minWidth: 0 },
  fileName: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
  fileDetail: { ...typo.footnote, color: c.secondaryLabel, marginTop: space.xxs },
  attachRow: { marginTop: space.xs, flexGrow: 0 },
  attachInner: { gap: space.sm },
  images: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs },
  thumb: { width: 96, height: 96, borderRadius: radius.md, backgroundColor: c.tertiaryFill, ...squircle },
  thumbSingle: { width: 200, height: 150 },
  generated: { width: '100%', aspectRatio: 1, borderRadius: radius.lg, marginVertical: space.sm, backgroundColor: c.tertiaryFill, ...squircle },
  ops: { gap: space.xxs },
  op: { ...typo.footnote, color: c.label },
  objectsRow: { flexGrow: 0, marginTop: space.sm },
  objects: { gap: space.sm },
}));
