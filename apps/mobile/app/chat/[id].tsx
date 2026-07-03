/**
 * Conversation screen — the centerpiece.
 *
 * Streams the team agent reply (expo/fetch NDJSON), buffering text on a ~40ms
 * flush so a fast token stream doesn't thrash React. Renders the full rich
 * reply (tool pipeline, reasoning, markdown, citation + web sources, metrics),
 * supports long-press message actions, quote-to-ask, a header menu, the source
 * detail sheet, an attach sheet, jump-to-latest, and a read-only bar for shared
 * conversations. The request is abortable; send ⇄ stop mid-stream.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NativeScrollEvent, NativeSyntheticEvent, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as ImagePicker from 'expo-image-picker';
import { handleStreamEvent } from '../../src/shared/greenhouse-types';
import { getSession, deleteSession } from '../../src/api/sessions';
import { streamChat } from '../../src/api/chat';
import { prepareImage, uploadImage } from '../../src/api/upload';
import { Composer, type Annotation, type ComposerImage } from '../../src/chat/composer';
import {
  AiMessage,
  UserMessage,
  fromStored,
  ToolDetail,
  RefDetail,
  type ChatMessage,
  type Source,
  type ToolStep,
  type WebSource,
} from '../../src/chat/message';
import { catLabel } from '../../src/lib/format';
import { useT } from '../../src/lib/i18n';
import { useBottomPadStyle, useCollapsingInsetStyle } from '../../src/lib/keyboard';
import { ActionSheet, type ActionItem, BottomSheetScrollView, Caret, Icon, Sheet, Toast, Touchable } from '../../src/ui';
import { makeStyles, radius, useTheme } from '../../src/theme';

let seq = 0;
const nextId = () => `m${Date.now()}-${seq++}`;

/** A picked image being uploaded (or uploaded) before send. */
interface PendingImage {
  id: string;
  uri: string;
  status: ComposerImage['status'];
  remote?: { id: string; url: string };
}
const hostOf = (url?: string) => (url ? url.replace(/^https?:\/\//, '').split('/')[0] : undefined);

export default function Conversation() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const params = useLocalSearchParams<{ id: string; initial?: string; title?: string; ro?: string }>();
  const sessionId = String(params.id);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const aiActions = useMemo<ActionItem[]>(
    () => [
      { id: 'copy', label: t('chat.actionCopy'), icon: 'copy' },
      { id: 'rich', label: t('chat.actionCopyRich'), icon: 'file' },
      { id: 'translate', label: t('chat.actionTranslate'), icon: 'translate' },
      { id: 'regen', label: t('chat.actionRegenerate'), icon: 'refresh' },
      { id: 'pdf', label: t('chat.actionExportPdf'), icon: 'pdf' },
      { id: 'quote', label: t('chat.actionQuote'), icon: 'quote' },
    ],
    [t],
  );
  const userActions = useMemo<ActionItem[]>(
    () => [
      { id: 'copy', label: t('chat.actionCopy'), icon: 'copy' },
      { id: 'edit', label: t('chat.actionEditResend'), icon: 'pen' },
    ],
    [t],
  );
  const headerActions = useMemo<ActionItem[]>(
    () => [
      { id: 'share', label: t('chat.actionShare'), icon: 'share' },
      { id: 'rename', label: t('chat.actionRename'), icon: 'pen' },
      { id: 'export', label: t('chat.actionExport'), icon: 'download' },
      { id: 'del', label: t('chat.actionDelete'), icon: 'trash', danger: true },
    ],
    [t],
  );

  const rootPad = useBottomPadStyle(0);
  const barInset = useCollapsingInsetStyle(Math.max(insets.bottom, 8));

  const [messages, setMessages] = useState<ChatMessage[]>(() =>
    params.initial ? [{ id: nextId(), role: 'user', text: String(params.initial), status: 'done' }] : [],
  );
  const [title, setTitle] = useState(params.title ? String(params.title) : params.initial ? t('chat.newConversation') : t('chat.conversation'));
  const [titleStreaming, setTitleStreaming] = useState(false);
  const [input, setInput] = useState('');
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [recording] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [source, setSource] = useState<Source | null>(null);
  const [toolSheet, setToolSheet] = useState<ToolStep[] | null>(null);
  const [refSheet, setRefSheet] = useState<{ sources?: Source[]; web?: WebSource[] } | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [menuMsg, setMenuMsg] = useState<ChatMessage | null>(null);
  const [headMenu, setHeadMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const readOnly = params.ro === '1';

  const scrollRef = useRef<ScrollView>(null);
  const followRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const textBufRef = useRef('');
  const reasonBufRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aIdRef = useRef('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  }, []);

  const maybeScroll = useCallback(() => {
    if (followRef.current) scrollRef.current?.scrollToEnd({ animated: false });
  }, []);

  const patchAssistant = useCallback((fn: (m: ChatMessage) => ChatMessage) => {
    setMessages((ms) => ms.map((m) => (m.id === aIdRef.current ? fn(m) : m)));
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      patchAssistant((m) => ({
        ...m,
        text: textBufRef.current,
        reasoning: reasonBufRef.current || m.reasoning,
        status: m.status === 'thinking' ? 'streaming' : m.status,
      }));
      maybeScroll();
    }, 40);
  }, [patchAssistant, maybeScroll]);

  const upsertTool = useCallback(
    (id: string, patch: { tool?: string; input?: unknown; output?: unknown; status?: 'running' | 'done' | 'error'; ms?: number }) => {
      patchAssistant((m) => {
        const tools = [...(m.tools || [])];
        const idx = tools.findIndex((t) => t.id === id);
        if (idx >= 0) tools[idx] = { ...tools[idx], ...patch };
        else tools.push({ id, tool: patch.tool || '工具', status: 'running', ...patch }); // '工具': no i18n key yet
        return { ...m, tools, status: m.status === 'thinking' ? 'streaming' : m.status };
      });
      maybeScroll();
    },
    [patchAssistant, maybeScroll],
  );

  const addSourcesFromResult = useCallback(
    (name: string, output: unknown) => {
      const o = output as any;
      if (o?.slug) {
        const s: Source = { slug: o.slug, title: o.title || o.slug, category: o.category, body: o.content || o.body };
        patchAssistant((m) => {
          const sources = m.sources || [];
          if (sources.some((x) => x.slug === s.slug)) return m;
          return { ...m, sources: [...sources, s] };
        });
      }
      if (name === 'external_search' || name === 'web_search') {
        const arr = Array.isArray(o) ? o : o?.results || o?.sources || [];
        const web = (arr as any[]).filter((it) => it?.title).map((it) => ({ title: it.title, url: it.url || it.link, host: hostOf(it.url || it.link) }));
        if (web.length) patchAssistant((m) => ({ ...m, web: [...(m.web || []), ...web] }));
      }
    },
    [patchAssistant],
  );

  const runStream = useCallback(
    async (userText: string, sendImages?: Array<{ id: string; url: string }>) => {
      const aId = nextId();
      aIdRef.current = aId;
      textBufRef.current = '';
      reasonBufRef.current = '';
      followRef.current = true;
      setMessages((ms) => [...ms, { id: aId, role: 'assistant', text: '', tools: [], status: 'thinking' }]);
      setStreaming(true);
      requestAnimationFrame(maybeScroll);

      const ac = new AbortController();
      abortRef.current = ac;
      try {
        for await (const evt of streamChat({
          sessionId,
          message: userText,
          images: sendImages,
          signal: ac.signal,
        })) {
          handleStreamEvent(evt, {
            onTextDelta: (t) => {
              textBufRef.current += t;
              scheduleFlush();
            },
            onReasoningDelta: (t) => {
              reasonBufRef.current += t;
              scheduleFlush();
            },
            onToolCallStart: (tid, name) => upsertTool(tid, { tool: name, status: 'running' }),
            onToolCall: (name, inp, tid) => upsertTool(tid || name, { tool: name, input: inp, status: 'running' }),
            onToolResult: (tid, name, output) => {
              upsertTool(tid, { tool: name, output, status: 'done' });
              addSourcesFromResult(name, output);
            },
            onTitle: (t) => {
              setTitleStreaming(true);
              setTitle(t);
              setTimeout(() => setTitleStreaming(false), 400);
            },
            onFinish: (_r, usage) => {
              if (usage) patchAssistant((m) => ({ ...m, metrics: { ...m.metrics, tokensIn: usage.inputTokens, tokensOut: usage.outputTokens } }));
            },
            onError: (e) => patchAssistant((m) => ({ ...m, error: e, status: 'done' })),
          });
        }
      } catch (e) {
        if (!ac.signal.aborted) {
          const msg = e instanceof Error ? e.message : t('common.error');
          patchAssistant((m) => ({ ...m, error: msg }));
        }
      } finally {
        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        patchAssistant((m) => ({ ...m, text: textBufRef.current || m.text, reasoning: reasonBufRef.current || m.reasoning, status: 'done' }));
        setStreaming(false);
        abortRef.current = null;
        requestAnimationFrame(maybeScroll);
      }
    },
    [sessionId, scheduleFlush, upsertTool, addSourcesFromResult, patchAssistant, maybeScroll, t],
  );

  // initial fresh send, or load history
  useEffect(() => {
    if (params.initial) {
      runStream(String(params.initial));
      return;
    }
    let alive = true;
    (async () => {
      const data = await getSession(sessionId);
      if (!alive || !data) return;
      if (data.session?.title) setTitle(data.session.title);
      const hist = (data.messages || [])
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map(fromStored);
      setMessages(hist);
      requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = useCallback(() => {
    const text = input.trim();
    const ready = images.filter((im) => im.status === 'done' && im.remote);
    if ((!text && ready.length === 0) || streaming) return;
    if (images.some((im) => im.status === 'uploading')) {
      flash(t('upload.uploading'));
      return;
    }
    const ann = annotations.length ? annotations.map((a) => a.text).join('\n') : null;
    const composed = ann ? `${ann}\n\n${text}` : text;
    const sendImages = ready.map((im) => im.remote!);
    setMessages((ms) => [
      ...ms,
      {
        id: nextId(),
        role: 'user',
        text,
        annotation: ann,
        images: sendImages.length ? sendImages : undefined,
        status: 'done',
      },
    ]);
    setInput('');
    setAnnotations([]);
    setImages([]);
    requestAnimationFrame(maybeScroll);
    runStream(composed, sendImages.length ? sendImages : undefined);
  }, [input, images, streaming, annotations, runStream, maybeScroll, flash, t]);

  // Pick → downscale → upload; the composer thumbnail tracks status.
  const addPickedImages = useCallback(
    async (assets: ImagePicker.ImagePickerAsset[]) => {
      for (const asset of assets) {
        const localId = nextId();
        setImages((arr) => [...arr, { id: localId, uri: asset.uri, status: 'uploading' }]);
        const uri = await prepareImage(asset.uri, asset.width);
        const up = await uploadImage(uri, asset.mimeType || 'image/jpeg');
        setImages((arr) =>
          arr.map((im) =>
            im.id === localId
              ? up
                ? { ...im, status: 'done' as const, remote: { id: up.id, url: up.url } }
                : { ...im, status: 'error' as const }
              : im,
          ),
        );
        if (!up) flash(t('upload.failed'));
      }
    },
    [flash, t],
  );

  const pickFromLibrary = useCallback(async () => {
    setAttachOpen(false);
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: 4,
      quality: 0.9,
    });
    if (!res.canceled) void addPickedImages(res.assets);
  }, [addPickedImages]);

  const takePhoto = useCallback(async () => {
    setAttachOpen(false);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const res = await ImagePicker.launchCameraAsync({ quality: 0.9 });
    if (!res.canceled) void addPickedImages(res.assets);
  }, [addPickedImages]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    patchAssistant((m) => ({ ...m, status: 'done' }));
    setStreaming(false);
  }, [patchAssistant]);

  const regenerate = useCallback(() => {
    if (streaming) return;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (lastUser) runStream(lastUser.text);
  }, [messages, streaming, runStream]);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const near = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 80;
    followRef.current = near;
    setAtBottom(near);
  }, []);

  const onMenuPick = useCallback(
    async (id: string) => {
      const m = menuMsg;
      setMenuMsg(null);
      if (!m) return;
      if (id === 'copy') {
        await Clipboard.setStringAsync(m.text).catch(() => {});
        flash(t('common.copied'));
      } else if (id === 'quote') {
        const snippet = m.text.replace(/\n+/g, ' ').slice(0, 60);
        setAnnotations((a) => [...a, { id: nextId(), text: snippet + (m.text.length > 60 ? '…' : '') }]);
      } else if (id === 'edit') {
        setInput(m.text);
      } else if (id === 'regen') {
        regenerate();
      } else {
        flash(t('common.comingSoon'));
      }
    },
    [menuMsg, flash, regenerate, t],
  );

  const onHeaderPick = useCallback(
    (id: string) => {
      setHeadMenu(false);
      if (id === 'del') {
        deleteSession(sessionId).catch(() => {});
        router.back();
      } else {
        flash(t('common.comingSoon'));
      }
    },
    [sessionId, router, flash, t],
  );

  return (
    <Animated.View style={[styles.root, rootPad]}>
      {/* header */}
      <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
        <Touchable haptic="none" onPress={() => router.back()} style={styles.headerBtn} hitSlop={8}>
          <Icon name="back" size={22} color={c.fg} />
        </Touchable>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Text numberOfLines={1} style={[styles.headerTitle, titleStreaming && { opacity: 0.5 }]}>
              {title}
            </Text>
            {titleStreaming ? <Caret size={14} /> : null}
          </View>
          {readOnly ? <Text style={styles.headerSub}>{t('chat.sharedReadOnly')}</Text> : null}
        </View>
        <Touchable haptic="none" onPress={() => setHeadMenu(true)} style={styles.headerBtn} hitSlop={8}>
          <Icon name="more" size={22} color={c.fg} />
        </Touchable>
      </View>

      {/* messages */}
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: 8, paddingBottom: 12 }}
        onScroll={onScroll}
        scrollEventThrottle={64}
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
      >
        {messages.map((m) =>
          m.role === 'user' ? (
            <UserMessage key={m.id} msg={m} onLongPress={readOnly ? undefined : setMenuMsg} />
          ) : (
            <AiMessage
              key={m.id}
              msg={m}
              onOpenTools={setToolSheet}
              onOpenRefs={setRefSheet}
              onLongPress={readOnly ? undefined : setMenuMsg}
            />
          ),
        )}
      </ScrollView>

      {/* jump to latest */}
      {!atBottom && (
        <View style={styles.jumpWrap} pointerEvents="box-none">
          <Touchable
            onPress={() => {
              followRef.current = true;
              setAtBottom(true);
              scrollRef.current?.scrollToEnd({ animated: true });
            }}
            style={styles.jumpBtn}
          >
            <Text style={styles.jumpText}>{streaming ? t('chat.newContent') : t('chat.jumpLatest')}</Text>
            <Icon name="arrowDown" size={15} color={c.accent} />
          </Touchable>
        </View>
      )}

      {/* composer (full-width flat bar) / read-only bar */}
      {readOnly ? (
        <View style={[styles.readonlyWrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <View style={styles.readonly}>
            <Icon name="share" size={16} color={c.fgMuted} />
            <Text style={styles.readonlyText}>{t('chat.sharedReadOnly')}</Text>
          </View>
        </View>
      ) : (
        <Composer
          barStyle={barInset}
          value={input}
          onChangeText={setInput}
          onSend={send}
          streaming={streaming}
          onStop={stop}
          recording={recording}
          onAttach={() => setAttachOpen(true)}
          onMic={() => flash(t('chat.voiceSoon'))}
          annotations={annotations}
          onClearAnnotation={(id) => setAnnotations((a) => a.filter((x) => x.id !== id))}
          images={images}
          onRemoveImage={(id) => setImages((arr) => arr.filter((im) => im.id !== id))}
        />
      )}

      {/* source detail sheet */}
      <Sheet visible={!!source} onClose={() => setSource(null)} title={t('chat.sourceDetail')} heightPct={62}>
        {source ? (
          <BottomSheetScrollView contentContainerStyle={{ padding: 18, paddingBottom: 32 }}>
            <View style={styles.srcMetaRow}>
              <View style={styles.srcBadge}>
                <Text style={styles.srcBadgeText}>{catLabel(source.category)}</Text>
              </View>
            </View>
            <Text style={styles.srcTitle}>{source.title}</Text>
            <Text style={styles.srcBody}>{source.body || t('chat.sourceEmpty')}</Text>
            <Touchable
              onPress={() => {
                setAnnotations((a) => [...a, { id: nextId(), text: source.title }]);
                setSource(null);
              }}
              style={styles.srcAsk}
            >
              <Icon name="sparkle" size={18} color={c.accentDeep} />
              <Text style={styles.srcAskText}>{t('chat.askAboutSource')}</Text>
            </Touchable>
          </BottomSheetScrollView>
        ) : (
          <View />
        )}
      </Sheet>

      {/* tool-call detail sheet */}
      <Sheet visible={!!toolSheet} onClose={() => setToolSheet(null)} title={t('chat.toolCalls')} heightPct={70}>
        <BottomSheetScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
          {toolSheet ? <ToolDetail steps={toolSheet} /> : <View />}
        </BottomSheetScrollView>
      </Sheet>

      {/* references detail sheet */}
      <Sheet visible={!!refSheet} onClose={() => setRefSheet(null)} title={t('chat.references')} heightPct={62}>
        <BottomSheetScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
          {refSheet ? (
            <RefDetail
              sources={refSheet.sources}
              web={refSheet.web}
              onOpenSource={(s) => {
                // Close the refs sheet, then open the source detail (avoid two
                // bottom-sheet modals transitioning at once).
                setRefSheet(null);
                setTimeout(() => setSource(s), 220);
              }}
            />
          ) : (
            <View />
          )}
        </BottomSheetScrollView>
      </Sheet>

      {/* attach sheet — images only (the upload API rejects other types) */}
      <Sheet visible={attachOpen} onClose={() => setAttachOpen(false)} title={t('chat.attachTitle')} heightPct={30}>
        <View style={{ padding: 16, paddingBottom: 24 }}>
          {([
            { icon: 'camera', label: t('chat.attachCamera'), onPress: takePhoto },
            { icon: 'image', label: t('chat.attachPhotos'), onPress: pickFromLibrary },
          ] as const).map((o, i) => (
            <Touchable
              key={o.label}
              onPress={o.onPress}
              pressedStyle={{ opacity: 0.7 }}
              style={[styles.attachRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.hairline }]}
            >
              <View style={styles.attachIcon}>
                <Icon name={o.icon} size={20} color={c.accentDeep} />
              </View>
              <Text style={styles.attachLabel}>{o.label}</Text>
            </Touchable>
          ))}
        </View>
      </Sheet>

      <ActionSheet
        visible={!!menuMsg}
        onClose={() => setMenuMsg(null)}
        items={menuMsg?.role === 'user' ? userActions : aiActions}
        onPick={onMenuPick}
      />
      <ActionSheet visible={headMenu} onClose={() => setHeadMenu(false)} items={headerActions} onPick={onHeaderPick} />

      {toast ? (
        <View style={styles.toastWrap} pointerEvents="none">
          <Toast message={toast} />
        </View>
      ) : null}
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hairline,
    backgroundColor: c.bg,
  },
  headerBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 16, fontWeight: '700', color: c.fg, maxWidth: 240 },
  headerSub: { fontSize: 11.5, color: c.fgMuted, marginTop: 1 },

  jumpWrap: { position: 'absolute', left: 0, right: 0, bottom: 150, alignItems: 'center' },
  jumpBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: radius.full,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.hairline,
    shadowColor: '#111827',
    shadowOpacity: 0.1,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  jumpText: { fontSize: 13, fontWeight: '600', color: c.fgSecondary },

  readonlyWrap: { paddingHorizontal: 14, paddingTop: 8, backgroundColor: c.bg },
  readonly: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.hairline,
    borderRadius: radius.xl,
  },
  readonlyText: { fontSize: 14, color: c.fgMuted },

  srcMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  srcBadge: { backgroundColor: c.accentTint, paddingVertical: 3, paddingHorizontal: 9, borderRadius: radius.full },
  srcBadgeText: { fontSize: 12.5, fontWeight: '600', color: c.accentDeep },
  srcTitle: { fontSize: 19, fontWeight: '700', color: c.fg, lineHeight: 27, marginBottom: 12 },
  srcBody: { fontSize: 15, lineHeight: 25, color: c.fgSecondary },
  srcAsk: {
    marginTop: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: radius.lg,
    backgroundColor: c.accentTint,
    borderWidth: 1,
    borderColor: c.accentBorder,
  },
  srcAskText: { fontSize: 15, fontWeight: '600', color: c.accentDeep },

  attachRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 15 },
  attachIcon: { width: 38, height: 38, borderRadius: 10, backgroundColor: c.accentTint, alignItems: 'center', justifyContent: 'center' },
  attachLabel: { fontSize: 16, fontWeight: '500', color: c.fg },

  toastWrap: { position: 'absolute', left: 0, right: 0, bottom: 120, alignItems: 'center' },
}));
