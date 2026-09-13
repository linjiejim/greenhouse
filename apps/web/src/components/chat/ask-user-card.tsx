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
import { ClipboardList, Send } from '../../lib/icons';
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
              <Send size={12} className="mr-1.5" />
              {t('chat.askSubmit')}
            </Button>
          </ArtifactCardActions>
        ) : undefined
      }
    >
      {isSubmitted ? (
        <div className="space-y-1.5">
          {submittedAnswers.map((item, index) => (
            <div key={item.id} className="flex min-w-0 items-start gap-2 text-xs">
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
            <div className="max-h-[200px] overflow-y-auto pb-1 text-xs text-fg-muted">
              <Markdown content={description} compact linkTarget="new-window" />
            </div>
          )}

          {/* Questions */}
          <div className="space-y-4 pt-2">
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

  return (
    <div>
      <label className="block text-xs font-medium text-fg-secondary mb-1.5">
        <span className="text-fg-faint mr-1">{index}.</span>
        {label}
        {!isRequired && <span className="text-fg-faint font-normal ml-1">{t('chat.optional')}</span>}
      </label>

      {type === 'text' && (
        <input
          type="text"
          value={value as string}
          onChange={(e) => onTextChange(id, e.target.value)}
          placeholder={placeholder || ''}
          disabled={disabled}
          className="w-full bg-surface-sunken border border-edge-strong rounded-lg px-3 py-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500 disabled:opacity-60 disabled:cursor-not-allowed"
        />
      )}

      {type === 'textarea' && (
        <textarea
          value={value as string}
          onChange={(e) => onTextChange(id, e.target.value)}
          placeholder={placeholder || ''}
          disabled={disabled}
          rows={3}
          className="w-full bg-surface-sunken border border-edge-strong rounded-lg px-3 py-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500 resize-none disabled:opacity-60 disabled:cursor-not-allowed"
        />
      )}

      {type === 'single_choice' && options && (
        <div className="space-y-1.5">
          {options.map((opt) => (
            <label
              key={opt.value}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
                disabled
                  ? 'opacity-60 cursor-not-allowed'
                  : value === opt.value
                    ? 'bg-primary-subtle border-primary-edge'
                    : 'bg-surface-sunken border-edge hover:border-primary-300 hover:bg-primary-subtle/30'
              }`}
            >
              <input
                type="radio"
                name={`ask-user-${id}`}
                value={opt.value}
                checked={value === opt.value}
                onChange={() => onSingleChoice(id, opt.value)}
                disabled={disabled}
                className="accent-primary-600 w-3.5 h-3.5 flex-shrink-0"
              />
              <span className="text-sm text-fg-secondary">{opt.label}</span>
            </label>
          ))}
        </div>
      )}

      {type === 'multi_choice' && options && (
        <div className="space-y-1.5">
          {options.map((opt) => {
            const checked = Array.isArray(value) && value.includes(opt.value);
            return (
              <label
                key={opt.value}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
                  disabled
                    ? 'opacity-60 cursor-not-allowed'
                    : checked
                      ? 'bg-primary-subtle border-primary-edge'
                      : 'bg-surface-sunken border-edge hover:border-primary-300 hover:bg-primary-subtle/30'
                }`}
              >
                <input
                  type="checkbox"
                  value={opt.value}
                  checked={checked}
                  onChange={() => onMultiChoice(id, opt.value)}
                  disabled={disabled}
                  className="accent-primary-600 w-3.5 h-3.5 flex-shrink-0 rounded"
                />
                <span className="text-sm text-fg-secondary">{opt.label}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
