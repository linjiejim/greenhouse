/** One browser list row and one action set for its context menu and trailing menu. */
import React from 'react';
import { ConversationRow as PhoneRow } from './conversation-row.native';
import { useWindowDimensions } from 'react-native';
import { usePrefs } from '../store/prefs';
import { conversationAge } from '../shell/wide-model';
import type { ConversationRow as NativeRow } from './conversation-row';
import { useOpenObject } from '../shell/open-object';
import { useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { NativeMenu } from '../ui/menu.web';
import { Icon } from '../ui/core.web';
import { useTheme, typo } from '../theme';
import { useT } from '../lib/i18n';
import { shortAgeNow } from '../lib/time-words';
import { confirmAction } from '../ui/dialogs';
import { useSessions } from '../store/sessions';
import { toast } from '../ui/toast';

type Props = React.ComponentProps<typeof NativeRow> & { selected?: boolean; secondary?: boolean };
export function ConversationRow(props: Props) {
  const { session, onOpen, onPin, onRename, selected, secondary } = props;
  const { width } = useWindowDimensions();
  const lang = usePrefs((s) => s.lang);
  const t = useT();
  const { hex: c } = useTheme();
  const router = useRouter();
  const openObject = useOpenObject();
  const age = width >= 760 ? conversationAge(session.updated_at, Date.now(), lang) : shortAgeNow(session.updated_at);
  const items = [
    { id: 'pin', title: t(session.pinned ? 'home.unpin' : 'home.pin'), icon: 'pin' as const },
    { id: 'rename', title: t('home.rename'), icon: 'pen' as const },
    { id: 'inspect', title: t('client.openInspector'), icon: 'menu' as const, shortcut: '⌘ Enter' },
    { id: 'copy', title: t('client.copyLink'), icon: 'copy' as const, shortcut: '⌘ ⇧ C' },
    {
      id: 'delete',
      title: t('conversation.delete'),
      icon: 'trash' as const,
      destructive: true,
      shortcut: '⌘ Backspace',
    },
  ];
  const select = async (id: string) => {
    if (id === 'pin') onPin(!session.pinned);
    else if (id === 'rename') onRename();
    else if (id === 'inspect') openObject({ kind: 'chat-preview', sessionId: session.id });
    else if (id === 'copy') {
      await Clipboard.setStringAsync(`${window.location.origin}/chat?session=${encodeURIComponent(session.id)}`);
      toast(t('markdown.copied'));
    } else if (
      id === 'delete' &&
      (await confirmAction({
        title: t('conversation.deleteTitle'),
        message: t('conversation.deleteHint'),
        confirmLabel: t('conversation.delete'),
        destructive: true,
      }))
    ) {
      if ((await useSessions.getState().remove(session.id)) && selected) router.navigate('/');
    }
  };
  if (width < 760) return <PhoneRow {...props} />;
  return (
    <NativeMenu trigger="longPress" fill items={items} onSelect={(id) => void select(id)}>
      <div
        className="gh-conversation-row"
        data-selected={selected || undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          borderRadius: 8,
          background: selected ? c.sidebarSelection : 'transparent',
        }}
      >
        <button
          className="gh-secondary-row"
          data-testid="conversation-row"
          data-session={session.id}
          aria-current={selected ? 'page' : undefined}
          onClick={onOpen}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void select('inspect');
            }
            if ((e.metaKey || e.ctrlKey) && e.key === 'Backspace') {
              e.preventDefault();
              void select('delete');
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const rows = Array.from(
                e.currentTarget
                  .closest('[data-conversation-list], [data-testid=home-recent-list], [data-testid=client-sheet]')
                  ?.querySelectorAll<HTMLButtonElement>('[data-testid="conversation-row"]') ?? [],
              );
              const i = rows.indexOf(e.currentTarget);
              rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
            }
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            flex: 1,
            minWidth: 0,
            gap: 8,
            padding: secondary ? '0 8px' : '0 16px',
            height: secondary ? 32 : 40,
            border: 0,
            borderRadius: 8,
            textAlign: 'left',
            background: 'transparent',
            color: c.secondaryLabel,
            fontFamily: typo.body.fontFamily,
            fontSize: typo.body.fontSize,
            fontWeight: selected ? 600 : 400,
          }}
        >
          <span style={{ flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
            {session.title || t('assistant.untitled')}
          </span>
          <small style={{ color: c.tertiaryLabel, whiteSpace: 'nowrap' }}>
            {age === 'now' ? t('time.short.now') : age}
          </small>
        </button>
        <span className="gh-row-menu">
          <NativeMenu items={items} onSelect={(id) => void select(id)}>
            <button
              aria-label={t('client.conversationOptions', { title: session.title || t('assistant.untitled') })}
              style={{ border: 0, background: 'transparent', color: c.secondaryLabel, padding: 4 }}
            >
              <Icon name="more" size={16} />
            </button>
          </NativeMenu>
        </span>
      </div>
    </NativeMenu>
  );
}
