/**
 * The ask_user form — the agent's clarifying questions as an inline card in
 * the reply (web parity: AskUserCard). Question types: `text` (one line),
 * `textarea`, `single_choice`, `multi_choice`; `required` defaults to true.
 * Options are native-feeling rows: iOS marks a pick with a trailing checkmark
 * (single) or a filled check circle (multi), Android with radio buttons /
 * checkboxes.
 *
 * 提交回答 posts the answers as the next user message in the web's exact
 * format — a header line, then `**1. Label**: answer` per question; a picked
 * option goes out as `Label (value)` unless the value only restates the label,
 * because tools put instructions in values (email_mutation's `send <token>`).
 * The card then settles into a collapsed summary rebuilt from that message —
 * also after a reload, from whatever message followed the reply. Read-only
 * conversations show the questions without a submit.
 */
import { useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useT } from '../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { NativeButton } from '../ui/button';
import { Icon } from '../ui/core';
import { selectionTick } from '../ui/haptics';
import { Inline } from './markdown/inline';

const IOS = Platform.OS === 'ios';

interface QuestionOption {
  value: string;
  label: string;
}

interface Question {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'single_choice' | 'multi_choice';
  options?: QuestionOption[];
  required?: boolean;
  placeholder?: string;
}

export interface AskUserData {
  type: 'ask_user';
  status?: string;
  title?: string;
  description?: string;
  questions: Question[];
}

const TYPES = new Set(['text', 'textarea', 'single_choice', 'multi_choice']);

/** The form shape, from any tool (checked loosely: a model-authored payload). */
export function isAskUserData(v: unknown): v is AskUserData {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    o.type === 'ask_user' &&
    Array.isArray(o.questions) &&
    o.questions.length > 0 &&
    o.questions.every(
      (q) =>
        !!q &&
        typeof q === 'object' &&
        typeof (q as Question).label === 'string' &&
        TYPES.has((q as Question).type) &&
        ((q as Question).options === undefined || Array.isArray((q as Question).options)),
    )
  );
}

type Answers = Record<string, string | string[]>;

const keyOf = (q: Question, i: number) => q.id || `q${i}`;
const isChoice = (q: Question) => q.type === 'single_choice' || q.type === 'multi_choice';

/** A pick as the model reads it (see file header). */
function formatChoice(opt: QuestionOption | undefined, raw: string): string {
  if (!opt) return raw;
  return opt.value.toLowerCase() === opt.label.toLowerCase() ? opt.label : `${opt.label} (${opt.value})`;
}

const NOT_ANSWERED = '(not answered)';

/** The message the answers go out as (web: AskUserCard.handleSubmit). */
function formatAnswers(questions: Question[], answers: Answers): string {
  const lines = ['Here are my answers to your questions:', ''];
  questions.forEach((q, idx) => {
    const a = answers[keyOf(q, idx)];
    let shown: string;
    if (Array.isArray(a)) {
      shown = a.length ? a.map((v) => formatChoice(q.options?.find((o) => o.value === v), v)).join(', ') : NOT_ANSWERED;
    } else if (q.type === 'single_choice') {
      shown = a ? formatChoice(q.options?.find((o) => o.value === a), a) : NOT_ANSWERED;
    } else {
      shown = (a ?? '').trim() || NOT_ANSWERED;
    }
    lines.push(`**${idx + 1}. ${q.label}**: ${shown}`);
  });
  return lines.join('\n');
}

/** Answers read back from a posted message, by question number (picks shown by label). */
function parseAnswers(questions: Question[], message: string | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!message) return out;
  for (const m of message.matchAll(/\*\*(\d+)\.\s+.+?\*\*:\s*(.+?)(?=\n|$)/g)) {
    const n = Number(m[1]);
    let answer = m[2].trim();
    for (const o of questions[n - 1]?.options ?? []) answer = answer.split(`${o.label} (${o.value})`).join(o.label);
    out.set(n, answer);
  }
  return out;
}

export function AskUserCard({
  data,
  followUp,
  onReply,
}: {
  data: AskUserData;
  /** The user message that followed this reply (the form was answered — or passed over). */
  followUp?: string;
  /** Absent in a read-only conversation. */
  onReply?: (text: string) => Promise<boolean>;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { questions } = data;
  const [answers, setAnswers] = useState<Answers>(() =>
    Object.fromEntries(questions.map((q, i) => [keyOf(q, i), q.type === 'multi_choice' ? [] : ''])),
  );
  const [sent, setSent] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const busy = useRef(false);

  const posted = sent ?? followUp;
  const submitted = posted !== undefined && posted !== null;
  const summary = useMemo(() => parseAnswers(questions, posted ?? undefined), [questions, posted]);

  const set = (k: string, v: string | string[]) => setAnswers((a) => ({ ...a, [k]: v }));
  const toggle = (k: string, v: string) =>
    setAnswers((a) => {
      const cur = (a[k] as string[]) ?? [];
      return { ...a, [k]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] };
    });

  const canSubmit = questions.every((q, i) => {
    if (q.required === false) return true;
    const a = answers[keyOf(q, i)];
    return Array.isArray(a) ? a.length > 0 : !!a?.trim();
  });

  const submit = async () => {
    if (!onReply || !canSubmit || submitted || busy.current) return;
    busy.current = true;
    setSending(true);
    const message = formatAnswers(questions, answers);
    const ok = await onReply(message);
    busy.current = false;
    setSending(false);
    if (ok) setSent(message);
  };

  const title = data.title || t('chat.askTitle');

  if (submitted) {
    return (
      <View style={styles.card}>
        <Pressable
          onPress={() => summary.size && setExpanded((e) => !e)}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          style={({ pressed }) => [styles.head, pressed && summary.size ? { opacity: 0.6 } : null]}
        >
          <View style={[styles.tile, styles.tileDone]}>
            <Icon name="checkCircleFill" size={17} color={c.green} />
          </View>
          <View style={styles.headTexts}>
            <Text numberOfLines={2} style={styles.title}>
              {title}
            </Text>
            <Text style={styles.meta}>
              {t('chat.askSubmitted')}
              {summary.size ? ` · ${t('chat.askAnsweredCount', { n: summary.size })}` : ''}
            </Text>
          </View>
          {summary.size ? (
            <Icon name={expanded ? 'chevD' : 'chevR'} size={12} weight="semibold" color={c.tertiaryLabel} />
          ) : null}
        </Pressable>
        {expanded ? (
          <Animated.View entering={FadeIn.duration(160)} style={styles.summary}>
            {questions.map((q, i) => (
              <View key={keyOf(q, i)} style={styles.summaryRow}>
                <Text style={styles.summaryNum}>{i + 1}.</Text>
                <Text style={styles.summaryText} selectable>
                  <Text style={styles.summaryLabel}>{q.label}</Text>
                  {'  '}
                  {summary.get(i + 1) ?? '—'}
                </Text>
              </View>
            ))}
          </Animated.View>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={styles.tile}>
          <Icon name="form" size={17} color={c.accent} />
        </View>
        <View style={styles.headTexts}>
          <Text numberOfLines={2} style={styles.title}>
            {title}
          </Text>
        </View>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{t('chat.askNeedsInput')}</Text>
        </View>
      </View>

      {data.description ? (
        <Text style={styles.description}>
          <Inline text={data.description} />
        </Text>
      ) : null}

      {questions.map((q, i) => {
        const k = keyOf(q, i);
        const a = answers[k];
        return (
          <View key={k} style={styles.question}>
            <Text style={styles.qLabel}>
              <Text style={styles.qNum}>{i + 1}. </Text>
              {q.label}
              {q.required === false ? <Text style={styles.qOptional}> {t('chat.askOptional')}</Text> : null}
            </Text>
            {isChoice(q) ? (
              <View style={styles.group}>
                {(q.options ?? []).map((o, j) => {
                  const on = Array.isArray(a) ? a.includes(o.value) : a === o.value;
                  const multi = q.type === 'multi_choice';
                  return (
                    <Pressable
                      key={`${o.value}-${j}`}
                      disabled={!onReply}
                      onPress={() => {
                        selectionTick();
                        if (multi) toggle(k, o.value);
                        else set(k, o.value);
                      }}
                      accessibilityRole={multi ? 'checkbox' : 'radio'}
                      accessibilityState={{ checked: on, disabled: !onReply }}
                      style={({ pressed }) => [styles.option, j > 0 && styles.optionSep, pressed && { backgroundColor: c.fill }]}
                    >
                      {multi || !IOS ? (
                        <Icon
                          name={multi ? (on ? 'checkboxOn' : 'checkboxOff') : on ? 'radioOn' : 'radioOff'}
                          size={IOS ? 21 : 22}
                          color={on ? c.accent : c.tertiaryLabel}
                        />
                      ) : null}
                      <Text style={[styles.optionText, on && styles.optionTextOn]}>{o.label}</Text>
                      {!multi && IOS && on ? <Icon name="check" size={16} weight="semibold" color={c.accent} /> : null}
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <TextInput
                value={a as string}
                onChangeText={(v) => set(k, v)}
                editable={!!onReply}
                placeholder={q.placeholder || t('chat.askPlaceholder')}
                placeholderTextColor={c.placeholder}
                multiline={q.type === 'textarea'}
                returnKeyType={q.type === 'textarea' ? 'default' : 'done'}
                submitBehavior={q.type === 'textarea' ? 'newline' : 'blurAndSubmit'}
                accessibilityLabel={q.label}
                style={[styles.input, q.type === 'textarea' && styles.textarea]}
              />
            )}
          </View>
        );
      })}

      {onReply ? (
        <View style={styles.footer}>
          <Text style={styles.hint}>{canSubmit ? '' : t('chat.askRequiredHint')}</Text>
          <NativeButton
            label={t('chat.askSubmit')}
            icon="send"
            size="small"
            variant="prominent"
            disabled={!canSubmit}
            loading={sending}
            onPress={() => void submit()}
          />
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  card: {
    padding: space.md + 2,
    gap: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.separator,
    ...squircle,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  tile: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.accentFill,
    ...squircle,
  },
  tileDone: { backgroundColor: c.greenFill },
  headTexts: { flex: 1, minWidth: 0 },
  title: { ...typo.headline, color: c.label },
  meta: { ...typo.footnote, color: c.secondaryLabel, marginTop: 1 },
  badge: { paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.full, backgroundColor: c.accentFill },
  badgeText: { ...typo.caption1, fontWeight: weight.semibold, color: c.accentText },
  description: { ...typo.subheadline, color: c.secondaryLabel, marginTop: -space.xs },

  question: { gap: space.sm },
  qLabel: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
  qNum: { color: c.secondaryLabel },
  qOptional: { fontWeight: weight.regular, color: c.secondaryLabel },
  group: { borderRadius: radius.md, backgroundColor: c.tertiaryFill, overflow: 'hidden', ...squircle },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 44,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  optionSep: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.separator },
  optionText: { flex: 1, ...typo.body, color: c.label },
  optionTextOn: { fontWeight: weight.medium },
  input: {
    ...typo.body,
    color: c.label,
    minHeight: 44,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.md,
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  textarea: { minHeight: 96, textAlignVertical: 'top' },

  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, marginTop: space.xs },
  hint: { flex: 1, ...typo.footnote, color: c.secondaryLabel },

  summary: { gap: space.xs + 2, marginTop: -space.xs },
  summaryRow: { flexDirection: 'row', gap: space.sm },
  summaryNum: { ...typo.footnote, color: c.tertiaryLabel, fontVariant: ['tabular-nums'] },
  summaryText: { flex: 1, ...typo.footnote, color: c.secondaryLabel },
  summaryLabel: { fontWeight: weight.semibold, color: c.label },
}));
