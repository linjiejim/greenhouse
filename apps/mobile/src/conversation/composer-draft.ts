/** Failed sends restore beside new input; a newer quote or skill remains the active choice. No React. */
import type { Skill } from '../shared/contract';
import type { ComposerFile } from '../chat/composer-files';
import type { MentionCandidate } from './picker';

export interface ComposerContent {
  value: string;
  quote: { message_id: string; text: string } | null;
  skill: Skill | null;
  fields: Record<string, string>;
  picked: MentionCandidate[];
}

export interface ComposerDraft extends ComposerContent {
  files: ComposerFile[];
}

export function emptyComposerContent(): ComposerContent {
  return { value: '', quote: null, skill: null, fields: {}, picked: [] };
}

/** Text is kept in send order; skill and its variables always come from the same draft. */
export function restoreComposerContent(current: ComposerContent, failed: ComposerContent): ComposerContent {
  return {
    value: [failed.value, current.value].filter(Boolean).join('\n'),
    quote: current.quote ?? failed.quote,
    skill: current.skill ?? failed.skill,
    fields: current.skill ? current.fields : failed.skill ? failed.fields : current.fields,
    picked: [...new Map([...failed.picked, ...current.picked].map((item) => [item.handle, item])).values()],
  };
}

/** Retain in-flight uploads and the current status of any file already in the composer. */
export function restoreComposerFiles(current: ComposerFile[], failed: ComposerFile[]): ComposerFile[] {
  return [...new Map([...failed, ...current].map((item) => [item.id, item])).values()];
}
