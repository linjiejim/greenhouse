/**
 * The composer (conversation.md, 输入框): grows with its text, Enter sends and Shift Enter breaks
 * the line (never while an input method is composing). Attachments upload at once and show as
 * pills; sending waits for them. `@` names someone in a room, or picks the Agent of a new chat.
 * Send and stop share one place: while an Agent answers, an empty composer offers stop and a
 * filled one sends into the queue.
 */

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { ArrowUp, AtSign, FileText, Paperclip, Square, X } from 'lucide-react';
import { IconButton, Spinner } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { FileView } from '@greenhouse/contract';
import { api } from '../lib/api';
import { cx } from '../lib/cx';
import { useT } from '../lib/i18n';

export interface Candidate {
  /** What goes into `mentions`: `main`, `agent:<id>` or a member id. */
  handle: string;
  name: string;
  hint?: string;
  leading?: React.ReactNode;
}

interface Pending {
  key: string;
  name: string;
  preview?: string;
  file?: FileView;
  error?: boolean;
}

export interface ComposerSend {
  content: string;
  attachments: string[];
  mentions: string[];
  quote?: { message_id: string; text: string };
}

const MAX_FILES = 10;

/** The `@word` being typed just before the caret, if any. */
function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(^|\s)@([^\s@]{0,30})$/.exec(before);
  return match ? { start: caret - match[2]!.length - 1, query: match[2]! } : null;
}

export function Composer({
  placeholder,
  working,
  candidates = [],
  mode = 'mention',
  target,
  onTarget,
  quote,
  onClearQuote,
  conversationId,
  autoFocus = true,
  onSend,
  onStop,
}: {
  placeholder: string;
  working: boolean;
  candidates?: Candidate[];
  /** mention: `@` adds a mention. switch: `@` picks who answers (a new chat). */
  mode?: 'mention' | 'switch';
  target?: Candidate | null;
  onTarget?: (candidate: Candidate | null) => void;
  quote?: { message_id: string; text: string } | null;
  onClearQuote?: () => void;
  conversationId?: string;
  autoFocus?: boolean;
  onSend: (input: ComposerSend) => Promise<unknown>;
  onStop: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [mentions, setMentions] = useState<Candidate[]>([]);
  const [picker, setPicker] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (autoFocus) textarea.current?.focus();
  }, [autoFocus, conversationId]);

  useEffect(() => {
    if (quote) textarea.current?.focus();
  }, [quote]);

  // Grow with the text up to 40% of the window, then scroll inside.
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [value]);

  const options = useMemo(() => {
    if (!picker) return [];
    const query = picker.query.toLowerCase();
    return candidates.filter((candidate) => candidate.name.toLowerCase().includes(query)).slice(0, 8);
  }, [picker, candidates]);

  const uploading = files.some((file) => !file.file && !file.error);
  const ready = files.filter((file) => file.file);
  const canSend = !sending && !uploading && (value.trim().length > 0 || ready.length > 0);

  const upload = (list: File[]) => {
    const room = MAX_FILES - files.length;
    for (const raw of list.slice(0, room)) {
      const key = `${raw.name}-${raw.size}-${Math.random()}`;
      const preview = raw.type.startsWith('image/') ? URL.createObjectURL(raw) : undefined;
      setFiles((current) => [...current, { key, name: raw.name, preview }]);
      api.files
        .upload(raw, { purpose: 'attachment', conversation_id: conversationId })
        .then((file) => setFiles((current) => current.map((item) => (item.key === key ? { ...item, file } : item))))
        .catch(() =>
          setFiles((current) => current.map((item) => (item.key === key ? { ...item, error: true } : item))),
        );
    }
  };

  const remove = (key: string) =>
    setFiles((current) => {
      const item = current.find((entry) => entry.key === key);
      if (item?.preview) URL.revokeObjectURL(item.preview);
      return current.filter((entry) => entry.key !== key);
    });

  const pick = (candidate: Candidate) => {
    if (!picker) return;
    const end = picker.start + 1 + picker.query.length;
    if (mode === 'switch') {
      onTarget?.(candidate);
      setValue(value.slice(0, picker.start) + value.slice(end));
    } else {
      const insert = `@${candidate.name} `;
      setValue(value.slice(0, picker.start) + insert + value.slice(end));
      setMentions((current) =>
        current.some((item) => item.handle === candidate.handle) ? current : [...current, candidate],
      );
    }
    setPicker(null);
    requestAnimationFrame(() => textarea.current?.focus());
  };

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    // Only mentions still named in the text count.
    const named = mentions.filter((candidate) => value.includes(`@${candidate.name}`)).map((item) => item.handle);
    try {
      await onSend({
        content: value.trim(),
        attachments: ready.map((item) => item.file!.id),
        mentions: named,
        ...(quote ? { quote } : {}),
      });
      for (const item of files) if (item.preview) URL.revokeObjectURL(item.preview);
      setValue('');
      setFiles([]);
      setMentions([]);
      onClearQuote?.();
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (picker && options.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pick(options[Math.min(active, options.length - 1)]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setPicker(null);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void send();
    }
  };

  const onPaste = (event: ClipboardEvent) => {
    const pasted = [...event.clipboardData.files];
    if (pasted.length) {
      event.preventDefault();
      upload(pasted);
    }
  };

  const onDrop = (event: DragEvent) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    upload([...event.dataTransfer.files]);
  };

  const showStop = working && !value.trim() && !ready.length;

  return (
    <div className="app-composer-zone">
      <div
        className="app-composer"
        onDragOver={(event) => event.dataTransfer.types.includes('Files') && event.preventDefault()}
        onDrop={onDrop}
      >
        {(quote || target) && (
          <div className="app-composer-chips">
            {target && (
              <span className="app-chip">
                {target.leading}
                {t('composer.to', { name: target.name })}
                {onTarget && (
                  <button type="button" aria-label={t('composer.clearTarget')} onClick={() => onTarget(null)}>
                    <X size={icon.sm} />
                  </button>
                )}
              </span>
            )}
            {quote && (
              <span className="app-chip is-quote">
                <span className="app-chip-text">{quote.text}</span>
                <button type="button" aria-label={t('composer.clearQuote')} onClick={onClearQuote}>
                  <X size={icon.sm} />
                </button>
              </span>
            )}
          </div>
        )}
        {files.length > 0 && (
          <ul className="app-attachments" aria-label={t('composer.attachments')}>
            {files.map((item) => (
              <li key={item.key} className={cx('app-attachment', item.error && 'is-error')}>
                {item.preview ? <img src={item.preview} alt="" /> : <FileText size={icon.md} />}
                <span className="app-attachment-name">
                  {item.error ? t('composer.uploadFailed', { name: item.name }) : item.name}
                </span>
                {!item.file && !item.error && <Spinner size={icon.sm} />}
                <button
                  type="button"
                  aria-label={t('composer.removeFile', { name: item.name })}
                  onClick={() => remove(item.key)}
                >
                  <X size={icon.sm} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textarea}
          className="app-composer-input"
          rows={1}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          role={picker ? 'combobox' : undefined}
          aria-expanded={picker ? options.length > 0 : undefined}
          aria-controls={picker ? listId : undefined}
          aria-autocomplete={picker ? 'list' : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            const next = mentionAt(event.target.value, event.target.selectionStart);
            setPicker(candidates.length ? next : null);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => setTimeout(() => setPicker(null), 150)}
        />
        {picker && options.length > 0 && (
          <ul className="app-mention-list" id={listId} role="listbox" aria-label={t('composer.mention')}>
            {options.map((candidate, index) => (
              <li
                key={candidate.handle}
                role="option"
                aria-selected={index === active}
                className={cx('app-mention-option', index === active && 'is-active')}
                onPointerDown={(event) => {
                  event.preventDefault();
                  pick(candidate);
                }}
              >
                {candidate.leading}
                <span>{candidate.name}</span>
                {candidate.hint && <span className="app-mention-hint">{candidate.hint}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="app-composer-tools">
          <IconButton
            label={t('composer.attach')}
            onClick={() => fileInput.current?.click()}
            disabled={files.length >= MAX_FILES}
          >
            <Paperclip size={icon.md} />
          </IconButton>
          {candidates.length > 0 && (
            <IconButton
              label={mode === 'switch' ? t('composer.pickAgent') : t('composer.mention')}
              onClick={() => {
                const element = textarea.current;
                if (!element) return;
                const caret = element.selectionStart ?? value.length;
                const needsSpace = caret > 0 && !/\s/.test(value[caret - 1] ?? '');
                const next = `${value.slice(0, caret)}${needsSpace ? ' ' : ''}@${value.slice(caret)}`;
                setValue(next);
                setPicker({ start: caret + (needsSpace ? 1 : 0), query: '' });
                setActive(0);
                requestAnimationFrame(() => {
                  element.focus();
                  const position = caret + (needsSpace ? 2 : 1);
                  element.setSelectionRange(position, position);
                });
              }}
            >
              <AtSign size={icon.md} />
            </IconButton>
          )}
          <span className="app-composer-spacer" />
          {showStop ? (
            <IconButton label={t('composer.stop')} className="app-send is-stop" onClick={onStop}>
              <Square size={icon.sm} fill="currentColor" />
            </IconButton>
          ) : (
            <IconButton
              label={t('composer.send')}
              className="app-send"
              disabled={!canSend}
              disabledReason={uploading ? t('composer.waitUploads') : undefined}
              onClick={() => void send()}
            >
              {sending ? <Spinner size={icon.md} /> : <ArrowUp size={icon.md} strokeWidth={2} />}
            </IconButton>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            upload([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
