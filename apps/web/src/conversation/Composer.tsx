/**
 * The composer (conversation.md, 输入框): grows with its text, Enter sends and Shift Enter breaks
 * the line (never while an input method is composing). Attachments upload at once and show as
 * pills; sending waits for them. `@` names someone in a room, or picks the Agent of a new chat.
 * Send and stop share one place: while an Agent answers, an empty composer offers stop and a
 * filled one sends into the queue. `/` at the start picks a skill (CONV-11); its fields, if it has
 * any, show above the text and the first one takes the focus. The microphone (CONV-12) records
 * while the composer shows the levels and a timer; the words land where the caret was, never sent
 * by themselves.
 */

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { ArrowUp, AtSign, FileText, Mic, Paperclip, Square, Wand2, X } from 'lucide-react';
import { Button, Field, FieldGroup, IconButton, Input, Select, Spinner } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { FileView, Skill } from '@greenhouse/contract';
import { useSession } from '../app/session';
import { api } from '../lib/api';
import { cx } from '../lib/cx';
import { errorText } from '../lib/errors';
import { useI18n } from '../lib/i18n';
import { useVoiceInput, voiceMode, type VoiceFailure } from './voiceInput';

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
  /** A skill run with `/`, with its fields filled in. */
  skill?: { skill_id: string; variables: Record<string, string> };
}

const MAX_FILES = 10;

/** The `@word` being typed just before the caret, if any. */
function mentionAt(value: string, caret: number): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /(^|\s)@([^\s@]{0,30})$/.exec(before);
  return match ? { start: caret - match[2]!.length - 1, query: match[2]! } : null;
}

/** A space between spoken words and the text around them only where both sides are Latin words. */
const spaced = (before: string, after: string) => /[A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9]/.test(after);

/** 0:07, 1:23: the time spent listening. */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** The `/word` being typed at the very start of the message, if any. */
function slashAt(value: string, caret: number): string | null {
  const match = /^\/([^\s/]{0,40})$/.exec(value.slice(0, caret));
  return match ? match[1]! : null;
}

/** One row of the open list: a person or Agent for `@`, a skill for `/`. */
interface Entry {
  key: string;
  label: string;
  hint?: string;
  leading?: React.ReactNode;
  disabled?: boolean;
  choose: () => void;
}

export function Composer({
  placeholder,
  working,
  candidates = [],
  mentionable = candidates.length > 0,
  mode = 'mention',
  target,
  onTarget,
  quote,
  onClearQuote,
  conversationId,
  autoFocus = true,
  seed,
  skills = [],
  initialSkill,
  onSend,
  onStop,
}: {
  placeholder: string;
  working: boolean;
  candidates?: Candidate[];
  /** `@` opens the picker (rooms, a new chat), even before the candidates have loaded. */
  mentionable?: boolean;
  /** mention: `@` adds a mention. switch: `@` picks who answers (a new chat). */
  mode?: 'mention' | 'switch';
  target?: Candidate | null;
  onTarget?: (candidate: Candidate | null) => void;
  quote?: { message_id: string; text: string } | null;
  onClearQuote?: () => void;
  conversationId?: string;
  autoFocus?: boolean;
  /** Text put in from outside (a starter); a new object each time. */
  seed?: { text: string };
  /** Skills `/` offers, judged for the Agent that answers; without any, `/` is plain text. */
  skills?: Skill[];
  /** A skill chosen from outside (its page's 在对话里使用), once it is in `skills`. */
  initialSkill?: string;
  onSend: (input: ComposerSend) => Promise<unknown>;
  onStop: () => void;
}) {
  const { t, locale } = useI18n();
  const { me } = useSession();
  const [value, setValue] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [mentions, setMentions] = useState<Candidate[]>([]);
  const [picker, setPicker] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [slash, setSlash] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Skill | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [fieldError, setFieldError] = useState('');
  /** Why the microphone stopped short, shown in the composer until the next try or keystroke. */
  const [voiceError, setVoiceError] = useState('');
  /** Where the caret was when listening started: the words land there. */
  const spokenAt = useRef<number | null>(null);
  /** The caret after the words landed, put back once the text is on screen. */
  const caretAfter = useRef<number | null>(null);
  const stt = !!me?.capabilities.stt;
  const microphone = useMemo(() => voiceMode(stt), [stt]);
  const voice = useVoiceInput({
    mode: microphone,
    locale,
    onText: (spoken) => {
      const at = Math.min(spokenAt.current ?? value.length, value.length);
      const before = value.slice(0, at);
      const after = value.slice(at);
      const lead = spaced(before, spoken) ? ' ' : '';
      const trail = spaced(spoken, after) ? ' ' : '';
      setValue(`${before}${lead}${spoken}${trail}${after}`);
      caretAfter.current = at + lead.length + spoken.length;
    },
    onError: (failure: VoiceFailure | Error) =>
      setVoiceError(
        failure instanceof Error
          ? t('composer.voiceFailed', { reason: errorText(failure, t) })
          : failure === 'denied'
            ? t('composer.voiceDenied')
            : failure === 'no-mic'
              ? t('composer.voiceNoMic')
              : failure === 'nothing-heard'
                ? t('composer.voiceNothing')
                : t('composer.voiceFailed', { reason: t('common.error') }),
      ),
  });
  const listening = voice.phase === 'listening';
  const voiceBusy = voice.phase !== 'idle';
  useLayoutEffect(() => {
    const caret = caretAfter.current;
    if (caret === null || voiceBusy) return;
    caretAfter.current = null;
    textarea.current?.focus();
    textarea.current?.setSelectionRange(caret, caret);
  }, [value, voiceBusy]);
  // Esc cancels listening (and a transcription on its way), before anything around it closes.
  const cancelVoice = voice.cancel;
  useEffect(() => {
    if (!voiceBusy) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      cancelVoice();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [voiceBusy, cancelVoice]);
  const startVoice = () => {
    spokenAt.current = textarea.current?.selectionStart ?? value.length;
    setVoiceError('');
    voice.start();
  };
  const fieldsBox = useRef<HTMLDivElement>(null);

  const choose = (skill: Skill) => {
    setChosen(skill);
    setFields(Object.fromEntries(skill.variables.map((field) => [field.key, ''])));
    setFieldError('');
    setValue((current) => current.replace(/^\/\S*\s?/, ''));
    setSlash(null);
    requestAnimationFrame(() => {
      const first = fieldsBox.current?.querySelector<HTMLElement>('input, button');
      (first ?? textarea.current)?.focus();
    });
  };

  // A skill chosen from outside, as soon as the list has it.
  const startedWith = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialSkill || startedWith.current === initialSkill) return;
    const skill = skills.find((item) => item.id === initialSkill);
    if (!skill) return;
    startedWith.current = initialSkill;
    choose(skill);
  }, [initialSkill, skills]);

  useEffect(() => {
    if (autoFocus) textarea.current?.focus();
  }, [autoFocus, conversationId]);

  useEffect(() => {
    if (quote) textarea.current?.focus();
  }, [quote]);

  useEffect(() => {
    if (!seed) return;
    setValue(seed.text);
    textarea.current?.focus();
  }, [seed]);

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

  const entries: Entry[] = useMemo(() => {
    if (slash !== null) {
      const query = slash.toLowerCase();
      return skills
        .filter((skill) => skill.name.includes(query) || (skill.display_name || '').toLowerCase().includes(query))
        .slice(0, 8)
        .map((skill) => ({
          key: skill.id,
          label: `/${skill.name}`,
          hint: skill.available ? skill.display_name || skill.description : (skill.unavailable?.message ?? ''),
          leading: <Wand2 size={icon.sm} aria-hidden />,
          disabled: !skill.available,
          choose: () => choose(skill),
        }));
    }
    return options.map((candidate) => ({
      key: candidate.handle,
      label: candidate.name,
      hint: candidate.hint,
      leading: candidate.leading,
      choose: () => pick(candidate),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- choose and pick read this render's state
  }, [slash, skills, options]);
  const listOpen = (slash !== null || !!picker) && entries.length > 0;

  const uploading = files.some((file) => !file.file && !file.error);
  const ready = files.filter((file) => file.file);
  const canSend = !sending && !uploading && (value.trim().length > 0 || ready.length > 0 || !!chosen);
  /** Sending was asked for while files were still uploading: it goes once they are up. */
  const [queued, setQueued] = useState(false);

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
    if (!sending && uploading) return setQueued(true);
    if (!canSend) return;
    const missing = chosen?.variables.find((field) => field.required !== false && !fields[field.key]?.trim());
    if (missing) {
      setFieldError(t('request.required', { name: missing.label }));
      return;
    }
    setSending(true);
    // Only mentions still named in the text count.
    const named = mentions.filter((candidate) => value.includes(`@${candidate.name}`)).map((item) => item.handle);
    try {
      await onSend({
        content: value.trim(),
        attachments: ready.map((item) => item.file!.id),
        mentions: named,
        ...(quote ? { quote } : {}),
        ...(chosen ? { skill: { skill_id: chosen.id, variables: fields } } : {}),
      });
      for (const item of files) if (item.preview) URL.revokeObjectURL(item.preview);
      setValue('');
      setFiles([]);
      setMentions([]);
      setChosen(null);
      setFields({});
      onClearQuote?.();
    } catch {
      // The page said why; the text stays here to send again.
    } finally {
      setSending(false);
      textarea.current?.focus();
    }
  };

  const latestSend = useRef(send);
  latestSend.current = send;
  useEffect(() => {
    if (!queued || uploading) return;
    setQueued(false);
    // A file that failed waits for the member to remove or re-add it.
    if (!files.some((file) => file.error)) void latestSend.current();
  }, [queued, uploading, files]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (listOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((index) => (index + (event.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const entry = entries[Math.min(active, entries.length - 1)]!;
        if (!entry.disabled) entry.choose();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setPicker(null);
        setSlash(null);
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
        {(quote || target || chosen) && (
          <div className="app-composer-chips">
            {chosen && (
              <span className="app-chip is-skill">
                <Wand2 size={icon.sm} aria-hidden />
                <span className="app-chip-text">
                  /{chosen.name}
                  {chosen.display_name && chosen.display_name !== chosen.name ? ` · ${chosen.display_name}` : ''}
                </span>
                <button
                  type="button"
                  aria-label={t('composer.clearSkill')}
                  onClick={() => {
                    setChosen(null);
                    setFields({});
                    textarea.current?.focus();
                  }}
                >
                  <X size={icon.sm} />
                </button>
              </span>
            )}
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
        {chosen && chosen.variables.length > 0 && (
          <div className="app-composer-fields" ref={fieldsBox}>
            {chosen.variables.map((field) => {
              const FormField = field.type === 'choice' && field.options?.length ? FieldGroup : Field;
              return (
                <FormField key={field.key} label={field.label} required={field.required !== false}>
                  {field.type === 'choice' && field.options?.length ? (
                    <Select
                      label={field.label}
                      value={fields[field.key] ?? ''}
                      options={field.options.map((option) => ({ value: option, label: option }))}
                      onChange={(next: string) => {
                        setFields({ ...fields, [field.key]: next });
                        setFieldError('');
                      }}
                    />
                  ) : (
                    <Input
                      value={fields[field.key] ?? ''}
                      onChange={(event) => {
                        setFields({ ...fields, [field.key]: event.target.value });
                        setFieldError('');
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                          event.preventDefault();
                          void send();
                        }
                      }}
                    />
                  )}
                </FormField>
              );
            })}
            {fieldError && (
              <p className="app-request-error" role="alert">
                {fieldError}
              </p>
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
        {voiceBusy && (
          <div className="app-recording">
            {voice.phase === 'transcribing' ? (
              <Spinner size={icon.sm} />
            ) : (
              <>
                <span className="app-recording-dot" aria-hidden />
                <span className="app-recording-bars" aria-hidden>
                  {voice.levels.map((level, index) => (
                    <i key={index} style={{ '--level': level } as CSSProperties} />
                  ))}
                </span>
                <span className="app-recording-time" aria-hidden>
                  {clock(voice.seconds)}
                </span>
              </>
            )}
            <span className="app-recording-text" role="status">
              {voice.phase === 'transcribing'
                ? t('composer.voiceTranscribing')
                : voice.heard || `${t('composer.voiceListening')} ${t('composer.voiceHint')}`}
            </span>
            <Button kind="ghost" size="sm" onClick={voice.cancel}>
              {t('common.cancel')}
            </Button>
          </div>
        )}
        {voiceError && !voiceBusy && (
          <p className="app-request-error" role="alert">
            {voiceError}
          </p>
        )}
        <textarea
          ref={textarea}
          className="app-composer-input"
          hidden={voiceBusy}
          rows={1}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          role={picker || slash !== null ? 'combobox' : undefined}
          aria-expanded={picker || slash !== null ? listOpen : undefined}
          aria-controls={picker || slash !== null ? listId : undefined}
          aria-autocomplete={picker || slash !== null ? 'list' : undefined}
          onChange={(event) => {
            const next = event.target.value;
            const caret = event.target.selectionStart;
            setValue(next);
            setVoiceError('');
            const skill = skills.length && !chosen ? slashAt(next, caret) : null;
            setSlash(skill);
            // Kept even while the candidates load: the list appears once they are there.
            setPicker(skill === null && mentionable ? mentionAt(next, caret) : null);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() =>
            setTimeout(() => {
              setPicker(null);
              setSlash(null);
            }, 150)
          }
        />
        {listOpen && (
          <ul
            className="app-mention-list"
            id={listId}
            role="listbox"
            aria-label={slash !== null ? t('composer.skills') : t('composer.mention')}
          >
            {entries.map((entry, index) => (
              <li
                key={entry.key}
                role="option"
                aria-selected={index === active}
                aria-disabled={entry.disabled || undefined}
                className={cx('app-mention-option', index === active && 'is-active', entry.disabled && 'is-disabled')}
                onPointerDown={(event) => {
                  event.preventDefault();
                  if (!entry.disabled) entry.choose();
                }}
              >
                {entry.leading}
                <span>{entry.label}</span>
                {entry.hint && <span className="app-mention-hint">{entry.hint}</span>}
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
          {mentionable && (
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
          {microphone && (
            <IconButton
              label={listening ? t('composer.voiceFinish') : t('composer.voice')}
              aria-pressed={listening}
              className={cx('app-mic', listening && 'is-on')}
              disabled={voice.phase === 'starting' || voice.phase === 'transcribing'}
              onClick={() => (listening ? voice.finish() : startVoice())}
            >
              <Mic size={icon.md} />
            </IconButton>
          )}
          {showStop ? (
            <IconButton label={t('composer.stop')} className="app-send is-stop" onClick={onStop}>
              <Square size={icon.sm} fill="currentColor" />
            </IconButton>
          ) : (
            <IconButton
              label={t('composer.send')}
              className="app-send"
              disabled={voiceBusy || (!canSend && !(uploading && !queued))}
              onClick={() => void send()}
            >
              {sending || queued ? <Spinner size={icon.md} /> : <ArrowUp size={icon.md} strokeWidth={2} />}
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
