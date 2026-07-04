/**
 * Chat message rendering: the assistant reply (tool pipeline → reasoning → rich
 * markdown with streaming caret → citation/web sources → metrics) and the user
 * bubble. Plus `fromStored` to hydrate a persisted Message into this shape.
 */

import React, { useState } from 'react';
import { Image, Text, View } from 'react-native';
import type { Message } from '../shared/greenhouse-types';
import { uploadUrl } from '../api/upload';
import { catIcon, toolIcon, toolLabel } from '../lib/format';
import { useT } from '../lib/i18n';
import { font, makeStyles, mono, radius, useTheme } from '../theme';
import { Caret, DisclosureRow, Icon, Spinner, SproutyFace, ThinkingDots, Touchable } from '../ui';
import { Markdown } from './markdown';

/* ----------------------------- types ----------------------------- */
export interface ToolStep {
  id: string;
  tool: string;
  input?: unknown;
  output?: unknown;
  status: 'running' | 'done' | 'error';
  ms?: number;
}
export interface Source {
  slug?: string;
  title: string;
  category?: string;
  body?: string;
}
export interface WebSource {
  title: string;
  host?: string;
  url?: string;
}
export interface Metrics {
  latency?: string;
  tokensIn?: number;
  tokensOut?: number;
  grounded?: number | null;
}
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  images?: { id: string; url?: string }[];
  annotation?: string | null;
  tools?: ToolStep[];
  reasoning?: string | null;
  sources?: Source[];
  web?: WebSource[];
  metrics?: Metrics | null;
  status?: 'thinking' | 'streaming' | 'done' | 'error';
  error?: string;
}

/* ----------------------------- parsing stored history ----------------------------- */
function safeParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
function brief(v: unknown, n = 200): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  return url.replace(/^https?:\/\//, '').split('/')[0];
}
function extractWeb(pipeline: any[]): WebSource[] {
  const out: WebSource[] = [];
  for (const s of pipeline) {
    if (s?.tool === 'external_search' || s?.tool === 'web_search') {
      const r = s.output;
      const arr = Array.isArray(r) ? r : r?.results || r?.sources || [];
      for (const it of arr) {
        const url = it?.url || it?.link;
        if (it?.title) out.push({ title: it.title, url, host: hostOf(url) });
      }
    }
  }
  return out;
}

/** Hydrate a persisted Message row into a renderable ChatMessage. */
export function fromStored(m: Message): ChatMessage {
  if (m.role === 'user') {
    return { id: m.id, role: 'user', text: m.content, images: safeParse(m.images, []), status: 'done' };
  }
  const pipeline = safeParse<any[]>(m.pipeline, []);
  const tools: ToolStep[] = pipeline.map((s, i) => ({
    id: `t${i}`,
    tool: s.tool || s.toolName || '工具',
    input: s.input,
    output: s.output,
    status: 'done',
    ms: s.duration_ms,
  }));
  const refs = safeParse<any[]>(m.references_, []);
  const sources: Source[] = refs.map((r) => ({ slug: r.slug, title: r.title || r.slug || '来源', category: r.category }));
  const web = extractWeb(pipeline);
  return {
    id: m.id,
    role: 'assistant',
    text: m.content,
    tools: tools.length ? tools : undefined,
    reasoning: m.reasoning || undefined,
    sources: sources.length ? sources : undefined,
    web: web.length ? web : undefined,
    status: 'done',
  };
}

/* ----------------------------- Tool pipeline ----------------------------- */
// Completed messages collapse tool calls to a quiet trigger (styled like the
// 思考过程 toggle) that opens the detail in a bottom sheet. While the tools are
// still running we keep an inline progress line so you can watch them execute.
function ToolTrigger({ steps, live, onOpen }: { steps: ToolStep[]; live?: boolean; onOpen?: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const total = steps.length;
  const doneCount = steps.filter((s) => s.status === 'done').length;
  // Only show the inline progress line while the turn is actively streaming.
  // Once the message is finished (done/errored/stopped) always collapse to the
  // tappable trigger — otherwise an aborted run sticks on "正在调用工具 · x/N".
  const running = !!live && (steps.some((s) => s.status === 'running') || doneCount < total);
  if (running) {
    return (
      <View style={[styles.trigRow, { marginBottom: 10 }]}>
        <Spinner size={13} />
        <Text style={styles.trigLabel}>
          正在调用工具 · {doneCount}/{total}
        </Text>
      </View>
    );
  }
  return <DisclosureRow icon="bolt" label={`${t('chat.toolCalls')} · ${total}`} onPress={onOpen} style={{ marginBottom: 10 }} />;
}

/** Tool-call detail — the step rail, rendered inside the bottom sheet. */
export function ToolDetail({ steps }: { steps: ToolStep[] }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View>
      {steps.map((s, i) => (
        <View key={s.id} style={styles.step}>
          <View style={styles.stepRail}>
            <View style={styles.stepIcon}>
              <Icon name={toolIcon(s.tool)} size={14} color={c.fgSecondary} />
            </View>
            {i < steps.length - 1 && <View style={styles.stepLine} />}
          </View>
          <View style={{ flex: 1, minWidth: 0, paddingBottom: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <Text style={styles.stepName}>{toolLabel(s.tool)}</Text>
              {s.ms != null ? <Text style={styles.stepMs}>{s.ms}ms</Text> : null}
            </View>
            {s.input != null ? (
              <Text style={styles.stepInput}>
                <Text style={{ color: c.fgFaint }}>→ </Text>
                {brief(s.input, 400)}
              </Text>
            ) : null}
            {s.output != null ? (
              <Text style={styles.stepOutput}>
                <Text style={{ color: c.accent, fontWeight: '700' }}>✓ </Text>
                {brief(s.output, 400)}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

/* ----------------------------- Reasoning ----------------------------- */
function Reasoning({ text }: { text: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ marginTop: 2, marginBottom: 10 }}>
      <DisclosureRow icon="brain" label={t('chat.reasoning')} open={open} onPress={() => setOpen((o) => !o)} />
      {open && (
        <View style={styles.reasonBody}>
          <Text style={styles.reasonText}>{text}</Text>
        </View>
      )}
    </View>
  );
}

/* ----------------------------- Sources ----------------------------- */
// Quiet trigger (like 思考过程); the source / web chips open in a bottom sheet.
function RefTrigger({ count, onOpen }: { count: number; onOpen?: () => void }) {
  const t = useT();
  if (!count) return null;
  return <DisclosureRow icon="book" label={`${t('chat.references')} · ${count} 条`} onPress={onOpen} style={{ marginTop: 14 }} />;
}

/** Reference detail — source + web chips, rendered inside the bottom sheet. */
export function RefDetail({
  sources,
  web,
  onOpenSource,
}: {
  sources?: Source[];
  web?: WebSource[];
  onOpenSource: (s: Source) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const docCount = sources?.length || 0;
  const webCount = web?.length || 0;
  return (
    <View>
      {docCount > 0 && (
        <View>
          <View style={styles.srcHead}>
            <Icon name="book" size={14} color={c.fgMuted} />
            <Text style={styles.srcHeadText}>来源</Text>
          </View>
          <View style={styles.chipsWrap}>
            {sources!.map((s, i) => (
              <Touchable key={s.slug || i} onPress={() => onOpenSource(s)} style={styles.srcChip} pressedStyle={{ opacity: 0.7 }}>
                <Icon name={catIcon(s.category)} size={13} color={c.accent} />
                <Text numberOfLines={1} style={styles.srcChipText}>
                  {s.title}
                </Text>
              </Touchable>
            ))}
          </View>
        </View>
      )}
      {webCount > 0 && (
        <View style={{ marginTop: docCount > 0 ? 16 : 0 }}>
          <View style={styles.srcHead}>
            <Icon name="globe" size={14} color={c.fgMuted} />
            <Text style={styles.srcHeadText}>联网</Text>
          </View>
          <View style={styles.chipsWrap}>
            {web!.map((w, i) => (
              <View key={i} style={styles.srcChip}>
                <Icon name="globe" size={12} color={c.info} />
                <Text numberOfLines={1} style={styles.srcChipText}>
                  {w.title}
                </Text>
                {w.host ? <Text style={styles.srcHost}>{w.host}</Text> : null}
              </View>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

/* ----------------------------- Metrics ----------------------------- */
// Grounding badge is DORMANT: `grounded` was fed exclusively by the `checker`
// tool, removed 2026-06-18, so it is always null for new messages (stale values
// may linger on older ones). Suppressed outright; kept as dormant infra. Flip to
// re-enable if a future grounding signal repopulates it. See web message.tsx.
const SHOW_GROUNDING_BADGE = false;

function MetricsBar({ m }: { m: Metrics }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ marginTop: 12 }}>
      <Touchable haptic="none" onPress={() => setOpen((o) => !o)} style={styles.metricHead}>
        {m.latency ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Icon name="clock" size={12} color={c.fgFaint} />
            <Text style={styles.metricText}>{m.latency}</Text>
          </View>
        ) : null}
        {SHOW_GROUNDING_BADGE && m.grounded != null ? (
          <Text style={styles.metricText}>· grounded {m.grounded}%</Text>
        ) : null}
        <Icon name={open ? 'chevD' : 'chevR'} size={13} color={c.fgFaint} />
      </Touchable>
      {open && (
        <View style={styles.metricBody}>
          {m.tokensIn != null ? <Text style={styles.metricDetail}>{t('chat.inputTokens')} {m.tokensIn} tok</Text> : null}
          {m.tokensOut != null ? <Text style={styles.metricDetail}>{t('chat.outputTokens')} {m.tokensOut} tok</Text> : null}
        </View>
      )}
    </View>
  );
}

/* ----------------------------- AI message ----------------------------- */
export function AiMessage({
  msg,
  onOpenTools,
  onOpenRefs,
  onLongPress,
}: {
  msg: ChatMessage;
  /** Open the tool-call detail sheet (screen-owned). */
  onOpenTools?: (steps: ToolStep[]) => void;
  /** Open the references detail sheet (screen-owned). */
  onOpenRefs?: (data: { sources?: Source[]; web?: WebSource[] }) => void;
  onLongPress?: (m: ChatMessage) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const streaming = msg.status === 'streaming';
  return (
    <Touchable
      haptic="none"
      pressedStyle={{}}
      onLongPress={onLongPress ? () => onLongPress(msg) : undefined}
      delayLongPress={350}
      style={styles.aiRow}
    >
      {msg.status === 'thinking' ? (
        <View style={{ paddingTop: 4, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <SproutyFace expr="thinking" size={44} />
          <ThinkingDots />
        </View>
      ) : null}

      {msg.tools && msg.tools.length > 0 && msg.status !== 'thinking' ? (
        <ToolTrigger
          steps={msg.tools}
          live={msg.status === 'streaming'}
          onOpen={onOpenTools ? () => onOpenTools(msg.tools!) : undefined}
        />
      ) : null}
      {msg.reasoning && msg.status === 'done' ? <Reasoning text={msg.reasoning} /> : null}

      {msg.status !== 'thinking' && msg.text ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <View style={{ width: '100%' }}>
            <Markdown source={msg.text} />
          </View>
          {streaming ? <Caret /> : null}
        </View>
      ) : null}

      {streaming && !msg.text && msg.tools && msg.tools.length > 0 ? <Caret /> : null}

      {msg.error ? (
        <View style={styles.errorBox}>
          <SproutyFace expr="error" size={40} breathe={false} />
          <Text style={styles.errorText}>{msg.error}</Text>
        </View>
      ) : null}

      {msg.status === 'done' && (msg.sources?.length || msg.web?.length) ? (
        <RefTrigger
          count={(msg.sources?.length || 0) + (msg.web?.length || 0)}
          onOpen={onOpenRefs ? () => onOpenRefs({ sources: msg.sources, web: msg.web }) : undefined}
        />
      ) : null}
      {msg.status === 'done' && msg.metrics ? <MetricsBar m={msg.metrics} /> : null}
    </Touchable>
  );
}

/* ----------------------------- User message ----------------------------- */
export function UserMessage({ msg, onLongPress }: { msg: ChatMessage; onLongPress?: (m: ChatMessage) => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.userRow}>
      <Touchable
        haptic="none"
        pressedStyle={{}}
        onLongPress={onLongPress ? () => onLongPress(msg) : undefined}
        delayLongPress={350}
        style={{ maxWidth: 300 }}
      >
        {msg.images && msg.images.length > 0 ? (
          <View style={styles.userImages}>
            {msg.images.map((im, i) =>
              im.url ? (
                <Image key={i} source={{ uri: uploadUrl(im.url) }} style={styles.userThumb} resizeMode="cover" />
              ) : (
                <View key={i} style={styles.userThumb}>
                  <Icon name="image" size={22} color={c.fgFaint} />
                </View>
              ),
            )}
          </View>
        ) : null}
        {msg.annotation ? (
          <View style={styles.userAnnotation}>
            <Text numberOfLines={2} style={styles.userAnnotationText}>
              {msg.annotation}
            </Text>
          </View>
        ) : null}
        {msg.text ? (
          <View style={styles.userBubble}>
            <Text style={styles.userText}>{msg.text}</Text>
          </View>
        ) : null}
      </Touchable>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  aiRow: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 18 },


  // Quiet trigger row shared by tool-calls + references (mirrors 思考过程).
  trigRow: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  trigLabel: { fontSize: font.small, color: c.fgMuted, fontWeight: '500' },

  step: { flexDirection: 'row', gap: 10, paddingTop: 9 },
  stepRail: { alignItems: 'center' },
  stepIcon: { width: 24, height: 24, borderRadius: 7, backgroundColor: c.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  stepLine: { width: 1.5, flex: 1, minHeight: 14, backgroundColor: c.hairline, marginTop: 4 },
  stepName: { fontSize: font.small, fontWeight: '600', color: c.fg },
  stepMs: { fontSize: font.caption, color: c.fgFaint },
  stepInput: { fontFamily: mono, fontSize: font.caption, color: c.fgMuted, marginTop: 3, backgroundColor: c.surfaceMuted, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8 },
  stepOutput: { fontSize: font.caption, color: c.fgSecondary, marginTop: 4, lineHeight: 18 },

  reasonHead: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  reasonLabel: { fontSize: font.small, color: c.fgMuted, fontWeight: '500' },
  reasonBody: { marginTop: 7, padding: 12, backgroundColor: c.surfaceMuted, borderRadius: radius.md, borderLeftWidth: 2, borderLeftColor: c.hairline },
  reasonText: { fontSize: font.small, lineHeight: 21, color: c.fgMuted },

  srcHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 },
  srcHeadText: { fontSize: font.caption, color: c.fgMuted, fontWeight: '600' },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  srcChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 230,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: c.hairline,
    backgroundColor: c.surface,
  },
  srcChipText: { fontSize: font.caption, color: c.fgSecondary, flexShrink: 1 },
  srcHost: { fontSize: font.caption, color: c.fgFaint },

  metricHead: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start' },
  metricText: { fontSize: font.caption, color: c.fgFaint },
  metricBody: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 6 },
  metricDetail: { fontSize: font.caption, color: c.fgMuted },

  errorBox: {
    marginTop: 8,
    backgroundColor: c.dangerTint,
    borderRadius: radius.sm,
    padding: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  errorText: { flex: 1, color: c.danger, fontSize: font.small },

  userRow: { alignItems: 'flex-end', paddingHorizontal: 16, paddingVertical: 8, paddingLeft: 44 },
  userImages: { flexDirection: 'row', gap: 6, justifyContent: 'flex-end', marginBottom: 6 },
  userThumb: { width: 72, height: 72, borderRadius: 12, backgroundColor: c.surfaceMuted, borderWidth: 1, borderColor: c.hairline, alignItems: 'center', justifyContent: 'center' },
  userAnnotation: { borderLeftWidth: 3, borderLeftColor: c.accentBorder, backgroundColor: c.accentTint, borderTopRightRadius: 8, borderBottomRightRadius: 8, paddingVertical: 6, paddingHorizontal: 10, marginBottom: 6 },
  userAnnotationText: { fontSize: font.caption, color: c.fgMuted },
  userBubble: { backgroundColor: c.accentTint, borderWidth: 1, borderColor: c.accentBorder, borderRadius: 18, borderBottomRightRadius: 6, paddingVertical: 10, paddingHorizontal: 14 },
  userText: { fontSize: font.body, lineHeight: 23, color: c.fg },
}));
