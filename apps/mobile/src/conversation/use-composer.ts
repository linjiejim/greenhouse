/**
 * Everything the composer holds before a send, for a conversation or a new chat: the text and
 * where its caret is, the files (./../chat/use-composer-files.ts), the quoted piece, the
 * skill chosen with `/` and its fields, and the people or Agents named with `@`.
 *
 * `picker` is what to offer above the input right now (./picker.ts): `@` candidates or skills.
 * `build()` turns it all into the API's message (`SendMessageInput`), or the reason it cannot go
 * yet (a required field of the skill is empty). `take()` empties the composer and hands back a
 * draft that `restore()` puts back when the send fails.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import type { SendMessageInput, Skill } from '../shared/contract';
import { filesReady, type ComposerFile } from '../chat/composer-files';
import { useComposerFiles } from '../chat/use-composer-files';
import {
  applyMention,
  dropSlash,
  dropToken,
  matching,
  mentionQuery,
  namedMentions,
  slashQuery,
  type MentionCandidate,
} from './picker';

export type PickerEntry =
  | { kind: 'mention'; key: string; candidate: MentionCandidate }
  | { kind: 'skill'; key: string; skill: Skill };

export interface ComposerDraft {
  value: string;
  files: ComposerFile[];
  quote: { message_id: string; text: string } | null;
  skill: Skill | null;
  fields: Record<string, string>;
  picked: MentionCandidate[];
}

export function useComposer({
  conversationId,
  candidates,
  mentionMode,
  onSwitch,
  skills,
}: {
  conversationId: string | null;
  candidates: readonly MentionCandidate[];
  /** mention: `@` names someone (a room); switch: `@` picks who answers (a new chat); off: plain text. */
  mentionMode: 'mention' | 'switch' | 'off';
  onSwitch?: (candidate: MentionCandidate) => void;
  /** What `/` offers (judged for the Agent that answers); empty: `/` is plain text. */
  skills: readonly Skill[];
}) {
  const inputRef = useRef<TextInput>(null);
  const [value, setValue] = useState('');
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const files = useComposerFiles(conversationId);
  const [quote, setQuote] = useState<{ message_id: string; text: string } | null>(null);
  const [skill, setSkill] = useState<Skill | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<MentionCandidate[]>([]);

  /** The skill list was opened from the `+` menu (no `/` typed). */
  const [listing, setListing] = useState(false);

  // A collapsed caret only — a range selection is editing, not naming.
  const caret = selection && selection.start === selection.end ? selection.start : null;
  const mention = mentionMode !== 'off' && caret !== null ? mentionQuery(value, caret) : null;
  const typed = skills.length && !skill && caret !== null ? slashQuery(value, caret) : null;
  const slash = typed ?? (listing && !skill ? '' : null);

  const picker = useMemo<PickerEntry[]>(() => {
    if (slash !== null) {
      const list = skills.map((item) => ({ item, name: item.name, hint: item.display_name }));
      return matching(list, slash, 12).map(({ item }) => ({ kind: 'skill', key: item.id, skill: item }));
    }
    if (mention) {
      return matching(candidates, mention.query).map((candidate) => ({
        kind: 'mention',
        key: candidate.handle,
        candidate,
      }));
    }
    return [];
  }, [slash, mention, skills, candidates]);

  const focus = useCallback(() => setTimeout(() => inputRef.current?.focus(), 250), []);

  const chooseSkill = useCallback((next: Skill) => {
    setSkill(next);
    setListing(false);
    setFields(Object.fromEntries(next.variables.map((field) => [field.key, ''])));
    setValue((current) => (current.startsWith('/') ? dropSlash(current) : current));
  }, []);

  const pick = useCallback(
    (entry: PickerEntry) => {
      if (entry.kind === 'skill') {
        chooseSkill(entry.skill);
        return;
      }
      if (!mention || caret === null) return;
      if (mentionMode === 'switch') {
        onSwitch?.(entry.candidate);
        setValue(dropToken(value, mention.start, caret));
        return;
      }
      const next = applyMention(value, mention.start, caret, entry.candidate.name);
      setValue(next.text);
      setSelection({ start: next.caret, end: next.caret });
      setPicked((current) =>
        current.some((item) => item.handle === entry.candidate.handle) ? current : [...current, entry.candidate],
      );
    },
    [chooseSkill, mention, caret, mentionMode, onSwitch, value],
  );

  /** Start an `@` at the caret (the `+` menu's 「@ 提及」). */
  const startMention = useCallback(() => {
    const at = caret ?? value.length;
    const needsSpace = at > 0 && !/\s/.test(value[at - 1] ?? '');
    const next = `${value.slice(0, at)}${needsSpace ? ' ' : ''}@${value.slice(at)}`;
    setValue(next);
    const position = at + (needsSpace ? 2 : 1);
    setSelection({ start: position, end: position });
    focus();
  }, [caret, value, focus]);

  /** Open the skill list (the `+` menu's 「技能」), whatever is typed. */
  const startSkill = useCallback(() => {
    setListing(true);
    focus();
  }, [focus]);

  /** Close the skill list without choosing. */
  const closePicker = useCallback(() => setListing(false), []);

  const setField = useCallback((key: string, text: string) => setFields((current) => ({ ...current, [key]: text })), []);
  const clearSkill = useCallback(() => {
    setSkill(null);
    setFields({});
  }, []);

  /** The message to send, or why it cannot go yet (the label of an empty required field). */
  const build = useCallback((): { input: SendMessageInput } | { missing: string } | null => {
    if (!filesReady(files.files)) return null;
    const text = value.trim();
    if (!text && !files.files.length && !skill) return null;
    const missing = skill?.variables.find((field) => field.required !== false && !fields[field.key]?.trim());
    if (missing) return { missing: missing.label };
    return {
      input: {
        content: text,
        attachments: files.files.map((file) => file.remote!.id),
        mentions: mentionMode === 'mention' ? namedMentions(text, picked) : [],
        ...(quote ? { quote } : {}),
        ...(skill ? { skill: { skill_id: skill.id, variables: fields } } : {}),
      },
    };
  }, [files.files, value, skill, fields, mentionMode, picked, quote]);

  const { setFiles } = files;
  /** Empty the composer, handing back what was in it. */
  const take = useCallback((): ComposerDraft => {
    const draft: ComposerDraft = { value, files: files.files, quote, skill, fields, picked };
    setValue('');
    // Clear natively too: a multiline field emptied only through `value` keeps its grown height on iOS.
    inputRef.current?.clear();
    setFiles([]);
    setQuote(null);
    setSkill(null);
    setFields({});
    setPicked([]);
    return draft;
  }, [value, files.files, quote, skill, fields, picked, setFiles]);

  const restore = useCallback(
    (draft: ComposerDraft) => {
      setValue(draft.value);
      setFiles(draft.files);
      setQuote(draft.quote);
      setSkill(draft.skill);
      setFields(draft.fields);
      setPicked(draft.picked);
    },
    [setFiles],
  );

  return {
    inputRef,
    value,
    setValue,
    onSelectionChange: setSelection,
    files: files.files,
    attach: files.attach,
    removeFile: files.remove,
    retryFiles: files.retry,
    quote,
    setQuote,
    skill,
    chooseSkill,
    clearSkill,
    fields,
    setField,
    picker,
    pickerKind: slash !== null ? ('skill' as const) : mention ? ('mention' as const) : null,
    pick,
    startMention,
    startSkill,
    closePicker,
    build,
    take,
    restore,
    focus,
  };
}

export type ComposerController = ReturnType<typeof useComposer>;
