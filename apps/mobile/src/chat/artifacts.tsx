/**
 * Body artifacts — tool results that render as cards in the reply itself
 * instead of as rows in its "调用了 N 个工具" sheet. Mirrors the web registry
 * (apps/web/src/components/tool-call/body-artifacts.tsx):
 *
 *  - an ask_user form — any tool may return that shape (email_mutation's
 *    "send this draft?" does) → `AskUserCard` (./ask-user-card), placed
 *    *below* the prose that introduces it, once the reply has finished;
 *  - a file (`{ type: 'file', name, download_url, size?, row_count? }`, the
 *    export tools) → `FileCard` (./file-card); an image file (`content_type`
 *    image/* — a Bot's browser screenshot, a shared picture) shows inline,
 *    fetched with the bearer token (the URL alone would 401), kept in memory
 *    only; tap → the share sheet (its preview, Save Image…), a failed load →
 *    the file card;
 *  - generate_image → the picture (an image-shaped placeholder while it
 *    renders; nothing when the reply's markdown already embeds it — and its
 *    row stays in the tools sheet, it was the slowest step of the turn);
 *  - spawn_session → the child session: a live timer while it runs, then
 *    done / failed and 打开 (switches the conversation to the child).
 *
 * The web's other cards (workflow plan, mission dispatch, schema plan, task
 * capture, eval, extension cards) have no mobile counterpart: those calls
 * stay ordinary rows in the tools sheet, so nothing disappears.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { getAccessToken } from '../api/token-storage';
import { uploadUrl } from '../api/upload';
import { useT } from '../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Icon, Spinner, Touchable } from '../ui/core';
import { AskUserCard, isAskUserData } from './ask-user-card';
import { FileCard, fileDetail, saveFile } from './file-card';
import { Thumb } from './markdown/blocks/images';
import type { ToolStep } from './model';

type Loose = Record<string, unknown>;

/** A tool output as an object (stored pipelines may carry it as a JSON string). */
export function outputOf(step: ToolStep): Loose | undefined {
  let out = step.output;
  if (typeof out === 'string') {
    try {
      out = JSON.parse(out);
    } catch {
      return undefined;
    }
  }
  return out && typeof out === 'object' && !Array.isArray(out) ? (out as Loose) : undefined;
}

const isFile = (out: Loose | undefined) =>
  out?.type === 'file' && typeof out.name === 'string' && typeof out.download_url === 'string';

const isImageFile = (out: Loose | undefined) =>
  typeof out?.content_type === 'string' && out.content_type.startsWith('image/');

export function isArtifact(step: ToolStep): boolean {
  const out = outputOf(step);
  if (isFile(out)) return true;
  if (isAskUserData(out)) return true;
  switch (step.tool) {
    case 'generate_image':
      // output-less = still generating (a placeholder); errors fall back to the row
      return !out || (!!out.success && typeof out.url === 'string');
    case 'spawn_session':
      // a card while in flight and once a child exists; refusals stay rows
      return !out || typeof out.child_session_id === 'string';
    default:
      return false;
  }
}

/** The card restates the whole call, so it leaves the tools sheet (not generate_image). */
export function replacesRow(step: ToolStep): boolean {
  return step.tool !== 'generate_image' && isArtifact(step);
}

/** Cards that sit below the reply's text (the prose leads up to them). */
export function isBelowProse(step: ToolStep): boolean {
  return isAskUserData(outputOf(step));
}

export function ArtifactCards({
  steps,
  text,
  live,
  followUp,
  onReply,
}: {
  steps: ToolStep[];
  /** The reply's markdown (a generated image it already embeds isn't repeated). */
  text: string;
  live: boolean;
  followUp?: string;
  onReply?: (text: string) => Promise<boolean>;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const cards = steps.map((step) => {
    // plain calls (and failed image / refused spawn calls) are rows in the tools sheet, not cards
    if (!isArtifact(step)) return null;
    const out = outputOf(step);
    if (isAskUserData(out)) {
      // interactive: only once the turn is over (its answers go out as the next message)
      return live ? null : <AskUserCard key={step.id} data={out} followUp={followUp} onReply={onReply} />;
    }
    if (isFile(out)) {
      const rows = typeof out!.row_count === 'number' ? (out!.row_count as number) : undefined;
      const card = (
        <FileCard
          key={step.id}
          name={out!.name as string}
          path={out!.download_url as string}
          detail={fileDetail(
            typeof out!.size === 'number' ? (out!.size as number) : undefined,
            rows != null ? t('chat.fileRows', { n: rows }) : undefined,
          )}
        />
      );
      return isImageFile(out) ? (
        <ImageFile key={step.id} name={out!.name as string} path={out!.download_url as string} fallback={card} />
      ) : (
        card
      );
    }
    if (step.tool === 'generate_image') {
      // no result on a finished turn = it never completed (the row says so) — no forever-placeholder
      if (!out) return live ? <ImagePending key={step.id} /> : null;
      const url = out.url as string;
      if (text.includes(url)) return null;
      return <Thumb key={step.id} image={{ alt: String(out.prompt ?? ''), src: url }} single />;
    }
    if (step.tool === 'spawn_session') return <SpawnCard key={step.id} step={step} out={out} live={live} />;
    return null;
  });
  if (!cards.some(Boolean)) return null;
  return <View style={styles.stack}>{cards}</View>;
}

/**
 * An image the server only hands out with the bearer token (`/api/chat-files/…`),
 * inline at reading width. Memory-cached only — a private conversation's
 * pictures never land in the disk cache. Falls back to the file card.
 */
function ImageFile({ name, path, fallback }: { name: string; path: string; fallback: ReactNode }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [ratio, setRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const token = getAccessToken();
  const source = useMemo(
    () => ({ uri: uploadUrl(path), headers: token ? { Authorization: `Bearer ${token}` } : undefined }),
    [path, token],
  );
  if (failed) return fallback;
  return (
    <Touchable
      onPress={() => saveFile(path, name)}
      accessibilityRole="imagebutton"
      accessibilityLabel={name}
      style={[styles.imageFile, { aspectRatio: ratio ?? 4 / 3 }]}
    >
      <Image
        source={source}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        cachePolicy="memory"
        transition={150}
        onLoad={(e) => {
          const { width, height } = e.source;
          if (width > 0 && height > 0) setRatio(Math.max(0.5, Math.min(2.4, width / height)));
        }}
        onError={() => setFailed(true)}
      />
    </Touchable>
  );
}

/** The expensive generation wait itself — an image-shaped placeholder, not an idle transcript. */
function ImagePending() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <View style={styles.imagePending} accessible accessibilityRole="progressbar" accessibilityLabel={t('chat.generatingImage')}>
      <Icon name="image" size={26} color={c.tertiaryLabel} />
      <View style={styles.pendingRow}>
        <Spinner />
        <Text style={styles.pendingText}>{t('chat.generatingImage')}</Text>
      </View>
    </View>
  );
}

/** mm:ss since `from`, ticking every second. */
function Elapsed({ from }: { from: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.floor((now - from) / 1000));
  return <Text style={{ fontVariant: ['tabular-nums'] }}>{`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`}</Text>;
}

function spawnTitle(step: ToolStep, out: Loose | undefined): string | undefined {
  if (typeof out?.title === 'string' && out.title) return out.title;
  let input = step.input;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  const o = input && typeof input === 'object' ? (input as Loose) : undefined;
  return (typeof o?.title === 'string' && o.title) || (typeof o?.prompt === 'string' && o.prompt) || undefined;
}

function SpawnCard({ step, out, live }: { step: ToolStep; out: Loose | undefined; live: boolean }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const [mountedAt] = useState(Date.now);
  const childId = typeof out?.child_session_id === 'string' ? out.child_session_id : undefined;
  const failed = !!out?.error;
  // waiting on the child only while this turn runs (a finished turn without a result never got one)
  const inFlight = !out && live;
  const running = inFlight || out?.status === 'started';
  const title = spawnTitle(step, out) || t('chat.subSession');
  const open = childId
    ? () => router.push({ pathname: '/chat/[id]', params: { id: childId, title } })
    : undefined;

  return (
    <Touchable
      onPress={open}
      disabled={!open}
      style={styles.spawn}
      accessibilityRole={open ? 'button' : undefined}
      accessibilityLabel={title}
    >
      <View style={styles.spawnIcon}>
        {inFlight ? (
          <Spinner />
        ) : failed ? (
          <Icon name="alert" size={17} color={c.red} />
        ) : (
          <Icon name="branch" size={17} color={c.secondaryLabel} />
        )}
      </View>
      <View style={styles.spawnTexts}>
        <Text numberOfLines={1} style={styles.spawnTitle}>
          {title}
        </Text>
        <Text numberOfLines={1} style={[styles.spawnMeta, failed && { color: c.red }]}>
          {t('chat.subSession')} ·{' '}
          {failed ? String(out!.error) : running ? t('chat.subRunning') : out ? t('chat.subDone') : '—'}
          {inFlight ? (
            <>
              {' '}
              <Elapsed from={step.startedAt ?? mountedAt} />
            </>
          ) : null}
        </Text>
      </View>
      {open ? (
        <View style={styles.spawnOpen}>
          <Text style={styles.spawnOpenText}>{t('common.open')}</Text>
          <Icon name="chevR" size={11} weight="semibold" color={c.accent} />
        </View>
      ) : null}
    </Touchable>
  );
}

const useStyles = makeStyles((c) => ({
  stack: { gap: space.sm, marginVertical: space.xs },
  imageFile: {
    width: 260,
    maxWidth: '100%',
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  imagePending: {
    width: 220,
    height: 220,
    maxWidth: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    borderRadius: radius.md,
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  pendingRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  pendingText: { ...typo.footnote, color: c.secondaryLabel },
  spawn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm + 2,
    paddingHorizontal: space.md + 2,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.separator,
    ...squircle,
  },
  spawnIcon: { width: 22, alignItems: 'center' },
  spawnTexts: { flex: 1, minWidth: 0 },
  spawnTitle: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
  spawnMeta: { ...typo.footnote, color: c.secondaryLabel, marginTop: 1 },
  spawnOpen: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  spawnOpenText: { ...typo.subheadline, color: c.accent },
}));
