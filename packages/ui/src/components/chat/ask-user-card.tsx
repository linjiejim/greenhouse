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

import React, { useState, useCallback } from 'react';
import { Button } from '../ui';
import { ClipboardList, Check, Send } from '../../lib/icons';
import { Markdown } from '../markdown';

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
}

// ─── Component ───────────────────────────────────────────

export function AskUserCard({ data, onSubmit, submitted = false }: AskUserCardProps) {
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
    if (!canSubmit || isSubmitted) return;

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
          // Map values back to labels
          const labels = answer.map((v) => {
            const opt = q.options?.find((o) => o.value === v);
            return opt?.label || v;
          });
          displayAnswer = labels.join(', ');
        }
      } else if (q.type === 'single_choice') {
        const opt = q.options?.find((o) => o.value === answer);
        displayAnswer = opt?.label || answer || '(not answered)';
      } else {
        displayAnswer = (answer as string).trim() || '(not answered)';
      }
      lines.push(`**${num}. ${q.label}**: ${displayAnswer}`);
    }

    setLocalSubmitted(true);
    onSubmit(lines.join('\n'));
  }, [canSubmit, isSubmitted, answers, questions, onSubmit]);

  return (
    <div
      className={`rounded-xl border overflow-hidden transition-colors ${
        isSubmitted ? 'bg-surface-sunken border-edge opacity-80' : 'bg-surface-raised border-primary-edge shadow-sm'
      }`}
    >
      {/* Header */}
      <div
        className={`px-4 py-2.5 flex items-center gap-2 border-b ${
          isSubmitted ? 'bg-success-subtle/50 border-success/30' : 'bg-primary-subtle/50 border-primary-edge'
        }`}
      >
        {isSubmitted ? (
          <Check size={14} className="text-success flex-shrink-0" />
        ) : (
          <ClipboardList size={14} className="text-primary-fg flex-shrink-0" />
        )}
        <span className="text-sm font-medium text-fg">{title}</span>
        {isSubmitted && <span className="text-[11px] text-success ml-auto">Submitted</span>}
      </div>

      {/* Description (rendered as Markdown for formatting) */}
      {description && (
        <div className="px-4 pt-2.5 pb-1 text-xs text-fg-muted max-h-[200px] overflow-y-auto">
          <Markdown content={description} compact />
        </div>
      )}

      {/* Questions */}
      <div className="px-4 py-3 space-y-4">
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

      {/* Submit button */}
      {!isSubmitted && (
        <div className="px-4 pb-3 pt-1 flex justify-end">
          <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
            <Send size={12} className="mr-1.5" />
            Submit Answers
          </Button>
        </div>
      )}
    </div>
  );
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
  const { id, label, type, options, required, placeholder } = question;
  const isRequired = required !== false;

  return (
    <div>
      <label className="block text-xs font-medium text-fg-secondary mb-1.5">
        <span className="text-fg-faint mr-1">{index}.</span>
        {label}
        {!isRequired && <span className="text-fg-faint font-normal ml-1">(optional)</span>}
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
