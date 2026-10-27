import React from 'react';
import { ScrollView } from 'react-native';
import { KeyboardStickyView } from 'react-native-keyboard-controller';
import { space } from '../theme';
export interface HomeFrameProps {
  greeting: React.ReactNode;
  recent: React.ReactNode;
  composer: React.ReactNode;
  composerHeight: number;
  bottom: number;
  onFiles?: (files: Omit<import('../chat/composer-files').ComposerFile, 'id' | 'status' | 'remote'>[]) => void;
}
export function HomeFrame({ greeting, recent, composer, composerHeight, bottom }: HomeFrameProps) {
  return (
    <>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        contentContainerStyle={{ paddingTop: space.md, paddingBottom: composerHeight + space.xxl }}
      >
        {greeting}
        {recent}
      </ScrollView>
      <KeyboardStickyView offset={{ opened: bottom }} style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
        {composer}
      </KeyboardStickyView>
    </>
  );
}
