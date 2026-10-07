/**
 * Doc peek — the web's knowledge "entity peek" drawer as a bottom sheet
 * (`/peek/doc/<slug>?id=<id>`, detents [0.6, 1] with the native sheet header,
 * declared in app/_layout.tsx). Opened from chat entity links
 * (`#/knowledge/doc/<id>-<slug>` → pass both; the id is authoritative), from
 * the knowledge list's 预览 context action and from a source peek.
 *
 * Header: the doc title, ✕ close on the left (`SheetClose`), ↗ 打开 on the
 * right (`useLeaveSheetTo`: dismisses the sheet, then pushes the full page
 * onto the root stack with slug + id + title, so the page paints its heading
 * at once). Content: the shared meta line + tags + Markdown body
 * (src/knowledge/doc-body.tsx); a failed load offers 重试, a missing /
 * inaccessible doc says so.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { resolveDoc, type DocMiss, type KnowledgeDoc } from '../../../src/api/knowledge';
import { DocBody } from '../../../src/knowledge/doc-body';
import { useT } from '../../../src/lib/i18n';
import { makeStyles, space, useTheme } from '../../../src/theme';
import { EmptyState, LoadingState } from '../../../src/ui/empty';
import { SheetClose, useLeaveSheetTo } from '../../../src/ui/sheet-chrome';
import { toolbarIcon } from '../../../src/ui/toolbar-icon';

export default function DocPeek() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const leaveTo = useLeaveSheetTo();
  const { slug, id } = useLocalSearchParams<{ slug: string; id?: string }>();
  const [doc, setDoc] = useState<KnowledgeDoc | DocMiss | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    void resolveDoc({ slug, id }).then((d) => {
      if (alive) setDoc(d);
    });
    return () => {
      alive = false;
    };
  }, [slug, id, attempt]);

  const loaded = doc !== null && typeof doc !== 'string' ? doc : null;

  const retry = useCallback(() => {
    setDoc(null);
    setAttempt((n) => n + 1);
  }, []);

  const openFull = () => {
    if (!loaded) return;
    leaveTo({
      pathname: '/knowledge/[slug]',
      params: { slug: loaded.slug, id: String(loaded.id), title: loaded.title },
    });
  };

  return (
    <>
      <Stack.Screen options={{ title: loaded?.title ?? '' }} />
      <SheetClose />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={toolbarIcon('open')}
          accessibilityLabel={t('common.open')}
          disabled={!loaded}
          onPress={openFull}
        />
      </Stack.Toolbar>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.content, !loaded && styles.centered]}
      >
        {doc === null ? (
          <LoadingState />
        ) : doc === 'missing' ? (
          <EmptyState icon="book" title={t('knowledge.missing')} message={t('knowledge.missingHint')} />
        ) : doc === 'failed' ? (
          <EmptyState
            icon="alert"
            title={t('knowledge.docFailed')}
            message={t('knowledge.loadFailedHint')}
            onRetry={retry}
          />
        ) : (
          <DocBody doc={doc} />
        )}
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles(() => ({
  content: { paddingHorizontal: space.margin, paddingTop: space.sm, paddingBottom: space.xxxl },
  centered: { flexGrow: 1, justifyContent: 'center' },
}));
