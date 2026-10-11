/**
 * A record's activity — comments and change history merged (server order:
 * newest first, cursor for older). Shared by the Tables record page and an
 * app's record page (the gateway answers the same `TableRecordActivityPage`,
 * cut to my role's readable ∩ detail fields):
 *
 *  - `useRecordActivity` loads it, pages older items in, posts / deletes
 *    comments (a failed write is a system alert; the thread stays as it was);
 *  - `ActivityList` draws it oldest → newest (the composer sits under the
 *    newest), comments through the shared `CommentRow`, changes as one line
 *    "Ada changed Status, Amount · via a form";
 *  - `useCommentDraft` holds the composer's text, caret and the people picked
 *    from the `@` strip; `encoded()` turns their "@Name" into mention links.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type {
  TableRecordActivityItem,
  TableRecordActivityPage,
  TableRecordActivityViewer,
  TableRecordCommentView,
} from '../shared/tables';
import type { Fetch, Write } from '../api/tables';
import { relativeTime } from '../lib/format';
import { useT } from '../lib/i18n';
import {
  applyMention,
  encodeMentions,
  mentionCandidates,
  mentionQuery,
  mentionsForDisplay,
  personToken,
  type MentionMember,
} from '../lib/mentions';
import { makeStyles, radius, space, squircle, typo, useTheme } from '../theme';
import { CommentRow } from '../ui/comment-thread';
import { alertError, confirmAction } from '../ui/dialogs';
import { EmptyState, LoadingState } from '../ui/empty';
import { menuSections } from '../ui/menu';
import { toast } from '../ui/toast';

export interface ActivitySource {
  load: (cursor?: string | null) => Promise<Fetch<TableRecordActivityPage>>;
  post: (body: string) => Promise<Write<TableRecordCommentView>>;
  remove: (commentId: number) => Promise<Write<null>>;
}

export function useRecordActivity(source: ActivitySource, key: string) {
  const t = useT();
  const [items, setItems] = useState<TableRecordActivityItem[] | null>(null);
  const [viewer, setViewer] = useState<TableRecordActivityViewer | undefined>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const seq = useRef(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const reload = useCallback(() => {
    const mine = ++seq.current;
    void sourceRef.current.load(null).then((result) => {
      if (mine !== seq.current) return;
      if (result.ok) {
        setItems(result.value.items);
        setViewer(result.value.viewer);
        setCursor(result.value.nextCursor);
        setFailed(false);
      } else {
        setItems((prev) => prev ?? []);
        setFailed(true);
      }
    });
  }, []);

  useEffect(() => {
    setItems(null);
    reload();
    const counter = seq;
    return () => {
      counter.current++; // drop a response that lands after the record changed / unmount
    };
  }, [reload, key]);

  const loadOlder = useCallback(async () => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    const result = await sourceRef.current.load(cursor);
    setLoadingOlder(false);
    if (!result.ok) return;
    setItems((prev) => [...(prev ?? []), ...result.value.items]);
    setCursor(result.value.nextCursor);
  }, [cursor, loadingOlder]);

  const send = useCallback(
    async (body: string): Promise<boolean> => {
      const result = await sourceRef.current.post(body);
      if (!result.ok) {
        alertError(t('tables.commentFailed'), result.message || undefined);
        return false;
      }
      setItems((prev) => [result.value, ...(prev ?? [])]);
      return true;
    },
    [t],
  );

  const removeComment = useCallback(
    async (comment: TableRecordCommentView) => {
      const yes = await confirmAction({
        title: t('tables.deleteComment'),
        confirmLabel: t('common.delete'),
        destructive: true,
      });
      if (!yes) return;
      const result = await sourceRef.current.remove(comment.id);
      if (!result.ok) {
        alertError(t('tables.deleteFailed'), result.message || undefined);
        return;
      }
      setItems((prev) => (prev ?? []).filter((item) => !(item.kind === 'comment' && item.id === comment.id)));
    },
    [t],
  );

  return { items, viewer, failed, hasOlder: !!cursor, loadingOlder, loadOlder, reload, send, removeComment };
}

export function ActivityList({
  activity,
  fieldName,
  userName,
  canComment,
}: {
  activity: ReturnType<typeof useRecordActivity>;
  /** A changed field's name (hidden fields never arrive). */
  fieldName: (fieldId: number) => string | undefined;
  userName: (id: string) => string | undefined;
  /** Overrides `viewer.canComment` (an app decides by role). */
  canComment?: boolean;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { items, viewer, failed } = activity;
  const ordered = useMemo(() => [...(items ?? [])].reverse(), [items]);
  const mayModerate = viewer?.canModerate === true;
  const me = viewer?.userId;

  const onCommentMenu = useCallback(
    async (comment: TableRecordCommentView, id: string) => {
      if (id === 'copy') {
        await Clipboard.setStringAsync(mentionsForDisplay(comment.body).replace(/\*\*/g, '')).catch(() => {});
        toast(t('common.copied'), 'copy');
      } else if (id === 'delete') {
        await activity.removeComment(comment);
      }
    },
    [activity, t],
  );

  return (
    <View style={styles.section}>
      <Text style={styles.header} accessibilityRole="header">
        {t('tables.activity')}
      </Text>
      {items === null ? (
        <LoadingState style={styles.loading} />
      ) : items.length === 0 && failed ? (
        <EmptyState icon="comment" title={t('tables.activityFailed')} onRetry={activity.reload} style={styles.failed} />
      ) : items.length === 0 ? (
        <Text style={styles.none}>{t('tables.noActivity')}</Text>
      ) : (
        <View style={styles.card}>
          {activity.hasOlder ? (
            <Pressable
              onPress={() => void activity.loadOlder()}
              accessibilityRole="button"
              style={({ pressed }) => [styles.older, pressed && { opacity: 0.5 }]}
            >
              <Text style={styles.olderText}>{t('tables.olderActivity')}</Text>
            </Pressable>
          ) : null}
          {ordered.map((item, index) => {
            const last = index === ordered.length - 1;
            if (item.kind === 'comment') {
              const mine = !!me && item.authorId === me;
              return (
                <CommentRow
                  key={`c${item.id}`}
                  author={userName(item.authorId) ?? t('tables.someone')}
                  createdAt={item.createdAt}
                  body={item.body}
                  markdown
                  edited={item.edited ? t('tables.edited') : undefined}
                  last={last}
                  items={menuSections([
                    [{ id: 'copy', title: t('tables.copyComment'), icon: 'copy' }],
                    (mine && canComment !== false) || mayModerate
                      ? [{ id: 'delete', title: t('common.delete'), icon: 'trash', destructive: true }]
                      : [],
                  ])}
                  onSelect={(id) => void onCommentMenu(item, id)}
                />
              );
            }
            const names = item.changes.map((change) => fieldName(change.fieldId)).filter(Boolean) as string[];
            const what =
              item.type === 'updated'
                ? t('tables.event.updated', { fields: names.length ? names.join(', ') : t('tables.hiddenFields') })
                : t(`tables.event.${item.type}`);
            const via = t(`tables.via.${item.actorKind}`);
            const actor = item.actorId ? (userName(item.actorId) ?? t('tables.someone')) : t('tables.someone');
            return (
              <View key={`e${item.id}`} style={[styles.event, !last && styles.eventSep]} accessible>
                <Text style={styles.eventText}>
                  <Text style={styles.eventActor}>{actor}</Text> {what}
                  {via ? ` ${via}` : ''}
                </Text>
                <Text style={styles.eventTime}>{relativeTime(item.createdAt)}</Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

/** The comment composer's state: text, caret, and who was picked from the `@` strip. */
export function useCommentDraft(people: readonly MentionMember[]) {
  const [text, setText] = useState('');
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [picked, setPicked] = useState<MentionMember[]>([]);
  const caret = selection && selection.start === selection.end ? selection.start : null;
  const query = caret != null ? mentionQuery(text, caret) : null;
  const candidates = useMemo(() => (query ? mentionCandidates(people, query.query) : []), [people, query]);
  const pick = useCallback(
    (person: MentionMember) => {
      if (caret == null || !query) return;
      const next = applyMention(text, query.start, caret, personToken(person.name));
      setText(next.text);
      setSelection({ start: next.caret, end: next.caret });
      setPicked((prev) => (prev.some((p) => p.id === person.id) ? prev : [...prev, person]));
    },
    [text, caret, query],
  );
  const clear = useCallback(() => {
    setText('');
    setPicked([]);
    setSelection(null);
  }, []);
  return {
    text,
    setText,
    onSelectionChange: setSelection,
    candidates,
    pick,
    clear,
    encoded: () => encodeMentions(text.trim(), picked),
  };
}

const useStyles = makeStyles((c) => ({
  section: { marginHorizontal: space.margin, marginBottom: space.xxl },
  header: {
    ...typo.footnote,
    color: c.secondaryLabel,
    textTransform: 'uppercase',
    paddingHorizontal: space.margin,
    paddingBottom: space.sm - 2,
  },
  card: {
    backgroundColor: c.secondaryGroupedBackground,
    borderRadius: radius.group,
    ...squircle,
    paddingHorizontal: space.margin,
    paddingVertical: space.xs,
    overflow: 'hidden',
  },
  loading: { flexGrow: 0, paddingVertical: space.lg },
  failed: { paddingVertical: space.sm },
  none: { ...typo.subheadline, color: c.tertiaryLabel, paddingHorizontal: space.margin },
  older: { paddingVertical: space.md, alignItems: 'center' },
  olderText: { ...typo.subheadline, color: c.accentText },
  event: { paddingVertical: space.sm + 2, gap: 2 },
  eventSep: { borderBottomWidth: 0.5, borderBottomColor: c.separator },
  eventText: { ...typo.subheadline, color: c.secondaryLabel },
  eventActor: { color: c.label },
  eventTime: { ...typo.caption1, color: c.tertiaryLabel },
}));
