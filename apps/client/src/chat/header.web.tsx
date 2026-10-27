import React from 'react';
import { Stack, useRouter, usePathname } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { HeaderTitle } from './header-avatar';
import type { ChatHeaderProps } from './header';
import { Controls } from '../ui/screen-actions.web';
import { useWideShell } from '../shell/wide-shell.web';
import { useInspector } from '../shell/inspector.web';
import { useT } from '../lib/i18n';
import { toast } from '../ui/toast';
import { SheetScreen } from '../ui/screen.web';
import { useShortcut } from '../ui/use-shortcut';
export function ChatHeader({ title, subtitle, state, actions, sessionId, shared }: ChatHeaderProps) {
  const { width } = useWindowDimensions();
  const wide = width >= 760;
  const shell = useWideShell();
  const router = useRouter();
  const path = usePathname();
  const t = useT();
  const last = useInspector((s) => s.last);
  const close = useInspector((s) => s.close);
  const toggle = () => {
    if (close) close();
    else if (last) router.push(last as never);
  };
  useShortcut('mod+alt+i', toggle, wide);
  const menu = actions.find((a) => a.menu);
  const pin = menu?.menu?.find((a) => a.id === 'action-3');
  if (path === '/sheet/conversation') return <SheetScreen title={title} />;
  return (
    <Stack.Screen
      options={{
        title,
        headerTransparent: false,
        headerBackVisible: !wide,
        headerTitle: () => <HeaderTitle title={title} subtitle={subtitle} state={state} />,
        ...(wide
          ? {
              headerLeft: () =>
                width < 1100 ? (
                  <Controls
                    actions={[
                      { id: 'secondary', icon: 'menu', label: t('nav.sidebar'), onPress: shell.toggleSecondary },
                    ]}
                  />
                ) : null,
            }
          : {}),
        headerRight: () => (
          <Controls
            maxVisible={4}
            actions={
              wide
                ? [
                    ...(pin && !shared ? [pin] : []),
                    {
                      id: 'share',
                      icon: 'share',
                      label: t('conversation.share'),
                      disabled: !sessionId,
                      onPress: () => {
                        void Clipboard.setStringAsync(
                          `${window.location.origin}/chat?session=${encodeURIComponent(sessionId ?? '')}`,
                        );
                        toast(t('markdown.copied'));
                      },
                    },
                    {
                      id: 'inspector',
                      icon: 'menu',
                      label: t('client.inspector'),
                      disabled: !last && !close,
                      onPress: toggle,
                    },
                    ...(menu ? [menu] : []),
                  ]
                : actions
            }
          />
        ),
      }}
    />
  );
}
