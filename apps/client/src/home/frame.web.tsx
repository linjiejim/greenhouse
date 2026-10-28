import React from 'react';
import { ConversationDrop } from '../chat/file-drop';
import { ScrollView, View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { NativeButton } from '../ui/button';
import { useT } from '../lib/i18n';
import { space, useTheme } from '../theme';
import type { HomeFrameProps } from './frame';
import { WIDE_MIN } from '../shell/wide-model';
export function HomeFrame({ greeting, recent, composer, composerHeight, onFiles }: HomeFrameProps) {
  const { width, height } = useWindowDimensions();
  const wide = width >= WIDE_MIN;
  const { hex: c } = useTheme();
  const t = useT();
  const router = useRouter();
  const chips = ['writeWeekly', 'checkData', 'makeReport', 'organizeFiles'] as const;
  return (
    <ConversationDrop onFiles={onFiles}>
      <ScrollView
        style={{ backgroundColor: wide ? c.background : c.tertiaryGroupedBackground }}
        contentContainerStyle={{
          paddingTop: wide ? Math.max(40, Math.min(96, (height - 620) / 2)) : space.lg,
          paddingBottom: wide ? space.xxxl : composerHeight + space.xxl,
        }}
      >
        <View style={{ width: '100%', maxWidth: 720, alignSelf: 'center' }}>
          {greeting}
          {wide ? (
            <>
              <View style={{ marginTop: space.xxl }}>{composer}</View>
              <View
                style={{ flexDirection: 'row', gap: space.sm, marginHorizontal: space.margin, marginTop: space.md }}
              >
                {chips.map((chip, i) => (
                  <NativeButton
                    key={chip}
                    style={{ borderRadius: 20 }}
                    label={t(`client.${chip}`)}
                    icon={(['pen', 'bar', 'slides', 'folder'] as const)[i]}
                    onPress={() => router.push({ pathname: '/chat', params: { draft: t(`client.${chip}`) } })}
                  />
                ))}
              </View>
            </>
          ) : null}
          {recent}
        </View>
      </ScrollView>
      {!wide ? <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>{composer}</View> : null}
    </ConversationDrop>
  );
}
