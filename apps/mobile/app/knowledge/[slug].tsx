/**
 * Knowledge doc detail — a pushed page with an inline navigation bar. The
 * document title is set large at the top of the content and slides into the
 * (glass) navigation bar only once it has scrolled under it, like Apple's
 * document views. Below it: the meta line, tags and the Markdown body
 * (src/knowledge/doc-body.tsx, shared with the bottom-sheet peek).
 *
 * Toolbar (right): ✏️ 编辑 (owners / editors → the editor modal) and a `…`
 * menu with 修改历史 (history sheet) and 分享 (system share sheet: title +
 * Markdown); both sub-routes get the slug + the authoritative id. Refetches on
 * every focus so saved edits and restored versions show up on return. Accepts
 * `?id=` (authoritative, from entity links / the peek) and an optional
 * `?title=` to paint the heading while loading (the spinner then sits under
 * it; without a title the spinner is centered). Missing / failed states are
 * centered `EmptyState`s (failed → 重试).
 */

import React, { useCallback, useRef, useState } from 'react';
import { ScrollView, Share, Text, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { canEditDoc, resolveDoc, type DocMiss, type KnowledgeDoc } from '../../src/api/knowledge';
import { DocBody, withoutTitleHeading } from '../../src/knowledge/doc-body';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';

export default function KnowledgeDetail() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const params = useLocalSearchParams<{ slug: string; id?: string; title?: string }>();
  const headerHeight = useHeaderHeight();
  const { bottom: bottomInset } = useSafeAreaInsets();
  const [doc, setDoc] = useState<KnowledgeDoc | DocMiss | null>(null);

  // Refetch on every focus — the editor and version restore both change the
  // doc. A failed refetch keeps what is already on screen; a doc that is gone
  // (deleted / access revoked) switches to the missing state.
  const load = useCallback(() => {
    let alive = true;
    void resolveDoc({ slug: params.slug, id: params.id }).then((d) => {
      if (alive) setDoc((prev) => (d === 'failed' && prev && typeof prev !== 'string' ? prev : d));
    });
    return () => {
      alive = false;
    };
  }, [params.slug, params.id]);
  useFocusEffect(load);

  const retry = useCallback(() => {
    setDoc(null);
    load();
  }, [load]);

  // Nav-bar title appears once the content heading has scrolled under the bar.
  const titleBottom = useRef(0);
  const [navTitle, setNavTitle] = useState(false);
  const navTitleRef = useRef(false);
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const under = e.nativeEvent.contentOffset.y + headerHeight > titleBottom.current;
      if (under !== navTitleRef.current) {
        navTitleRef.current = under;
        setNavTitle(under);
      }
    },
    [headerHeight],
  );

  const loaded = doc !== null && typeof doc !== 'string' ? doc : null;
  const heading = loaded?.title ?? (doc === null && params.title ? String(params.title) : '');
  const editable = !!loaded && canEditDoc(loaded);
  // Nothing but a state to show (no heading yet) → center it in the page: the
  // content grows to the scroll view's frame, minus the bar insets the scroll
  // view adds above and below (else the center lands that much too low).
  const centered = doc === 'missing' || doc === 'failed' || (doc === null && !heading);

  const share = useCallback(() => {
    if (!loaded) return;
    // The body usually opens with the same `# Title` heading — don't repeat it.
    const body = withoutTitleHeading(loaded.content_markdown || loaded.summary || '', loaded.title);
    void Share.share({ title: loaded.title, message: `# ${loaded.title}\n\n${body.trim()}`.trim() }).catch(() => {});
  }, [loaded]);

  return (
    <>
      <Stack.Screen options={{ title: navTitle && loaded ? loaded.title : '' }} />
      {loaded ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon="pencil"
            hidden={!editable}
            accessibilityLabel={t('knowledge.edit')}
            onPress={() =>
              router.push({ pathname: '/knowledge/edit', params: { slug: loaded.slug, id: String(loaded.id) } })
            }
          />
          <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel={t('common.more')}>
            <Stack.Toolbar.MenuAction
              icon="clock.arrow.circlepath"
              onPress={() =>
                router.push({ pathname: '/knowledge/versions', params: { slug: loaded.slug, id: String(loaded.id) } })
              }
            >
              {t('knowledge.history')}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="square.and.arrow.up" onPress={share}>
              {t('knowledge.share')}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[
          styles.content,
          centered && { flexGrow: 1, justifyContent: 'center', paddingBottom: headerHeight + bottomInset },
        ]}
        onScroll={onScroll}
        scrollEventThrottle={16}
      >
        {doc === 'missing' ? (
          <EmptyState icon="book" title={t('knowledge.missing')} message={t('knowledge.missingHint')} />
        ) : doc === 'failed' ? (
          <EmptyState
            icon="alert"
            title={t('knowledge.docFailed')}
            message={t('knowledge.loadFailedHint')}
            onRetry={retry}
          />
        ) : (
          <>
            {heading ? (
              <Text
                style={styles.title}
                accessibilityRole="header"
                onLayout={(e) => {
                  titleBottom.current = e.nativeEvent.layout.y + e.nativeEvent.layout.height;
                }}
              >
                {heading}
              </Text>
            ) : null}
            {loaded ? <DocBody doc={loaded} /> : <LoadingState />}
          </>
        )}
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  content: { paddingHorizontal: space.margin, paddingTop: space.sm, paddingBottom: space.xxxl * 2 },
  title: { ...typo.title1, color: c.label, marginBottom: space.sm },
}));
