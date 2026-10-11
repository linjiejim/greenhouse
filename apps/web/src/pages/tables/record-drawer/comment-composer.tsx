/**
 * The record comment composer: a textarea with an `@` people picker.
 *
 * Typing `@` (at the start or after a space) opens the list of internal
 * people; picking one inserts a readable `@Name` token and remembers who it
 * is. On send the tokens become `[@Name](user:<id>)` links (./comment-mentions),
 * which the server turns into notifications for the people who can open the
 * record. Ctrl / ⌘ + Enter sends; the same component edits an existing
 * comment (`initial` + `onCancel`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TABLE_COMMENT_MAX_LENGTH } from '@greenhouse/types/tables';
import { Avatar, Button, Textarea } from '../../../components/ui';
import { useTriggerPopup } from '../../../components/chat/use-trigger-popup';
import { useT } from '../../../lib/i18n';
import {
  commentToDraft,
  draftToComment,
  mentionCandidates,
  type MentionCandidateUser,
  type PickedMention,
} from './comment-mentions';

export interface CommentComposerProps {
  users: readonly MentionCandidateUser[];
  /** Stored Markdown of the comment being edited; absent = a new comment. */
  initial?: string;
  submitLabel: string;
  /** Resolves true when the comment was saved (the composer then clears). */
  onSubmit: (markdown: string) => Promise<boolean>;
  onCancel?: () => void;
  autoFocus?: boolean;
}

export function CommentComposer({ users, initial, submitLabel, onSubmit, onCancel, autoFocus }: CommentComposerProps) {
  const t = useT();
  const start = useMemo(() => commentToDraft(initial ?? ''), [initial]);
  const [text, setText] = useState(start.text);
  const [picked, setPicked] = useState<PickedMention[]>(start.picked);
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mention = useTriggerPopup({ triggerChar: '@', textareaRef, value: text, enabled: users.length > 0 });

  const markdown = useMemo(() => draftToComment(text.trim(), picked), [text, picked]);
  const tooLong = markdown.length > TABLE_COMMENT_MAX_LENGTH;
  const canSend = markdown.length > 0 && !tooLong && !busy;

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const send = useCallback(async () => {
    if (!canSend) return;
    setBusy(true);
    try {
      if ((await onSubmit(markdown)) && initial === undefined) {
        setText('');
        setPicked([]);
      }
    } finally {
      setBusy(false);
    }
  }, [canSend, initial, markdown, onSubmit]);

  const pick = useCallback(
    (user: MentionCandidateUser) => {
      const token = `@${user.nickname} `;
      const caret = mention.triggerIndex + token.length;
      setText(mention.insertSelection(token));
      setPicked((current) =>
        current.some((entry) => entry.id === user.id) ? current : [...current, { id: user.id, name: user.nickname }],
      );
      setTimeout(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(caret, caret);
      }, 0);
    },
    [mention],
  );

  return (
    <div className="space-y-2">
      <div className="relative">
        <Textarea
          ref={textareaRef}
          rows={initial === undefined ? 3 : 4}
          value={text}
          aria-label={t('tables.activity.composerLabel')}
          placeholder={t('tables.activity.composerPlaceholder')}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !mention.isActive) {
              event.preventDefault();
              void send();
            } else if (event.key === 'Escape' && onCancel && !mention.isActive) {
              event.preventDefault();
              onCancel();
            }
          }}
        />
        {mention.isActive && (
          <MentionList query={mention.query} users={users} onPick={pick} onDismiss={mention.dismiss} />
        )}
      </div>
      {tooLong && (
        <p role="alert" className="text-xs text-danger">
          {t('tables.activity.tooLong', { max: TABLE_COMMENT_MAX_LENGTH })}
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate text-[11px] text-fg-faint" title={t('tables.activity.composerHint')}>
          {t('tables.activity.composerHint')}
        </p>
        <div className="flex flex-shrink-0 items-center gap-2">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
              {t('common.cancel')}
            </Button>
          )}
          <Button size="sm" onClick={() => void send()} disabled={!canSend}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * The `@` list under the textarea (the composer sits at the top of a scrolling
 * panel, so it opens downwards). Keys are captured on window while it is open
 * so the Enter that picks a person never also sends: ↑↓ move, Enter / Tab
 * pick, Esc closes.
 */
function MentionList({
  query,
  users,
  onPick,
  onDismiss,
}: {
  query: string;
  users: readonly MentionCandidateUser[];
  onPick: (user: MentionCandidateUser) => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const options = useMemo(() => mentionCandidates(users, query), [users, query]);
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [query]);

  const onKey = useCallback(
    (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelected((index) => Math.min(index + 1, options.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelected((index) => Math.max(index - 1, 0));
      } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.isComposing) {
        const option = options[selected];
        if (!option) {
          onDismiss();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onPick(option);
      }
    },
    [onDismiss, onPick, options, selected],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onKey]);

  return (
    <div className="absolute left-0 right-0 top-full z-50 mt-1 max-w-full overflow-hidden rounded-lg border border-edge bg-surface-raised shadow-lg md:max-w-[360px]">
      {options.length === 0 ? (
        <p className="px-3 py-2 text-xs text-fg-faint">{t('tables.activity.mentionNoMatch')}</p>
      ) : (
        <div className="max-h-64 overflow-y-auto py-1" role="listbox" aria-label={t('tables.activity.mentionList')}>
          {options.map((user, index) => (
            <button
              key={user.id}
              type="button"
              role="option"
              aria-selected={index === selected}
              className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors ${
                index === selected ? 'bg-primary-subtle text-primary-fg-strong' : 'text-fg hover:bg-surface-muted'
              }`}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(user);
              }}
              onMouseEnter={() => setSelected(index)}
            >
              <Avatar name={user.nickname} size="xs" />
              <span className="min-w-0 truncate text-sm font-medium" title={user.nickname}>
                {user.nickname}
              </span>
              <span className="ml-auto min-w-0 truncate text-[11px] text-fg-faint" title={user.email}>
                {user.email}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
