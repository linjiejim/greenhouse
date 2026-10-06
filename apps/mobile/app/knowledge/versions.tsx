/**
 * 修改历史 — a doc's version history as a form sheet
 * (`/knowledge/versions?slug=&id=`, detents [0.6, 1] with the native sheet
 * header, declared in app/_layout.tsx; `id` is authoritative when given, like
 * the detail page). ✕ is the shared `SheetClose`.
 *
 * Newest first; each row (src/knowledge/version-row.tsx) shows what that change
 * did and expands to the rendered snapshot. 恢复此版本 is offered to editors on
 * every version but the current one: confirm → restore (non-destructive — the
 * server records the rollback as a new version) → toast → close; the detail
 * page refetches on focus, so it shows the restored content right away. A
 * failed restore is a system alert (`alertError`) — also when the sheet was
 * swiped away while the request was in flight; a successful one still toasts.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  canEditDoc,
  listVersions,
  resolveDoc,
  restoreVersion,
  type DocMiss,
  type KnowledgeDoc,
  type KnowledgeDocVersion,
} from '../../src/api/knowledge';
import { useUserName } from '../../src/knowledge/use-user-names';
import { VersionRow } from '../../src/knowledge/version-row';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, useTheme } from '../../src/theme';
import { alertError, confirmAction } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { SheetClose } from '../../src/ui/sheet-chrome';
import { toast } from '../../src/ui/toast';

export default function KnowledgeVersions() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const { slug, id } = useLocalSearchParams<{ slug: string; id?: string }>();
  const userName = useUserName();

  const [doc, setDoc] = useState<KnowledgeDoc | DocMiss | null>(null);
  const [versions, setVersions] = useState<KnowledgeDocVersion[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  // Rows only render after the fetch, by which time the list has laid out —
  // their context menus get the width up front instead of measuring each row.
  const [listWidth, setListWidth] = useState<number | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const d = await resolveDoc({ slug, id });
    if (!mounted.current) return;
    if (d === 'failed') {
      setFailed(true);
      setVersions([]);
      return;
    }
    setDoc(d);
    if (d === 'missing') return;
    const rows = await listVersions(d.id);
    if (!mounted.current) return;
    setFailed(rows === null);
    setVersions(rows ?? []);
  }, [slug, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const loaded = doc !== null && typeof doc !== 'string' ? doc : null;
  const canRestore = !!loaded && canEditDoc(loaded);

  const restore = useCallback(
    async (v: KnowledgeDocVersion) => {
      if (!loaded || restoring !== null) return;
      const ok = await confirmAction({
        title: t('knowledge.restoreTitle', { n: v.version }),
        message: t('knowledge.restoreHint'),
        confirmLabel: t('knowledge.restore'),
      });
      if (!ok) return;
      setRestoring(v.version);
      const restored = await restoreVersion(loaded.id, v.version);
      // Feedback first, whether or not the sheet is still up: a failure is an
      // alert (the user asked for this), a success a confirmation toast.
      if (restored) toast(t('knowledge.restored', { n: v.version }), 'rotate');
      else alertError(t('knowledge.restoreFailed'));
      if (!mounted.current) return;
      setRestoring(null);
      if (restored) router.back();
    },
    [loaded, restoring, router, t],
  );

  const retry = useCallback(() => {
    setDoc(null);
    setVersions(null);
    setFailed(false);
    void load();
  }, [load]);

  const list = versions ?? [];
  const showRows = doc !== 'missing' && versions !== null && !failed && list.length > 0;
  const empty =
    doc === 'missing' ? (
      <EmptyState icon="book" title={t('knowledge.missing')} message={t('knowledge.missingHint')} />
    ) : versions === null ? (
      <LoadingState />
    ) : failed ? (
      <EmptyState
        icon="alert"
        title={t('knowledge.versionsFailed')}
        message={t('knowledge.loadFailedHint')}
        onRetry={retry}
      />
    ) : (
      <EmptyState icon="clock" title={t('knowledge.noVersions')} message={t('knowledge.noVersionsHint')} />
    );

  return (
    <>
      <Stack.Screen options={{ title: t('knowledge.history') }} />
      <SheetClose />
      <FlatList
        data={list}
        keyExtractor={(v) => String(v.id)}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.content, !showRows && styles.centered]}
        onLayout={(e) => setListWidth(Math.round(e.nativeEvent.layout.width))}
        ListEmptyComponent={empty}
        renderItem={({ item, index }) => (
          <VersionRow
            version={item}
            prev={list[index + 1]}
            isLatest={index === 0}
            author={userName(item.changed_by)}
            expanded={expanded === item.version}
            canRestore={canRestore}
            restoring={restoring === item.version}
            last={index === list.length - 1}
            width={listWidth}
            onToggle={() => setExpanded((cur) => (cur === item.version ? null : item.version))}
            onRestore={() => void restore(item)}
          />
        )}
      />
    </>
  );
}

const useStyles = makeStyles(() => ({
  content: { paddingBottom: space.xxxl },
  centered: { flexGrow: 1, justifyContent: 'center' },
}));
