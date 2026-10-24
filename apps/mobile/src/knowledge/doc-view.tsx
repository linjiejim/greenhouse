/**
 * One knowledge document (the `sheet/doc` object sheet), read-only: its saved copy opens at once when the
 * phone has one (offline reading), the server's version replaces it and is saved again
 * (src/store/knowledge.ts); a document that is gone or no longer readable (403 / 404) loses its
 * copy at once — only an unreachable station falls back to it (src/data/recent-docs.ts `docMiss`).
 * Below it, the comments, and a toolbar button to add one.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { addComment, getDoc, listComments } from '../api/knowledge';
import { captureIdentity } from '../data/identity';
import { docMiss, type SavedDoc } from '../data/recent-docs';
import { useT } from '../lib/i18n';
import { relativeTimeNow } from '../lib/time-words';
import { Markdown } from '../markdown';
import type { KbComment, KbDoc } from '../shared/greenhouse-types';
import { forgetDoc, rememberDoc, savedDoc } from '../store/knowledge';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { alertError, promptText } from '../ui/dialogs';
import { EmptyState, LoadingState } from '../ui/empty';
import { notifySuccess } from '../ui/haptics';
import { toast } from '../ui/toast';
import { SheetScreen } from '../ui/screen';

type Shown = Pick<KbDoc, 'id' | 'title' | 'content_markdown' | 'updated_at'>;

/** One document, as an object sheet (app/sheet/doc.tsx). */
export function DocView({ id }: { id: number | null }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [doc, setDoc] = useState<Shown | null>(null);
  const [offline, setOffline] = useState(false);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [comments, setComments] = useState<KbComment[] | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (id == null) return;
    let alive = true;
    const current = captureIdentity();
    // once the station answered, the early saved copy must not come back over its verdict
    let answered = false;
    setFailed(false);
    setMissing(false);
    void savedDoc(id).then((saved: SavedDoc | null) => {
      if (alive && !answered && saved) setDoc((shown) => shown ?? saved.doc);
    });
    void getDoc(id).then(async (result) => {
      if (!alive || !current()) return;
      answered = true;
      if (result.ok) {
        setDoc(result.data.doc);
        setOffline(false);
        void rememberDoc(result.data.doc);
        return;
      }
      const miss = docMiss(result.status);
      if (miss === 'gone') {
        // revoked or deleted: the copy goes and stops showing
        setDoc(null);
        setOffline(false);
        setMissing(true);
        void forgetDoc(id);
        return;
      }
      if (miss === 'unreachable') {
        const saved = await savedDoc(id);
        if (!alive || !current()) return;
        if (saved) {
          setDoc(saved.doc);
          setOffline(true);
        } else setFailed(true);
        return;
      }
      setDoc(null);
      setOffline(false);
      setFailed(true);
    });
    void listComments(id).then((result) => {
      if (alive && current() && result.ok) setComments(result.data.comments);
    });
    return () => {
      alive = false;
    };
  }, [id, attempt]);

  const comment = useCallback(async () => {
    if (id == null) return;
    const text = await promptText({ title: t('knowledge.addComment'), placeholder: t('knowledge.commentPlaceholder') });
    if (!text) return;
    const current = captureIdentity();
    const result = await addComment(id, text.slice(0, 5000));
    if (!current()) return;
    if (!result.ok) {
      alertError(t('knowledge.commentFailed'), result.message || undefined);
      return;
    }
    notifySuccess();
    setComments((list) => [...(list ?? []), result.data.comment]);
    toast(t('knowledge.commentAdded'), 'check');
  }, [id, t]);

  if (id == null || missing) {
    return (
      <View style={styles.root}>
        <SheetScreen title={t('nav.knowledge')} />
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.grow}>
          <EmptyState icon="book" title={t('knowledge.notFound')} style={styles.state} />
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <SheetScreen
        title={doc?.title ?? ''}
        actions={doc && !offline ? [{ icon: 'comment', label: t('knowledge.addComment'), onPress: () => void comment() }] : []}
      />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {!doc ? (
          failed ? (
            <EmptyState
              icon="alert"
              title={t('knowledge.loadFailed')}
              onRetry={() => setAttempt((n) => n + 1)}
              style={styles.state}
            />
          ) : (
            <LoadingState style={styles.state} />
          )
        ) : (
          <>
            {offline ? <Text style={styles.offline}>{t('knowledge.savedCopy')}</Text> : null}
            <Text style={styles.title} accessibilityRole="header" selectable>
              {doc.title}
            </Text>
            <Text style={styles.meta}>{t('knowledge.updated', { when: relativeTimeNow(doc.updated_at) })}</Text>
            <Markdown source={doc.content_markdown} />
            {comments && comments.length ? (
              <View style={styles.comments}>
                <Text style={styles.commentsTitle} accessibilityRole="header">
                  {t('knowledge.comments', { n: comments.length })}
                </Text>
                {comments.map((entry) => (
                  <View key={entry.id} style={styles.comment}>
                    <Text style={styles.commentMeta}>
                      {entry.author_nickname} · {relativeTimeNow(entry.created_at)}
                    </Text>
                    <Markdown source={entry.content} />
                  </View>
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.background },
  grow: { flexGrow: 1 },
  content: { paddingHorizontal: space.margin + space.xs, paddingBottom: space.xxxl * 2 },
  state: { paddingTop: space.xxxl },
  offline: { ...typo.footnote, color: c.secondaryLabel, marginTop: space.md },
  title: { ...typo.title1, color: c.label, marginTop: space.md },
  meta: { ...typo.footnote, color: c.secondaryLabel, marginTop: space.xs, marginBottom: space.md },
  comments: { marginTop: space.xxl, gap: space.md },
  commentsTitle: { ...typo.headline, fontWeight: weight.semibold, color: c.label },
  comment: {
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: c.secondaryBackground,
    ...squircle,
  },
  commentMeta: { ...typo.footnote, color: c.secondaryLabel, marginBottom: space.xs },
}));
