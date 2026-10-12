/** Sheet results travel through a bounded, memory-only store, never route callbacks. */
import { create } from 'zustand';
import type { Answers, AskUserData } from './ask-user-model';

export interface AskForm {
  data: AskUserData;
  answers: Answers;
  status: 'editing' | 'queued' | 'sending' | 'sent' | 'failed';
  message?: string;
  readOnly: boolean;
}
let serial = 0;
export const askFormKey = () => `ask_${++serial}`;
export const useAskForms = create<{
  forms: Record<string, AskForm>;
  open(key: string, data: AskUserData, readOnly: boolean): void;
  patch(key: string, patch: Partial<AskForm>): void;
  remove(key: string): void;
}>((set) => ({
  forms: {},
  open: (key, data, readOnly) =>
    set((s) => {
      if (s.forms[key]) return s;
      const entries = Object.entries(s.forms).slice(-29);
      return { forms: { ...Object.fromEntries(entries), [key]: { data, answers: {}, status: 'editing', readOnly } } };
    }),
  patch: (key, patch) =>
    set((s) => (s.forms[key] ? { forms: { ...s.forms, [key]: { ...s.forms[key], ...patch } } } : s)),
  remove: (key) =>
    set((s) => {
      const forms = { ...s.forms };
      delete forms[key];
      return { forms };
    }),
}));
