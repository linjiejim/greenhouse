/**
 * ⌘K (SRCH-01): go anywhere or start something. Typing filters commands, Agents, conversations
 * and settings; arrows move, Enter goes, Escape closes.
 */

import { useId, useMemo, useState, type ReactNode } from 'react';
import { Hash, MessageSquare, Plus, Settings, Shield, Sparkles } from 'lucide-react';
import { Overlay } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { useSession } from '../app/session';
import { useAgents } from '../data/agents';
import { useConversations } from '../data/conversations';
import { cx } from '../lib/cx';
import { useT } from '../lib/i18n';
import { navigate } from '../lib/router';
import { AgentAvatar } from './AgentAvatar';
import { ADMIN, SETTINGS } from './Directory';
import { useOpenOverlay } from './overlays';

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  leading: ReactNode;
  run: () => void;
}

const LIMIT = 8;

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { me } = useSession();
  const openOverlay = useOpenOverlay();
  const agents = useAgents('mine');
  const conversations = useConversations();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const hit = (...values: string[]) => !q || values.some((value) => value.toLowerCase().includes(q));
    const small = (node: ReactNode) => <span className="app-palette-icon">{node}</span>;
    const commands: Item[] = [
      {
        id: 'new-chat',
        group: t('palette.commands'),
        label: t('chat.newChat'),
        leading: small(<Plus size={icon.md} />),
        run: () => navigate('#/c/new'),
      },
      {
        id: 'new-room',
        group: t('palette.commands'),
        label: t('chat.newRoom'),
        leading: small(<Hash size={icon.md} />),
        run: () => openOverlay({ type: 'new-room' }),
      },
      {
        id: 'new-agent',
        group: t('palette.commands'),
        label: t('agents.new'),
        leading: small(<Sparkles size={icon.md} />),
        run: () => openOverlay({ type: 'new-agent' }),
      },
    ].filter((item) => hit(item.label));
    const agentItems: Item[] = agents.items
      .filter((agent) => hit(agent.name, agent.role))
      .slice(0, LIMIT)
      .map((agent) => ({
        id: `agent:${agent.id}`,
        group: t('nav.agents'),
        label: agent.name,
        hint: agent.role,
        leading: <AgentAvatar agent={agent} size={20} />,
        run: () => navigate(agent.is_main ? '#/c/main' : { page: 'agent', id: agent.id, tab: 'profile' }),
      }));
    const conversationItems: Item[] = q
      ? conversations.items
          .filter((item) => (item.kind === 'chat' || item.kind === 'room') && hit(item.title))
          .slice(0, LIMIT)
          .map((item) => ({
            id: `conversation:${item.id}`,
            group: t('nav.chat'),
            label: item.title || t('chat.untitled'),
            leading: small(item.kind === 'room' ? <Hash size={icon.md} /> : <MessageSquare size={icon.md} />),
            run: () => navigate({ page: 'conversation', id: item.id }),
          }))
      : [];
    const sections: Item[] = [
      ...SETTINGS.map((section) => ({
        id: `settings:${section.id}`,
        group: t('nav.settings'),
        label: t(section.label),
        leading: small(<Settings size={icon.md} />),
        run: () => navigate({ page: 'settings', section: section.id }),
      })),
      ...(me?.role === 'admin'
        ? ADMIN.map((section) => ({
            id: `admin:${section.id}`,
            group: t('nav.admin'),
            label: t(section.label),
            leading: small(<Shield size={icon.md} />),
            run: () => navigate({ page: 'admin', section: section.id }),
          }))
        : []),
    ].filter((item) => q && hit(item.label, item.group));
    return [...commands, ...agentItems, ...conversationItems, ...sections];
  }, [query, agents.items, conversations.items, me?.role, openOverlay, t]);

  const current = Math.min(active, Math.max(items.length - 1, 0));
  const go = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  return (
    <Overlay variant="dialog" wide title={t('palette.title')} onClose={onClose}>
      <div className="app-palette">
        <input
          className="gh-input gh-input-lg app-palette-input"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={items[current] ? `${listId}-${current}` : undefined}
          aria-label={t('search.placeholder')}
          placeholder={t('search.placeholder')}
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const step = event.key === 'ArrowDown' ? 1 : -1;
              setActive((current + step + items.length) % Math.max(items.length, 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              go(items[current]);
            }
          }}
        />
        <ul className="app-palette-list" id={listId} role="listbox" aria-label={t('palette.results')}>
          {items.map((item, index) => (
            <li key={item.id} role="presentation">
              {(index === 0 || items[index - 1]!.group !== item.group) && (
                <div className="app-palette-group" role="presentation">
                  {item.group}
                </div>
              )}
              <div
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === current}
                className={cx('app-palette-item', index === current && 'is-active')}
                onPointerMove={() => setActive(index)}
                onClick={() => go(item)}
              >
                {item.leading}
                <span className="app-palette-label">{item.label}</span>
                {item.hint && <span className="app-palette-hint">{item.hint}</span>}
              </div>
            </li>
          ))}
        </ul>
        {items.length === 0 && <p className="app-palette-empty">{t('search.empty', { query: query.trim() })}</p>}
      </div>
    </Overlay>
  );
}
