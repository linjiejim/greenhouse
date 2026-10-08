import { brandFont as font } from '../ui/brand-font';
/**
 * MessageMenu — the long-press context menu of an assistant reply, with a
 * *bounded* lifted preview.
 *
 * A reply is a full-width, often screen-tall block. The plain `NativeMenu`
 * (src/ui/menu.tsx) lifts the whole trigger as the preview, so iOS shrinks a
 * long answer into an unreadable sliver and pins the menu over the nav bar.
 * Messages / ChatGPT lift a bounded card instead — so does this: a SwiftUI
 * `ContextMenu` whose `Preview` slot is a plain-text excerpt of the reply
 * (≈10 lines, reading width), with the menu under it.
 *
 * The trigger is pinned to the given width up front (the conversation is
 * full-width), so the subtree mounts once — no measure-then-reparent.
 *
 * Kept separate from `NativeMenu` on purpose: that one is the community
 * `MenuView` (UIKit context menu, the lifted preview is always the trigger
 * itself); a custom preview needs SwiftUI's `ContextMenu.Preview`.
 * iOS only (SwiftUI); elsewhere it falls back to `NativeMenu`.
 */

import React, { useMemo } from 'react';
import { Platform, View, useWindowDimensions } from 'react-native';
import { Button, ContextMenu, Host, RNHostView, Section, Text, VStack } from '@expo/ui/swift-ui';
import { frame, lineLimit, padding } from '@expo/ui/swift-ui/modifiers';
import { useTheme } from '../theme';
import { sfSymbol } from '../ui/core';
import { NativeMenu, type MenuItem } from '../ui/menu';
import { useLocaleEnv } from '../ui/native-form';
import { plainText } from './model';

/** Lines of the excerpt shown in the lifted preview. */
const PREVIEW_LINES = 10;
/** Characters fed to the preview — comfortably more than PREVIEW_LINES can show. */
const PREVIEW_CHARS = 900;

function renderItem(item: MenuItem, onSelect: (id: string) => void): React.ReactNode {
  if (item.children?.length) {
    const children = item.children.map((c) => renderItem(c, onSelect));
    return item.inline ? (
      <Section key={item.id} title={item.title}>
        {children}
      </Section>
    ) : null;
  }
  return (
    <Button
      key={item.id}
      label={item.title}
      systemImage={item.icon ? sfSymbol(item.icon) : undefined}
      role={item.destructive ? 'destructive' : undefined}
      onPress={() => onSelect(item.id)}
    />
  );
}

export function MessageMenu({
  items,
  onSelect,
  text,
  width: widthProp,
  children,
}: {
  items: MenuItem[];
  onSelect: (id: string) => void;
  /** The reply's markdown — its plain-text excerpt becomes the lifted preview. */
  text: string;
  /** Trigger width (defaults to the window width — conversation rows are full-bleed). */
  width?: number;
  children: React.ReactNode;
}) {
  const { width: windowW } = useWindowDimensions();
  const { isDark } = useTheme();
  const locale = useLocaleEnv();
  const width = widthProp ?? windowW;
  const excerpt = useMemo(() => {
    const plain = plainText(text);
    return plain.length > PREVIEW_CHARS ? `${plain.slice(0, PREVIEW_CHARS)}…` : plain;
  }, [text]);

  if (Platform.OS !== 'ios') {
    return (
      <NativeMenu trigger="longPress" items={items} onSelect={onSelect} width={width}>
        {children}
      </NativeMenu>
    );
  }

  const previewW = Math.min(windowW - 32, 420);
  return (
    <Host matchContents ignoreSafeArea="all" colorScheme={isDark ? 'dark' : 'light'} modifiers={[locale]}>
      <ContextMenu>
        <ContextMenu.Trigger>
          <RNHostView matchContents>
            <View style={{ width }}>{children}</View>
          </RNHostView>
        </ContextMenu.Trigger>
        <ContextMenu.Preview>
          <VStack
            alignment="leading"
            modifiers={[padding({ horizontal: 18, vertical: 16 }), frame({ width: previewW, alignment: 'leading' })]}
          >
            <Text modifiers={[font({ textStyle: 'body' }), lineLimit(PREVIEW_LINES)]}>{excerpt}</Text>
          </VStack>
        </ContextMenu.Preview>
        <ContextMenu.Items>{items.map((it) => renderItem(it, onSelect))}</ContextMenu.Items>
      </ContextMenu>
    </Host>
  );
}
