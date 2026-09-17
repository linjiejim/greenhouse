import React, { useEffect, useRef, useState } from 'react';
import type { Profile } from '../../lib/api';
import { useListReorder, moveTo } from '../../hooks/use-list-reorder';
import { useAuthStore } from '../../stores';
import { useLocalized, useT } from '../../lib/i18n';
import { ChevronDown, ChevronLeft, ChevronRight, Info, X, Check, Loader2, CircleAlert } from '../../lib/icons';
import { Button, IconButton, Input } from '../ui';
import { OverlayPanel } from '../app/overlay-panel';
import { SproutyAvatar } from '../sprouty';
import { profileToSprouty } from './profile-avatar';

export interface AgentPickerControls {
  profiles: Profile[];
  selectedId: string;
  onSelect: (id: string) => void;
  disabled?: boolean;
  statuses?: Record<string, { unread_count: number; running_count: number; attention_count: number }>;
}
export const agentKey = (id: string) => id.replace(/@\d+$/, '');

export function AgentIdentity({ profileId, profiles }: { profileId: string; profiles: Profile[] }) {
  const l = useLocalized();
  const profile = profiles.find((p) => agentKey(p.id) === agentKey(profileId));
  return (
    <span
      data-testid="chat-agent-identity"
      title={profile ? l(profile.name_i18n, profile.name) : profileId}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface-muted"
    >
      <SproutyAvatar size="sm" {...(profile ? profileToSprouty(profile) : { variant: 'default' as const })} />
    </span>
  );
}

/** New-conversation identity choices. Ordering changes preference, never session identity. */
export function AgentAvatarPicker({ profiles, selectedId, onSelect, disabled, statuses }: AgentPickerControls) {
  const t = useT();
  const l = useLocalized();
  const userId = useAuthStore((s) => s.currentUser?.id);
  const storageKey = `greenhouse-agent-order:${userId ?? 'anonymous'}`;
  const [order, setOrder] = useState<string[]>([]);
  const [capacity, setCapacity] = useState(4);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [left, setLeft] = useState(0);
  const [top, setTop] = useState(64);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      setOrder(Array.isArray(stored) ? stored.filter((v): v is string => typeof v === 'string') : []);
    } catch {
      setOrder([]);
    }
  }, [storageKey]);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setCapacity(Math.max(1, Math.floor((entry.contentRect.width - 68) / 60))),
    );
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const orderedProfiles = [...profiles].sort((a, b) => {
    const ai = order.indexOf(agentKey(a.id)),
      bi = order.indexOf(agentKey(b.id));
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi);
  });
  const commitOrder = (ids: string[]) => {
    setOrder(ids);
    try {
      localStorage.setItem(storageKey, JSON.stringify(ids));
    } catch {
      /* session-only preference */
    }
  };
  const reorder = useListReorder(
    orderedProfiles.map((p) => agentKey(p.id)),
    commitOrder,
  );
  const ordered = reorder.order.flatMap((id) => {
    const p = profiles.find((p) => agentKey(p.id) === id);
    return p ? [p] : [];
  });
  const visible = ordered.slice(0, capacity);
  const selected = ordered.find((p) => agentKey(p.id) === agentKey(selectedId));
  if (selected && !visible.includes(selected)) visible[visible.length - 1] = selected;
  const move = (source: string, target: string) => {
    const ids = ordered.map((p) => agentKey(p.id));
    const from = ids.indexOf(agentKey(source)),
      to = ids.indexOf(agentKey(target));
    if (from < 0 || to < 0 || from === to) return;
    commitOrder(moveTo(ids, agentKey(source), to));
  };
  const select = (id: string) => {
    onSelect(id);
    setOpen(false);
  };
  return (
    <div
      ref={host}
      data-testid="agent-avatar-picker"
      className="flex min-w-0 flex-1 items-center gap-1"
      role="group"
      aria-label={t('coworker.choose')}
    >
      {visible.map((profile) => {
        const name = l(profile.name_i18n, profile.name);
        const active = agentKey(profile.id) === agentKey(selectedId);
        const status = statuses?.[agentKey(profile.id)];
        const statusText = [
          status?.running_count ? t('coworker.runningCount', { count: status.running_count }) : '',
          status?.attention_count ? t('coworker.attention') : '',
          status?.unread_count ? t('coworker.unreadCount', { count: status.unread_count }) : '',
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <button
            key={profile.id}
            type="button"
            {...(!disabled ? reorder.itemProps(agentKey(profile.id)) : {})}
            disabled={disabled}
            data-agent-id={profile.id}
            data-unread-count={status?.unread_count ?? 0}
            data-running-count={status?.running_count ?? 0}
            aria-pressed={active}
            aria-label={name}
            title={[name, statusText].filter(Boolean).join(' · ')}
            aria-description={statusText || undefined}
            onClick={() => {
              if (!reorder.didDrag()) select(profile.id);
            }}
            onKeyDown={(event) => {
              if (event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
                event.preventDefault();
                const index = ordered.indexOf(profile) + (event.key === 'ArrowLeft' ? -1 : 1);
                if (ordered[index]) move(profile.id, ordered[index].id);
              }
            }}
            className={`relative flex w-14 shrink-0 flex-col items-center gap-0.5 rounded-lg py-1 transition-colors focus-visible:outline-2 focus-visible:outline-primary-500 disabled:opacity-50 ${active ? 'bg-primary-50 text-primary-700' : 'text-fg-muted hover:bg-surface-muted'}`}
          >
            <span
              className={`relative inline-flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-surface-muted ${active ? 'ring-2 ring-primary-500 ring-offset-2 ring-offset-surface-raised' : ''}`}
            >
              <SproutyAvatar size="md" className="scale-125" {...profileToSprouty(profile)} />
            </span>
            {!!status?.unread_count && (
              <span className="absolute right-0 top-0 min-w-4 rounded-full bg-danger px-1 text-[9px] leading-4 text-white ring-2 ring-surface-raised">
                {status.unread_count > 99 ? '99+' : status.unread_count}
              </span>
            )}
            {status?.attention_count ? (
              <CircleAlert size={13} className="absolute left-0 top-7 rounded-full bg-surface-raised text-warning" />
            ) : (
              !!status?.running_count && (
                <Loader2
                  size={13}
                  className="absolute left-0 top-7 rounded-full bg-surface-raised text-primary-600 motion-safe:animate-spin"
                />
              )
            )}
            <span className="w-full truncate px-1 text-[10px] leading-4">{name}</span>
          </button>
        );
      })}
      {ordered.length > capacity && (
        <IconButton
          label={t('coworker.more')}
          size="compact"
          disabled={disabled}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setLeft(Math.max(8, Math.min(rect.left, window.innerWidth - 328)));
            setTop(rect.bottom + 8);
            setSearch('');
            setOpen(true);
          }}
        >
          <ChevronDown size={16} />
          {ordered.some((p) => !visible.includes(p) && (statuses?.[agentKey(p.id)]?.unread_count ?? 0) > 0) && (
            <span className="h-1.5 w-1.5 rounded-full bg-danger" />
          )}
        </IconButton>
      )}
      {capacity > 1 && (
        <IconButton label={t('coworker.chooseHint')} size="compact" tooltipMode="portal">
          <Info size={13} />
        </IconButton>
      )}
      {open && (
        <OverlayPanel
          onClose={() => setOpen(false)}
          ariaLabel={t('coworker.choose')}
          className="fixed flex w-80 max-w-[calc(100vw-16px)] flex-col rounded-xl border border-edge bg-surface-raised p-3 shadow-xl"
          style={{ top, left, right: 'auto', maxHeight: 'min(70vh,480px)' }}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">{t('coworker.choose')}</span>
            <IconButton size="compact" label={t('common.close')} onClick={() => setOpen(false)}>
              <X size={14} />
            </IconButton>
          </div>
          <Input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('common.search')}
            aria-label={t('common.search')}
          />
          <div className="mt-2 overflow-y-auto">
            {ordered
              .filter((p) => l(p.name_i18n, p.name).toLowerCase().includes(search.toLowerCase()))
              .map((profile) => {
                const index = ordered.indexOf(profile);
                return (
                  <div key={profile.id} className="flex items-center gap-1 rounded-lg hover:bg-surface-muted">
                    <Button
                      variant="ghost"
                      className="min-w-0 flex-1 justify-start gap-2"
                      onClick={() => select(profile.id)}
                    >
                      <SproutyAvatar size="sm" {...profileToSprouty(profile)} />
                      <span className="truncate">{l(profile.name_i18n, profile.name)}</span>
                      {!!statuses?.[agentKey(profile.id)]?.running_count && (
                        <Loader2 size={12} className="shrink-0 motion-safe:animate-spin" />
                      )}
                      {!!statuses?.[agentKey(profile.id)]?.attention_count && (
                        <CircleAlert size={12} className="shrink-0 text-warning" />
                      )}
                      {!!statuses?.[agentKey(profile.id)]?.unread_count && (
                        <span className="rounded-full bg-danger px-1.5 text-[10px] text-white">
                          {statuses[agentKey(profile.id)].unread_count}
                        </span>
                      )}
                      {agentKey(profile.id) === agentKey(selectedId) && <Check size={14} />}
                    </Button>
                    <IconButton
                      size="compact"
                      label={t('coworker.moveEarlier')}
                      disabled={index === 0}
                      onClick={() => move(profile.id, ordered[index - 1].id)}
                    >
                      <ChevronLeft size={13} />
                    </IconButton>
                    <IconButton
                      size="compact"
                      label={t('coworker.moveLater')}
                      disabled={index === ordered.length - 1}
                      onClick={() => move(profile.id, ordered[index + 1].id)}
                    >
                      <ChevronRight size={13} />
                    </IconButton>
                  </div>
                );
              })}
          </div>
        </OverlayPanel>
      )}
    </div>
  );
}
