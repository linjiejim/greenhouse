/**
 * EvalResultCard — rich card display for eval_message tool results (问答评测 v2).
 * Shows the pass/fail/pending verdict, classification, 4 quality dimensions,
 * the answer-vs-KB consistency breakdown (added/rewritten/omitted/unsupported),
 * citation issues, and actionable suggestions.
 *
 * Falls back to the legacy 4-dimension layout for eval cards produced before v2.
 */

import React from 'react';
import { FlaskConical, Check, BookOpen } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';

// ─── Label maps (domain-specific, Chinese) ───────────────

const DIM_ORDER: Array<[string, TranslationKey]> = [
  ['kb_consistency', 'toolEval.dimConsistency'],
  ['citation_correctness', 'toolEval.dimCitation'],
  ['boundary_control', 'toolEval.dimBoundary'],
  ['safety', 'toolEval.dimSafety'],
];

const QTYPE_L1: Record<string, TranslationKey> = {
  device: 'toolEval.typeDevice',
  app: 'toolEval.typeApp',
  plant: 'toolEval.typePlant',
  composite: 'toolEval.typeComposite',
  out_of_scope: 'toolEval.typeOutOfScope',
};

const REPLY_CLASS: Record<string, TranslationKey> = {
  kb_grounded: 'toolEval.replyKb',
  model_direct: 'toolEval.replyModel',
  kb_plus_model: 'toolEval.replyMixed',
};

const VERDICT: Record<string, { labelKey: TranslationKey; text: string; bg: string }> = {
  pass: { labelKey: 'toolEval.pass', text: 'text-success', bg: 'bg-success-subtle' },
  fail: { labelKey: 'toolEval.fail', text: 'text-danger', bg: 'bg-danger-subtle' },
  pending: { labelKey: 'toolEval.pending', text: 'text-warning', bg: 'bg-warning-subtle' },
};

const scoreColor = (s: number) => (s >= 8 ? 'text-success' : s >= 6 ? 'text-warning' : 'text-danger');
const scoreBg = (s: number) => (s >= 8 ? 'bg-success-subtle' : s >= 6 ? 'bg-warning-subtle' : 'bg-danger-subtle');

// ─── Types ───────────────────────────────────────────────

interface DimScore {
  score: number;
  reason: string;
}
interface Classification {
  reply_class?: string;
  intent_summary?: string;
  q_type_l1?: string;
  q_type_l2?: string;
}
interface ConsistencyDetail {
  consistent?: string[];
  added?: string[];
  rewritten?: string[];
  omitted?: string[];
  unsupported?: string[];
}
interface ReferenceChecked {
  slug: string;
  title: string;
  type?: string;
  category?: string;
  source_id?: string;
  relevant?: boolean;
}

// ─── Component ───────────────────────────────────────────

export function EvalResultCard({ output }: { output: Record<string, unknown> }) {
  const t = useT();
  const dimensions = output.dimensions as Record<string, DimScore> | undefined;

  // Legacy v1 cards (4 fixed dims, no verdict) — render the old layout.
  if (!dimensions && output.scores) {
    return <LegacyEvalCard output={output} />;
  }

  const verdict = (output.verdict as string) || 'pending';
  const v = VERDICT[verdict] ?? VERDICT.pending;
  const verdictReason = output.verdict_reason as string | undefined;
  const scoreFinal = output.score_final as number | null | undefined;
  const cls = (output.classification as Classification) || {};
  const cd = (output.consistency_detail as ConsistencyDetail) || {};
  const citationIssues = (output.citation_issues as Array<{ type: string; detail: string }>) || [];
  const suggestions = (output.suggestions as string[]) || [];
  const referencesChecked = dedupeRefs((output.references_checked as ReferenceChecked[]) || []);
  const steps = (output.steps as string[]) || [];
  const durationMs = output.duration_ms as number | undefined;

  const typeKey = QTYPE_L1[cls.q_type_l1 ?? ''];
  const typeChip = [typeKey ? t(typeKey) : cls.q_type_l1, cls.q_type_l2].filter(Boolean).join(' · ');
  const hasConsistencyIssue =
    (cd.added?.length ?? 0) + (cd.rewritten?.length ?? 0) + (cd.omitted?.length ?? 0) + (cd.unsupported?.length ?? 0) >
    0;

  return (
    <div className="border border-info/30 rounded-lg overflow-hidden bg-info-subtle">
      {/* Header: title + verdict + score */}
      <div className="px-3 py-2 bg-surface-raised border-b border-info/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm">
            <FlaskConical size={14} />
          </span>
          <span className="text-sm font-semibold text-fg-secondary">{t('toolEval.title')}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-bold px-2 py-0.5 rounded ${v.text} ${v.bg}`}>{t(v.labelKey)}</span>
          {scoreFinal != null && (
            <span className={`text-lg font-bold ${scoreColor(scoreFinal)}`}>
              {scoreFinal.toFixed(1)}
              <span className="text-xs text-fg-faint font-normal">/10</span>
            </span>
          )}
        </div>
      </div>

      {/* Classification + intent */}
      {(typeChip || cls.intent_summary) && (
        <div className="px-2.5 pt-2 flex flex-wrap items-center gap-1.5 text-xs">
          {typeChip && <span className="px-1.5 py-0.5 rounded bg-info-subtle text-info font-medium">{typeChip}</span>}
          {cls.reply_class && (
            <span className="px-1.5 py-0.5 rounded bg-surface-sunken text-fg-muted">
              {REPLY_CLASS[cls.reply_class] ? t(REPLY_CLASS[cls.reply_class]) : cls.reply_class}
            </span>
          )}
          {cls.intent_summary && (
            <span className="text-fg-muted">{t('toolEval.intent', { value: cls.intent_summary })}</span>
          )}
        </div>
      )}

      {/* Verdict reason */}
      {verdictReason && (
        <div className={`px-2.5 pt-1.5 text-xs ${verdict === 'pass' ? 'text-fg-muted' : v.text}`}>{verdictReason}</div>
      )}

      {/* Dimension scores — one per row, reason shown in full (no truncation) */}
      {dimensions && (
        <div className="flex flex-col gap-1.5 p-2">
          {DIM_ORDER.map(([key, labelKey]) => {
            const val = dimensions[key];
            if (!val) return null;
            return (
              <div key={key} className={`rounded-md p-2 ${scoreBg(val.score)}`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-fg-secondary">{t(labelKey)}</span>
                  <span className={`text-sm font-bold ${scoreColor(val.score)}`}>{val.score}/10</span>
                </div>
                <div className="text-xs text-fg-muted mt-0.5 leading-relaxed">{val.reason}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Consistency breakdown */}
      {hasConsistencyIssue ? (
        <div className="px-2.5 pb-2 space-y-1">
          <div className="text-xs font-medium text-fg-muted">{t('toolEval.consistencyTitle')}</div>
          <ConsistencyGroup label={t('toolEval.added')} items={cd.added} tone="text-danger" />
          <ConsistencyGroup label={t('toolEval.rewritten')} items={cd.rewritten} tone="text-warning" />
          <ConsistencyGroup label={t('toolEval.omitted')} items={cd.omitted} tone="text-warning" />
          <ConsistencyGroup label={t('toolEval.unsupported')} items={cd.unsupported} tone="text-danger" />
        </div>
      ) : (
        <div className="px-3 pb-2 text-xs text-success flex items-center gap-1">
          <Check size={12} /> {t('toolEval.consistent')}
        </div>
      )}

      {/* Citation issues */}
      {citationIssues.length > 0 && (
        <div className="px-2.5 pb-2 space-y-1">
          <div className="text-xs font-medium text-fg-muted">
            {t('toolEval.citationIssues', { count: citationIssues.length })}
          </div>
          {citationIssues.map((c, i) => (
            <div key={i} className="bg-surface-raised rounded border border-orange-200 p-1.5 text-xs text-fg-secondary">
              <span className="text-fg-faint">{c.type}</span> — {c.detail}
            </div>
          ))}
        </div>
      )}

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div className="px-2.5 pb-2 space-y-1">
          <div className="text-xs font-medium text-fg-muted">{t('toolEval.suggestions')}</div>
          {suggestions.map((s, i) => (
            <div key={i} className="text-xs text-fg-secondary flex gap-1">
              <span className="text-info">→</span>
              <span>{s}</span>
            </div>
          ))}
        </div>
      )}

      {/* 参考原文 — the KB sources this eval was based on */}
      {referencesChecked.length > 0 && (
        <div className="px-2.5 pb-2 space-y-1">
          <div className="text-xs font-medium text-fg-muted">{t('toolEval.references')}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {referencesChecked.map((ref, i) => (
              <span
                key={ref.source_id || ref.slug || i}
                title={ref.relevant === false ? t('toolEval.referenceNotMatched', { title: ref.title }) : ref.title}
                className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border ${
                  ref.relevant === false
                    ? 'bg-surface-sunken text-fg-muted border-border-subtle'
                    : 'bg-primary-subtle text-primary-fg-strong border-primary-edge'
                }`}
              >
                <BookOpen size={10} />
                <span className="truncate max-w-[160px]">{ref.title || ref.slug}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Progress steps + timing */}
      {(steps.length > 0 || durationMs) && (
        <div className="px-2 pb-2">
          <details className="group">
            <summary className="text-xs text-fg-faint cursor-pointer hover:text-fg-secondary px-1">
              {t('toolEval.steps', {
                duration: durationMs ? `${(durationMs / 1000).toFixed(1)}s` : '',
                count: steps.length,
              })}
            </summary>
            <div className="mt-1 space-y-0.5 px-1">
              {steps.map((s, i) => (
                <div key={i} className="text-xs text-fg-faint flex items-center gap-1">
                  <span className="text-success">
                    <Check size={10} />
                  </span>{' '}
                  {s}
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

/** Same dedupe key as the chat Sources row — one chip per cited document. */
function dedupeRefs(refs: ReferenceChecked[]): ReferenceChecked[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = r.source_id || r.slug;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ConsistencyGroup({ label, items, tone }: { label: string; items?: string[]; tone: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="text-xs text-fg-secondary leading-relaxed">
      <span className={`font-medium ${tone}`}>{label}</span> {items.join('；')}
    </div>
  );
}

// ─── Legacy v1 card (accuracy/faithfulness/completeness/hallucination) ─

function LegacyEvalCard({ output }: { output: Record<string, unknown> }) {
  const t = useT();
  const scores = output.scores as Record<string, { score: number; reason: string }> | undefined;
  const discrepancies = (output.discrepancies as Array<{ claim: string; issue: string; severity: string }>) || [];
  const finalScore = output.score_final as number;
  const steps = (output.steps as string[]) || [];
  const durationMs = output.duration_ms as number | undefined;

  return (
    <div className="border border-info/30 rounded-lg overflow-hidden bg-info-subtle">
      <div className="px-3 py-2 bg-surface-raised border-b border-info/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm">
            <FlaskConical size={14} />
          </span>
          <span className="text-sm font-semibold text-fg-secondary">{t('toolEval.resultTitle')}</span>
        </div>
        <span className={`text-lg font-bold ${scoreColor(finalScore)}`}>
          {finalScore?.toFixed(1)}
          <span className="text-xs text-fg-faint font-normal">/10</span>
        </span>
      </div>
      {scores && (
        <div className="flex flex-col gap-1.5 p-2">
          {Object.entries(scores).map(([key, val]) => (
            <div key={key} className={`rounded-md p-2 ${scoreBg(val.score)}`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-fg-secondary">{key}</span>
                <span className={`text-sm font-bold ${scoreColor(val.score)}`}>{val.score}/10</span>
              </div>
              <div className="text-xs text-fg-muted mt-0.5 leading-relaxed">{val.reason}</div>
            </div>
          ))}
        </div>
      )}
      {discrepancies.length > 0 && (
        <div className="px-2 pb-2 space-y-1">
          <div className="text-xs font-medium text-fg-muted px-1">
            {t('toolEval.discrepancies', { count: discrepancies.length })}
          </div>
          {discrepancies.map((d, i) => (
            <div key={i} className="bg-surface-raised rounded border border-orange-200 p-1.5 text-xs">
              <span className="font-medium text-fg-secondary">{d.claim}</span>
              <span className="text-fg-faint ml-1">— {d.issue}</span>
            </div>
          ))}
        </div>
      )}
      {(steps.length > 0 || durationMs) && (
        <div className="px-2 pb-2">
          <details className="group">
            <summary className="text-xs text-fg-faint cursor-pointer hover:text-fg-secondary px-1">
              {t('toolEval.steps', {
                duration: durationMs ? `${(durationMs / 1000).toFixed(1)}s` : '',
                count: steps.length,
              })}
            </summary>
            <div className="mt-1 space-y-0.5 px-1">
              {steps.map((s, i) => (
                <div key={i} className="text-xs text-fg-faint flex items-center gap-1">
                  <span className="text-success">
                    <Check size={10} />
                  </span>{' '}
                  {s}
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
