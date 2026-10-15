/**
 * ⌘K (SRCH-01): go anywhere or start something. Typing filters commands, Agents, conversations,
 * docs (with the knowledge base on) and settings; arrows move, Enter goes, Escape closes.
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutGrid,
  FilePlus,
  FileText,
  Hash,
  MessageSquare,
  Plus,
  Settings,
  Shield,
  Sparkles,
  Table2,
  TextSearch,
  User,
} from 'lucide-react';
import { Overlay } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { useSession } from '../app/session';
import { useAgents } from '../data/agents';
import { useConversations } from '../data/conversations';
import { useBases } from '../data/tables';
import { openNewBase } from '../pages/tables/entry';
import { api } from '../lib/api';
import { cx } from '../lib/cx';
import { useT } from '../lib/i18n';
import { navigate, useRoute } from '../lib/router';
import { useNewTarget } from '../pages/knowledge/KnowledgeDirectory';
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
  const newTarget = useNewTarget(useRoute());
  const knowledge = !!me?.modules.knowledge;
  const appsOn = !!me?.modules.apps;
  const tablesOn = !!me?.modules.tables;
  const bases = useBases(false, tablesOn);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [debounced, setDebounced] = useState('');
  const listId = useId();
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  // Messages, people and docs come from the server; commands, Agents and settings are already here.
  const remote = useQuery({
    queryKey: ['search', debounced, knowledge, tablesOn, appsOn],
    queryFn: () =>
      api.search({
        q: debounced,
        kinds: [
          'extensions',
          'conversations',
          ...(knowledge ? (['docs'] as const) : []),
          'messages',
          'members',
          ...(tablesOn ? (['records'] as const) : []),
          ...(appsOn ? (['apps'] as const) : []),
        ],
      }),
    enabled: debounced.length > 0,
    staleTime: 10_000,
  });

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
      ...(knowledge
        ? [
            {
              id: 'new-doc',
              group: t('palette.commands'),
              label: t('knowledge.newDoc'),
              leading: small(<FilePlus size={icon.md} />),
              run: () => openOverlay({ type: 'new-knowledge', kind: 'doc', target: newTarget() }),
            },
          ]
        : []),
      ...(tablesOn
        ? [
            {
              id: 'new-base',
              group: t('palette.commands'),
              label: t('tables.new'),
              leading: small(<Table2 size={icon.md} />),
              run: () => openNewBase(openOverlay),
            },
          ]
        : []),
      ...(appsOn
        ? [
            {
              id: 'new-app',
              group: t('palette.commands'),
              label: t('apps.new'),
              leading: small(<LayoutGrid size={icon.md} />),
              run: () => navigate({ page: 'apps', newApp: true }),
            },
          ]
        : []),
    ].filter((item) => hit(item.label));
    const baseItems: Item[] = q
      ? bases.items
          .filter((base) => hit(base.name, ...base.tables.map((table) => table.name)))
          .slice(0, LIMIT)
          .map((base) => ({
            id: `base:${base.id}`,
            group: t('nav.tables'),
            label: base.name,
            hint:
              base.tables.length === 1 && base.tables[0]?.name === base.name
                ? undefined
                : base.tables.map((table) => table.name).join(' · '),
            leading: small(<Table2 size={icon.md} />),
            run: () => navigate({ page: 'base', id: base.id }),
          }))
      : [];
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
    const seen = new Set(conversationItems.map((item) => item.id));
    const found = q && remote.data && debounced === query.trim() ? remote.data.items : [];
    const remoteItems: Item[] = found.flatMap((item): Item[] => {
      if (item.kind === 'conversations') {
        if (seen.has(`conversation:${item.id}`)) return [];
        return [
          {
            id: `conversation:${item.id}`,
            group: t('nav.chat'),
            label: item.title || t('chat.untitled'),
            leading: small(<MessageSquare size={icon.md} />),
            run: () => navigate({ page: 'conversation', id: item.conversation_id ?? item.id }),
          },
        ];
      }
      if (item.kind === 'extensions' && item.href)
        return [
          {
            id: `extension:${item.extension_id}:${item.source}:${item.id}`,
            group: t('nav.extensions'),
            label: item.title,
            hint: item.snippet,
            leading: small(<FileText size={icon.md} />),
            run: () => navigate(item.href!),
          },
        ];
      if (item.kind === 'docs') {
        return [
          {
            id: `doc:${item.id}`,
            group: t('palette.docs'),
            label: item.title,
            hint: item.snippet,
            leading: small(<FileText size={icon.md} />),
            run: () => navigate({ page: 'doc', id: item.id }),
          },
        ];
      }
      if (item.kind === 'messages') {
        return [
          {
            id: `message:${item.id}`,
            group: t('palette.messages'),
            label: item.snippet ?? item.title,
            hint: item.title,
            leading: small(<TextSearch size={icon.md} />),
            run: () => navigate({ page: 'conversation', id: item.conversation_id! }),
          },
        ];
      }
      if (item.kind === 'records' && item.base_id && item.table_id) {
        return [
          {
            id: `record:${item.id}`,
            group: t('tables.palette.records'),
            label: item.title || t('tables.record.untitled'),
            hint: item.snippet,
            leading: small(<Table2 size={icon.md} />),
            run: () => navigate({ page: 'base', id: item.base_id!, table: item.table_id!, record: item.id }),
          },
        ];
      }
      if (item.kind === 'apps')
        return [
          {
            id: `app:${item.id}`,
            group: t('nav.apps'),
            label: item.title,
            leading: small(<LayoutGrid size={icon.md} />),
            run: () => navigate({ page: 'app', id: item.id }),
          },
        ];
      if (item.kind === 'members') {
        if (item.id === me?.id) return [];
        return [
          {
            id: `member:${item.id}`,
            group: t('palette.people'),
            label: item.title,
            hint: item.snippet,
            leading: small(<User size={icon.md} />),
            run: () => openOverlay({ type: 'new-room', people: [item.id] }),
          },
        ];
      }
      return [];
    });
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
    return [...commands, ...agentItems, ...conversationItems, ...baseItems, ...remoteItems, ...sections];
  }, [
    query,
    debounced,
    remote.data,
    agents.items,
    conversations.items,
    bases.items,
    tablesOn,
    appsOn,
    me?.role,
    me?.id,
    openOverlay,
    t,
    knowledge,
    newTarget,
  ]);

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
