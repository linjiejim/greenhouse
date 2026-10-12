/** Shared question shape and wire format; no native imports. */
export interface QuestionOption {
  value: string;
  label: string;
}

export interface Question {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'single_choice' | 'multi_choice';
  options?: QuestionOption[];
  required?: boolean;
  placeholder?: string;
}

export interface AskUserData {
  type: 'ask_user';
  status?: string;
  title?: string;
  description?: string;
  questions: Question[];
}

const TYPES = new Set(['text', 'textarea', 'single_choice', 'multi_choice']);

/** The form shape, from any tool (checked loosely: a model-authored payload). */
export function isAskUserData(v: unknown): v is AskUserData {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    o.type === 'ask_user' &&
    Array.isArray(o.questions) &&
    o.questions.length > 0 &&
    o.questions.every(
      (q) =>
        !!q &&
        typeof q === 'object' &&
        typeof (q as Question).label === 'string' &&
        TYPES.has((q as Question).type) &&
        ((q as Question).options === undefined || Array.isArray((q as Question).options)),
    )
  );
}

export type Answers = Record<string, string | string[]>;

export const keyOf = (q: Question, i: number) => q.id || `q${i}`;
export const isChoice = (q: Question) => q.type === 'single_choice' || q.type === 'multi_choice';

/** A pick as the model reads it (see file header). */
function formatChoice(opt: QuestionOption | undefined, raw: string): string {
  if (!opt) return raw;
  return opt.value.toLowerCase() === opt.label.toLowerCase() ? opt.label : `${opt.label} (${opt.value})`;
}

const NOT_ANSWERED = '(not answered)';

/** The message the answers go out as (web: AskUserCard.handleSubmit). */
export function formatAnswers(questions: Question[], answers: Answers): string {
  const lines = ['Here are my answers to your questions:', ''];
  questions.forEach((q, idx) => {
    const a = answers[keyOf(q, idx)];
    let shown: string;
    if (Array.isArray(a)) {
      shown = a.length
        ? a
            .map((v) =>
              formatChoice(
                q.options?.find((o) => o.value === v),
                v,
              ),
            )
            .join(', ')
        : NOT_ANSWERED;
    } else if (q.type === 'single_choice') {
      shown = a
        ? formatChoice(
            q.options?.find((o) => o.value === a),
            a,
          )
        : NOT_ANSWERED;
    } else {
      shown = (a ?? '').trim() || NOT_ANSWERED;
    }
    lines.push(`**${idx + 1}. ${q.label}**: ${shown}`);
  });
  return lines.join('\n');
}

/** Answers read back from a posted message, by question number (picks shown by label). */
export function parseAnswers(questions: Question[], message: string | undefined): Map<number, string> {
  const out = new Map<number, string>();
  if (!message) return out;
  for (const m of message.matchAll(/\*\*(\d+)\.\s+.+?\*\*:\s*(.+?)(?=\n|$)/g)) {
    const n = Number(m[1]);
    let answer = m[2].trim();
    for (const o of questions[n - 1]?.options ?? []) answer = answer.split(`${o.label} (${o.value})`).join(o.label);
    out.set(n, answer);
  }
  return out;
}

export function canSubmitAnswers(questions: Question[], answers: Answers): boolean {
  return questions.every((q, i) => {
    if (q.required === false) return true;
    const a = answers[keyOf(q, i)];
    if (q.type === 'multi_choice') return Array.isArray(a) && a.some((v) => q.options?.some((o) => o.value === v));
    if (q.type === 'single_choice') return typeof a === 'string' && !!q.options?.some((o) => o.value === a);
    return typeof a === 'string' && !!a.trim();
  });
}
