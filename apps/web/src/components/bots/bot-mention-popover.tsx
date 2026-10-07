/**
 * `@` picker for a Bots conversation: the Bots in this conversation, then
 * "Invite another Bot". Same interaction model as the Chat mention popover
 * (↑↓, Enter/Tab, Esc — captured on window so the composer never sends on
 * the Enter that picks a name).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotView } from '@greenhouse/types/bots';
import { UserPlus } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { PopoverWrapper } from '../chat/popover-wrapper';
import { BotAvatar } from './bot-avatar';

const INVITE = '__invite__';

export function BotMentionPopover({
  query,
  members,
  canInvite,
  onSelect,
  onInvite,
  onDismiss,
  anchorRef,
}: {
  query: string;
  members: BotView[];
  canInvite: boolean;
  onSelect: (bot: BotView) => void;
  onInvite: () => void;
  onDismiss: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return members.filter(
      (bot) => !q || bot.name.toLocaleLowerCase().includes(q) || bot.role.toLocaleLowerCase().includes(q),
    );
  }, [members, query]);
  const options = useMemo<Array<BotView | typeof INVITE>>(
    () => (canInvite ? [...filtered, INVITE] : filtered),
    [canInvite, filtered],
  );

  // Nothing matches → nothing is selected, so Enter sends the message as
  // typed ("send it to @jim" where jim is a colleague) instead of opening
  // "Invite another Bot" and eating the word. ↓ still reaches the invite row.
  useEffect(() => setSelectedIndex(filtered.length > 0 ? 0 : -1), [query, filtered.length]);

  const pick = useCallback(
    (option: BotView | typeof INVITE) => {
      if (option === INVITE) onInvite();
      else onSelect(option);
    },
    [onInvite, onSelect],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((index) => Math.min(index + 1, options.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((index) => Math.max(index - 1, filtered.length > 0 ? 0 : -1));
      } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.isComposing) {
        const option = options[selectedIndex];
        if (option === undefined) {
          // Not a pick: close the list and let the key through (Enter sends).
          onDismiss();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        pick(option);
      }
    },
    [filtered.length, onDismiss, options, pick, selectedIndex],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selectedIndex}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <PopoverWrapper anchorRef={anchorRef}>
      <div
        ref={listRef}
        className="max-h-64 overflow-y-auto py-1"
        role="listbox"
        aria-label={t('bots.composer.members')}
      >
        {filtered.length === 0 && <p className="px-3 py-2 text-xs text-fg-faint">{t('bots.composer.noMatch')}</p>}
        {options.map((option, index) => {
          const selected = index === selectedIndex;
          const rowClass = `flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
            selected ? 'bg-primary-600 text-white' : 'text-fg hover:bg-surface-muted'
          }`;
          if (option === INVITE) {
            return (
              <button
                key={INVITE}
                type="button"
                data-idx={index}
                role="option"
                aria-selected={selected}
                className={`${rowClass} border-t border-edge`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onInvite();
                }}
                onMouseEnter={() => setSelectedIndex(index)}
              >
                <span className="flex h-6 w-6 items-center justify-center">
                  <UserPlus size={14} aria-hidden="true" />
                </span>
                <span className="text-sm">{t('bots.composer.inviteAnother')}</span>
              </button>
            );
          }
          return (
            <button
              key={option.id}
              type="button"
              data-idx={index}
              role="option"
              aria-selected={selected}
              className={rowClass}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(option);
              }}
              onMouseEnter={() => setSelectedIndex(index)}
            >
              <BotAvatar bot={option} size="xs" />
              <span className="min-w-0 truncate text-sm font-medium" title={option.name}>
                {option.name}
              </span>
              {option.role && (
                <span className={`ml-auto truncate text-[11px] ${selected ? 'text-white/80' : 'text-fg-faint'}`}>
                  {option.role}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </PopoverWrapper>
  );
}
