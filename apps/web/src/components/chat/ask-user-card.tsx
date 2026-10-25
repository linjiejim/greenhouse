/**
 * AskUserCard — interactive question form rendered from ask_user tool results.
 *
 * Renders structured questions (text, textarea, single_choice, multi_choice) as
 * an interactive form card inside the chat message. On submit, formats answers
 * into a structured user message and fires onSubmit.
 *
 * Only rendered on the COMMITTED message bubble — never in the streaming overlay
 * (see body-artifacts `ctx.streaming`), so its local answer state can't be wiped
 * by the overlay→committed remount that happens when a turn finishes.
 */

import React, { useState, useCallback, useRef } from 'react';
import { Button } from '../ui';
import { Check, ClipboardList, Send } from '../../lib/icons';
import { Markdown } from '../markdown';
import { useT } from '../../lib/i18n';
import { ArtifactCard, ArtifactCardActions } from './artifact-card';

// ─── Types ───────────────────────────────────────────────

interface QuestionOption {
  value: string;
  label: string;
}

interface Question {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'single_choice' | 'multi_choice';
  options?: QuestionOption[];
  required?: boolean;
  placeholder?: string;
}

export interface AskUserData {
  type: 'ask_user';
  status: string;
  title: string;
  description?: string;
  questions: Question[];
}

interface AskUserCardProps {
  data: AskUserData;
  onSubmit: (message: string) => void;
  /** Whether this form was already submitted (has follow-up user message) */
  submitted?: boolean;
  /** Persisted formatted follow-up message, available after a session reload. */
  submittedMessage?: string;
}

// ─── Component ───────────────────────────────────────────

export function AskUserCard({ data, onSubmit, submitted = false, submittedMessage }: AskUserCardProps) {
  const t = useT();
  const { title, description, questions } = data;

  // Answer state: { questionId: answer }
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(() => {
    const initial: Record<string, string | string[]> = {};
    for (const q of questions) {
      if (q.type === 'multi_choice') {
        initial[q.id] = [];
      } else {
        initial[q.id] = '';
      }
    }
    return initial;
  });

  const [localSubmitted, setLocalSubmitted] = useState(false);
  const isSubmitted = submitted || localSubmitted;
  const [expanded, setExpanded] = useState(!isSubmitted);
  const submittingRef = useRef(false);

  // Validation: check all required questions are answered
  const canSubmit = questions.every((q) => {
    if (q.required === false) return true;
    const answer = answers[q.id];
    if (Array.isArray(answer)) return answer.length > 0;
    return (answer as string).trim().length > 0;
  });

  const handleTextChange = useCallback((id: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }, []);

  const handleSingleChoice = useCallback((id: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }, []);

  const handleMultiChoice = useCallback((id: string, value: string) => {
    setAnswers((prev) => {
      const current = (prev[id] as string[]) || [];
      const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
      return { ...prev, [id]: next };
    });
  }, []);

  const handleSubmit = useCallback(() => {
    if (!canSubmit || isSubmitted || submittingRef.current) return;
    submittingRef.current = true;

    // Format answers into a structured user message
    const lines: string[] = ['Here are my answers to your questions:', ''];
    for (let idx = 0; idx < questions.length; idx++) {
      const q = questions[idx];
      const num = idx + 1;
      const answer = answers[q.id];
      let displayAnswer: string;
      if (Array.isArray(answer)) {
        if (answer.length === 0) {
          displayAnswer = '(not answered)';
        } else {
          displayAnswer = answer
            .map((v) =>
              formatChoiceAnswer(
                q.options?.find((o) => o.value === v),
                v,
              ),
            )
            .join(', ');
        }
      } else if (q.type === 'single_choice') {
        const opt = q.options?.find((o) => o.value === answer);
        displayAnswer = answer ? formatChoiceAnswer(opt, answer) : '(not answered)';
      } else {
        displayAnswer = (answer as string).trim() || '(not answered)';
      }
      lines.push(`**${num}. ${q.label}**: ${displayAnswer}`);
    }

    setLocalSubmitted(true);
    setExpanded(false);
    onSubmit(lines.join('\n'));
  }, [canSubmit, isSubmitted, answers, questions, onSubmit]);

  const submittedAnswers = getSubmittedAnswers(questions, answers, submittedMessage);

  return (
    <ArtifactCard
      icon={<ClipboardList size={14} />}
      title={title}
      meta={isSubmitted ? t('chat.askAnsweredCount', { count: submittedAnswers.length }) : description}
      status={
        isSubmitted
          ? { label: t('chat.askSubmitted'), tone: 'success' }
          : { label: t('chat.askNeedsInput'), tone: 'primary' }
      }
      collapsed={isSubmitted && !expanded}
      onToggle={isSubmitted ? () => setExpanded((value) => !value) : undefined}
      tone={isSubmitted ? 'success' : 'accent'}
      footer={
        !isSubmitted ? (
          <ArtifactCardActions hint={t('chat.askRequiredHint')}>
            <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
              <Send size={12} />
              {t('chat.askSubmit')}
            </Button>
          </ArtifactCardActions>
        ) : undefined
      }
    >
      {isSubmitted ? (
        <div className="space-y-1.5">
          {submittedAnswers.map((item, index) => (
            <div key={item.id} className="flex min-w-0 items-start gap-2 text-sm">
              <span className="flex-shrink-0 text-fg-faint">{index + 1}.</span>
              <span className="min-w-0 text-fg-muted">
                <span className="font-medium text-fg-secondary">{item.label}</span>
                <span className="mx-1 text-fg-faint">·</span>
                <span className="break-words">{item.answer}</span>
              </span>
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* Description (rendered as Markdown for formatting) */}
          {description && (
            <div className="max-h-[200px] overflow-y-auto pb-1">
              <Markdown content={description} compact linkTarget="new-window" />
            </div>
          )}

          {/* Questions */}
          <div className={`space-y-5 ${description ? 'pt-3' : ''}`}>
            {questions.map((q, idx) => (
              <QuestionField
                key={q.id}
                question={q}
                index={idx + 1}
                value={answers[q.id]}
                disabled={isSubmitted}
                onTextChange={handleTextChange}
                onSingleChoice={handleSingleChoice}
                onMultiChoice={handleMultiChoice}
              />
            ))}
          </div>
        </>
      )}
    </ArtifactCard>
  );
}

/**
 * A choice answer must carry the option VALUE back to the model, not just the
 * label: tools put machine instructions in values (email_mutation's Send button
 * is `send <draft_token>`). Posting only the label strips the instruction — the
 * model then re-drafts to get a new token, and the second confirm card it
 * produces sits unanswered under the success message, reading as "please
 * confirm again" (seen on dev, 2026-08-12). Values that only restate the label
 * stay as the bare label to keep the posted message readable.
 */
function formatChoiceAnswer(opt: QuestionOption | undefined, rawValue: string): string {
  if (!opt) return rawValue;
  return opt.value.toLowerCase() === opt.label.toLowerCase() ? opt.label : `${opt.label} (${opt.value})`;
}

export function getSubmittedAnswers(
  questions: Question[],
  answers: Record<string, string | string[]>,
  submittedMessage?: string,
): Array<{ id: string; label: string; answer: string }> {
  const persisted = new Map<number, string>();
  if (submittedMessage) {
    for (const match of submittedMessage.matchAll(/\*\*(\d+)\.\s+.+?\*\*:\s*(.+?)(?=\n|$)/g)) {
      persisted.set(Number(match[1]), match[2].trim());
    }
  }

  return questions.map((question, index) => {
    const answer = answers[question.id];
    let localAnswer = '(not answered)';
    if (Array.isArray(answer)) {
      const labels = answer.map((value) => question.options?.find((option) => option.value === value)?.label || value);
      if (labels.length > 0) localAnswer = labels.join(', ');
    } else if (answer?.trim()) {
      localAnswer =
        question.type === 'single_choice'
          ? question.options?.find((option) => option.value === answer)?.label || answer
          : answer.trim();
    }
    return {
      id: question.id,
      label: question.label,
      answer: persisted.get(index + 1) || localAnswer,
    };
  });
}

// ─── Question Field ──────────────────────────────────────

const FIELD_CLASS =
  'w-full rounded-md border border-edge-strong bg-surface-raised px-3 py-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent disabled:opacity-60 disabled:cursor-not-allowed';

/**
 * One choice as a row that stays tidy at 1–3 lines: a modest radius from the scale (never a pill),
 * the indicator pinned to the first line, and selection shown by the subtle accent fill, the
 * accent edge and a check — never by colour alone. Single choice draws a round indicator, multiple
 * choice a square one, so the two read differently before anything is picked.
 */
function ChoiceRow({
  name,
  multiple,
  checked,
  disabled,
  label,
  value,
  onChange,
}: {
  name: string;
  value: string;
  multiple: boolean;
  checked: boolean;
  disabled: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <label
      className={`flex items-start gap-2.5 rounded-md border px-3 py-2 transition-colors ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      } ${
        checked
          ? 'border-primary-edge bg-primary-subtle text-primary-fg-strong'
          : 'border-edge bg-surface-raised text-fg hover:bg-surface-muted'
      }`}
    >
      <input
        type={multiple ? 'checkbox' : 'radio'}
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center border peer-focus-visible:ring-2 peer-focus-visible:ring-accent ${
          multiple ? 'rounded-xs' : 'rounded-full'
        } ${checked ? 'border-accent bg-accent text-on-accent' : 'border-edge-strong bg-surface-raised'}`}
      >
        {checked && <Check size={11} strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1 text-sm leading-5 break-words">{label}</span>
    </label>
  );
}

function QuestionField({
  question,
  index,
  value,
  disabled,
  onTextChange,
  onSingleChoice,
  onMultiChoice,
}: {
  question: Question;
  index: number;
  value: string | string[];
  disabled: boolean;
  onTextChange: (id: string, value: string) => void;
  onSingleChoice: (id: string, value: string) => void;
  onMultiChoice: (id: string, value: string) => void;
}) {
  const t = useT();
  const { id, label, type, options, required, placeholder } = question;
  const isRequired = required !== false;
  const choice = type === 'single_choice' || type === 'multi_choice';
  const labelId = `ask-user-${id}-label`;

  return (
    <div role={choice ? 'group' : undefined} aria-labelledby={choice ? labelId : undefined}>
      {/* The question comes first, then how to answer, then the options. */}
      <div id={labelId} className="mb-2 text-sm font-medium leading-5 text-fg">
        <span className="mr-1 text-fg-faint">{index}.</span>
        {label}
        {!isRequired && <span className="ml-1 font-normal text-fg-faint">{t('chat.optional')}</span>}
      </div>
      {choice && options && (
        <p className="-mt-1 mb-2 text-caption text-fg-muted">
          {type === 'multi_choice' ? t('chat.askChooseAny') : t('chat.askChooseOne')}
        </p>
      )}

      {type === 'text' && (
        <input
          type="text"
          aria-labelledby={labelId}
          value={value as string}
          onChange={(e) => onTextChange(id, e.target.value)}
          placeholder={placeholder || ''}
          disabled={disabled}
          className={FIELD_CLASS}
        />
      )}

      {type === 'textarea' && (
        <textarea
          aria-labelledby={labelId}
          value={value as string}
          onChange={(e) => onTextChange(id, e.target.value)}
          placeholder={placeholder || ''}
          disabled={disabled}
          rows={3}
          className={`${FIELD_CLASS} resize-none`}
        />
      )}

      {choice && options && (
        <div className="space-y-1.5">
          {options.map((opt) => (
            <ChoiceRow
              key={opt.value}
              name={`ask-user-${id}`}
              multiple={type === 'multi_choice'}
              checked={
                type === 'multi_choice' ? Array.isArray(value) && value.includes(opt.value) : value === opt.value
              }
              disabled={disabled}
              label={opt.label}
              value={opt.value}
              onChange={() => (type === 'multi_choice' ? onMultiChoice(id, opt.value) : onSingleChoice(id, opt.value))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
