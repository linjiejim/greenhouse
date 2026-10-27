/**
 * One knowledge document (the `sheet/doc` object sheet), read-only: its saved copy opens at once when the
 * phone has one (offline reading), the server's version replaces it and is saved again
 * (src/store/knowledge.ts); a document that is gone or no longer readable (403 / 404) loses its
 * copy at once — only an unreachable station falls back to it (src/data/recent-docs.ts `docMiss`).
 */

import { bodyUnderTitle } from '../data/doc-body';
import React, { useEffect, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { getDoc, getDocBySlug } from '../api/knowledge';
import { captureIdentity } from '../data/identity';
import { docMiss, type SavedDoc } from '../data/recent-docs';
import { useT } from '../lib/i18n';
import { relativeTimeNow } from '../lib/time-words';
import { Markdown } from '../markdown';
import type { KbDoc } from '../shared/greenhouse-types';
import { forgetDoc, rememberDoc, savedDoc } from '../store/knowledge';
import { makeStyles, space, typo, useTheme } from '../theme';
import { EmptyState, LoadingState } from '../ui/empty';
import { SheetScreen } from '../ui/screen';

type Shown = Pick<KbDoc, 'id' | 'title' | 'content_markdown' | 'updated_at'>;

/**
 * One document, as an object sheet (app/sheet/doc.tsx). A link that names the document by slug
 * only (`slug`, no `id`) is looked up first; from then on the sheet works by the real id.
 */
export function DocView({ id: given, slug }: { id: string | null; slug?: string | null }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [doc, setDoc] = useState<Shown | null>(null);
  const [offline, setOffline] = useState(false);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [found, setFound] = useState<string | null>(null);
  const id = given ?? found;

  useEffect(() => {
    if (given != null || !slug) return;
    let alive = true;
    const current = captureIdentity();
    setFailed(false);
    setMissing(false);
    void getDocBySlug(slug).then((result) => {
      if (!alive || !current()) return;
      if (result.ok) {
        setDoc(result.data.doc);
        setFound(String(result.data.doc.id));
      } else if (docMiss(result.status) === 'gone') setMissing(true);
      else setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [given, slug, attempt]);

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
    return () => {
      alive = false;
    };
  }, [id, attempt]);

  if ((id == null && !slug) || missing) {
    return (
      <>
        <SheetScreen title={t('nav.knowledge')} />
        <ScrollView style={styles.root} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.grow}>
          <EmptyState icon="book" title={t('knowledge.notFound')} style={styles.state} />
        </ScrollView>
      </>
    );
  }

  return (
    <>
      <SheetScreen title={doc?.title ?? ''} />
      <ScrollView style={styles.root} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
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
            <Markdown source={bodyUnderTitle(doc.content_markdown, doc.title)} />
          </>
        )}
      </ScrollView>
    </>
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
}));
