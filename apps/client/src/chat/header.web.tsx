import React from 'react';
import { Stack, useRouter, usePathname } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { HeaderTitle } from './header-avatar';
import type { ChatHeaderProps } from './header';
import { Controls } from '../ui/screen-actions.web';
import { useWideShell } from '../shell/wide-shell.web';
import { useInspector } from '../shell/inspector.web';
import { useT } from '../lib/i18n';
import { useCopy } from '../ui/use-copy';
import { copyLabel } from '../ui/copy-state';
import { SheetScreen } from '../ui/screen.web';
import { useShortcut } from '../ui/use-shortcut';
import { SECONDARY_MIN, WIDE_MIN } from '../shell/wide-model';
export function ChatHeader({ title, subtitle, state, actions, sessionId, shared }: ChatHeaderProps) {
  const { width } = useWindowDimensions();
  const wide = width >= WIDE_MIN;
  const shell = useWideShell();
  const router = useRouter();
  const path = usePathname();
  const t = useT();
  // Share copies the conversation's link: the button answers (已复制 / 复制失败), never a notice
  const link = useCopy();
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
                width < SECONDARY_MIN ? (
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
                      icon: link.state === 'copied' ? 'check' : 'share',
                      label: copyLabel(link.state, t('conversation.share'), t),
                      disabled: !sessionId,
                      onPress: () =>
                        void link.copy(
                          `${window.location.origin}/chat?session=${encodeURIComponent(sessionId ?? '')}`,
                        ),
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
