/**
 * Reasoning peek (form sheet, native header) — the model's thinking behind a
 * reply, opened from its 思考过程 row (or, while the model is still thinking,
 * the thinking Sprouty / 思考中 row). It follows the turn live (`?id=`,
 * src/chat/live-turn.ts): text keeps arriving, the view stays on the newest
 * lines unless the reader scrolls up, and a 思考中… line closes it until the
 * answer starts. Rendered as markdown (reasoning summaries use bold headings
 * and lists). An unknown id renders the "no longer available" state.
 */

import React, { useRef } from 'react';
import { ScrollView, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useLiveTurn } from '../../src/chat/live-turn';
import { Markdown } from '../../src/chat/markdown';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
import { Spinner } from '../../src/ui/core';
import { EmptyState } from '../../src/ui/empty';
import { SheetClose } from '../../src/ui/sheet-chrome';

/** Within this distance of the end the view keeps following new text. */
const FOLLOW_SLOP = 48;

export default function ReasoningPeek() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const turn = useLiveTurn(id);
  const active = !!turn && turn.status !== 'done' && !turn.text;
  const scrollRef = useRef<ScrollView>(null);
  const follow = useRef(true);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement, contentInset } = e.nativeEvent;
    const bottom = contentOffset.y + layoutMeasurement.height - (contentInset?.bottom ?? 0);
    follow.current = bottom >= contentSize.height - FOLLOW_SLOP;
  };

  return (
    <>
      <Stack.Screen options={{ title: t('chat.reasoning') }} />
      <SheetClose />
      <ScrollView
        ref={scrollRef}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        onScroll={onScroll}
        scrollEventThrottle={32}
        onContentSizeChange={() => {
          if (active && follow.current) scrollRef.current?.scrollToEnd({ animated: true });
        }}
      >
        {turn?.reasoning ? (
          <>
            <Markdown source={turn.reasoning} />
            {active ? (
              <View style={styles.live}>
                <Spinner />
                <Text style={styles.liveText}>{t('chat.thinking')}</Text>
              </View>
            ) : null}
          </>
        ) : (
          <EmptyState icon="brain" title={t('chat.expired')} message={t('chat.expiredHint')} />
        )}
      </ScrollView>
    </>
  );
}

const useStyles = makeStyles((c) => ({
  content: { paddingHorizontal: space.margin + 4, paddingTop: space.sm, paddingBottom: space.xxxl },
  live: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md },
  liveText: { ...typo.subheadline, color: c.secondaryLabel },
}));
