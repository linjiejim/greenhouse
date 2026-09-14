/**
 * Run detail sub-page — view run results and individual result details.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Button,
  Card,
  Badge,
  Dialog,
  ConfirmDialog,
  EmptyState,
  Spinner,
  Input,
  Checkbox,
  toast,
} from '../../components/ui';
import {
  XCircle,
  Bot,
  ClipboardList,
  BarChart3,
  BookOpen,
  CheckCircle,
  Pencil,
  RefreshCw,
  Clock,
} from '../../lib/icons';
import { Markdown } from '../../components/markdown';
import { PipelineStageChart } from '../../components/chat/pipeline-stage-chart';
import * as evalApi from '../../lib/eval-api';
import type { PipelineStep } from '@greenhouse/types/session';
import { ScoreCell, scoreColor, scoreBg, safeParse, entityIcon, MetricBox } from './helpers';
import { RunDuration, StartRunDialog } from './runs';
import { useT, type TranslationKey } from '../../lib/i18n';
import { formatDate } from '../../lib/utils';

const METRIC_KEYS: Record<string, TranslationKey> = {
  accuracy: 'eval.accuracy',
  completeness: 'eval.completeness',
  relevance: 'eval.relevance',
  speed: 'eval.speed',
};
const RUN_STATUS_KEYS: Record<string, TranslationKey> = {
  pending: 'common.pending',
  running: 'common.running',
  completed: 'common.completed',
  failed: 'common.failed',
  cancelled: 'common.cancelled',
  error: 'common.failed',
};

// ─── Summary Card ────────────────────────────────────────

function SummaryCard({ label, score }: { label: string; score: number | null }) {
  return (
    <Card className="p-3 text-center">
      <div className="text-xs text-fg-faint mb-1">{label}</div>
      <div className={`text-2xl font-bold ${scoreColor(score)}`}>{score != null ? score.toFixed(1) : '—'}</div>
      <div className="text-[10px] text-fg-faint">/10</div>
    </Card>
  );
}

// ─── Result Detail Modal ─────────────────────────────────

function ResultDetailModal({ result, onClose }: { result: evalApi.EvalResult; onClose: () => void }) {
  const t = useT();
  const reasoning = result.judge_reasoning ? JSON.parse(result.judge_reasoning) : null;
  const refs: Array<string | { slug: string; title: string; category?: string; type?: string; source_id?: string }> =
    result.references_used ? JSON.parse(result.references_used) : [];
  const groundTruth = useMemo<string[]>(
    () => (result.ground_truth ? JSON.parse(result.ground_truth) : []),
    [result.ground_truth],
  );
  const pipelineSteps: PipelineStep[] = safeParse(result.pipeline, []);

  const matchStatus = useMemo(() => {
    if (!result.answer || !groundTruth.length) return groundTruth.map(() => 'unknown' as const);
    const answerLower = result.answer.toLowerCase();
    return groundTruth.map((fact) => {
      const keywords = fact
        .toLowerCase()
        .replace(/[^\w\s\u4e00-\u9fff]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 3);
      if (keywords.length === 0) return 'unknown' as const;
      const matchCount = keywords.filter((kw) => answerLower.includes(kw)).length;
      const ratio = matchCount / keywords.length;
      if (ratio >= 0.5) return 'match' as const;
      if (ratio > 0) return 'partial' as const;
      return 'miss' as const;
    });
  }, [result.answer, groundTruth]);

  return (
    <Dialog open={true} onClose={onClose} title={`#${result.dataset_id} ${result.question}`} size="workspace">
      <div className="space-y-5">
        {/* IDs */}
        <div className="flex items-center justify-between">
          <div className="flex gap-1">
            <Badge variant="secondary">{result.category}</Badge>
            <Badge
              variant={
                result.difficulty === 'easy' ? 'success' : result.difficulty === 'hard' ? 'destructive' : 'warning'
              }
            >
              {result.difficulty}
            </Badge>
            {result.is_negative === 1 && <Badge variant="destructive">{t('eval.negative')}</Badge>}
          </div>
          <div className="text-[10px] text-fg-faint font-mono select-all space-x-3">
            <span title={t('eval.runId')}>
              {t('eval.runId')}: {result.run_id.slice(0, 8)}
            </span>
            <span title={t('eval.resultId')}>
              {t('eval.resultId')}: {result.id}
            </span>
          </div>
        </div>

        {/* Score overview */}
        <div>
          <div className="flex items-center gap-4 mb-3">
            <div className={`text-3xl font-bold ${scoreColor(result.score_final)}`}>
              {result.score_final != null ? result.score_final.toFixed(1) : '—'}
              <span className="text-sm text-fg-faint font-normal ml-1">/10</span>
            </div>
            <Badge
              variant={
                result.status === 'completed' ? 'success' : result.status === 'error' ? 'destructive' : 'warning'
              }
            >
              {t(RUN_STATUS_KEYS[result.status] ?? 'common.pending')}
            </Badge>
          </div>

          {reasoning && (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-2">
              {(['accuracy', 'completeness', 'relevance', 'speed'] as const).map((key) => {
                const val = reasoning[key];
                if (!val) return null;
                return (
                  <div key={key} className={`rounded-lg p-2.5 ${scoreBg(val.score)}`}>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="font-medium text-fg-secondary capitalize text-xs">{t(METRIC_KEYS[key])}</span>
                      <span className={`font-bold text-sm ${scoreColor(val.score)}`}>{val.score}/10</span>
                    </div>
                    <div className="text-[11px] text-fg-muted leading-snug">{val.reason}</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Error */}
        {result.error && (
          <div className="bg-danger-subtle border border-danger rounded-lg p-3 text-sm text-danger">{result.error}</div>
        )}

        {/* AI Answer vs Expected */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div>
            <h4 className="text-xs font-semibold text-fg-muted mb-1.5 flex items-center gap-1">
              <Bot size={12} /> {t('eval.aiAnswer')}
            </h4>
            <div className="bg-surface-raised border border-edge rounded-lg p-3 max-h-72 overflow-y-auto">
              {result.answer ? (
                <Markdown content={result.answer} />
              ) : (
                <span className="text-fg-faint text-sm italic">{t('eval.noAnswer')}</span>
              )}
            </div>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-fg-muted mb-1.5 flex items-center gap-1">
              <ClipboardList size={12} /> {t('eval.expected')}
            </h4>
            <div className="bg-surface-raised border border-edge rounded-lg p-3 max-h-72 overflow-y-auto">
              <ul className="space-y-1.5">
                {groundTruth.map((fact, i) => {
                  const status = matchStatus[i];
                  const iconMap: Record<string, string> = { match: '✓', miss: '✗', partial: '~' };
                  const icon = iconMap[status] || '?';
                  const textColor =
                    status === 'match'
                      ? 'text-fg-secondary'
                      : status === 'miss'
                        ? 'text-danger'
                        : status === 'partial'
                          ? 'text-warning'
                          : 'text-fg-muted';
                  const bgColor =
                    status === 'match'
                      ? 'bg-success-subtle'
                      : status === 'miss'
                        ? 'bg-danger-subtle'
                        : status === 'partial'
                          ? 'bg-warning-subtle'
                          : '';
                  return (
                    <li key={i} className={`flex items-start gap-1.5 text-sm rounded px-2 py-1 ${bgColor}`}>
                      <span className="flex-shrink-0 mt-0.5 text-xs">{icon}</span>
                      <span className={textColor}>{fact}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>

        {/* Performance metrics */}
        <div>
          <h4 className="text-xs font-semibold text-fg-muted mb-1.5 flex items-center gap-1">
            <BarChart3 size={12} /> {t('eval.performanceMetrics')}
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2">
            <MetricBox
              label={t('eval.duration')}
              value={result.duration_ms != null ? `${(result.duration_ms / 1000).toFixed(2)}s` : '—'}
            />
            <MetricBox
              label={t('eval.ttfb')}
              value={result.ttfb_ms != null ? `${(result.ttfb_ms / 1000).toFixed(2)}s` : '—'}
            />
            <MetricBox
              label={t('eval.inputTokens')}
              value={result.input_tokens ? result.input_tokens.toLocaleString() : '—'}
            />
            <MetricBox
              label={t('eval.outputTokens')}
              value={result.output_tokens ? result.output_tokens.toLocaleString() : '—'}
            />
            <MetricBox
              label={t('eval.cached')}
              value={result.cached_tokens ? result.cached_tokens.toLocaleString() : '—'}
            />
            <MetricBox
              label={t('eval.tokens')}
              value={
                result.input_tokens || result.output_tokens
                  ? ((result.input_tokens || 0) + (result.output_tokens || 0)).toLocaleString()
                  : '—'
              }
            />
          </div>
        </div>

        {/* Pipeline */}
        {pipelineSteps.length > 0 && (
          <div>
            <PipelineStageChart steps={pipelineSteps} totalDurationMs={result.duration_ms} />
          </div>
        )}

        {/* References */}
        {refs.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-fg-muted mb-1.5 flex items-center gap-1">
              <BookOpen size={12} /> {t('eval.referencesUsed')}
            </h4>
            <div className="flex gap-1.5 flex-wrap">
              {refs.map((ref, i) => {
                const title = typeof ref === 'string' ? ref : ref.title;
                const category = typeof ref === 'string' ? undefined : ref.category;
                const isSource = typeof ref !== 'string' && ref.type === 'source';
                return (
                  <span
                    key={i}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border ${
                      isSource
                        ? 'bg-info-subtle text-info border-info'
                        : 'bg-primary-subtle text-primary-fg-strong border-primary-edge'
                    }`}
                  >
                    {category && (
                      <span className={`text-[10px] ${isSource ? 'text-blue-500' : 'text-primary-500'}`}>
                        {(() => {
                          const Icon = entityIcon(category);
                          return <Icon size={10} />;
                        })()}
                      </span>
                    )}
                    {title}
                    {category && (
                      <span
                        className={`text-[10px] border-l pl-1 ml-0.5 ${isSource ? 'text-blue-500 border-info' : 'text-primary-500 border-primary-edge'}`}
                      >
                        {category}
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
            {refs.some((r: any) => r.ref_docs?.length > 0) &&
              (() => {
                const allRefDocs = refs.flatMap((r: any) => r.ref_docs || []);
                const seen = new Set<string>();
                const uniqueRefDocs = allRefDocs.filter((sd: { source_id: string; category: string }) => {
                  const key = `${sd.category}/${sd.source_id}`;
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                });
                return (
                  <div className="flex items-center flex-wrap gap-1 mt-1.5">
                    <span className="text-[10px] text-fg-faint">{t('eval.rawSources')}</span>
                    {uniqueRefDocs.map((sd: { source_id: string; category: string; title: string }) => (
                      <span
                        key={`${sd.category}/${sd.source_id}`}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border bg-surface-sunken text-fg-secondary border-edge"
                      >
                        <span>
                          {(() => {
                            const Icon = entityIcon(sd.category);
                            return <Icon size={10} />;
                          })()}
                        </span>
                        <span className="truncate max-w-[180px]">{sd.title}</span>
                        <span className="text-fg-faint">{sd.category}</span>
                      </span>
                    ))}
                  </div>
                );
              })()}
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ─── Run Detail ──────────────────────────────────────────

export function RunDetail({ runId, onBack }: { runId: string; onBack: () => void }) {
  const t = useT();
  const [run, setRun] = useState<evalApi.EvalRun | null>(null);
  const [results, setResults] = useState<evalApi.EvalResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedResult, setSelectedResult] = useState<evalApi.EvalResult | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showRerunDialog, setShowRerunDialog] = useState(false);
  const rerunDatasetIds = useMemo(() => Array.from(selectedIds), [selectedIds]);
  const [cancelling, setCancelling] = useState(false);
  const [confirmCancelOpen, setConfirmCancelOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await evalApi.getRun(runId);
      setRun(data.run);
      setResults(data.results);
    } catch (err) {
      console.error('Failed to load run:', err);
    }
    setLoading(false);
  }, [runId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (run?.status !== 'running') return;
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [run, load]);

  // Selection helpers
  const toggleResultId = (datasetId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(datasetId)) next.delete(datasetId);
      else next.add(datasetId);
      return next;
    });
  };

  const allSelected = results.length > 0 && results.every((r) => selectedIds.has(r.dataset_id));

  const handleCancelRun = async () => {
    setConfirmCancelOpen(false);
    setCancelling(true);
    try {
      const updated = await evalApi.cancelRun(runId);
      setRun(updated);
    } catch (_err) {
      toast(t('eval.cancelRunFailed'), 'error');
    }
    setCancelling(false);
  };

  const handleRerunStarted = (newRunId: string) => {
    setShowRerunDialog(false);
    setSelectedIds(new Set());
    window.location.hash = `#/administration/eval/runs/${newRunId}`;
  };

  const runTokenTotals = useMemo(() => {
    let inputTokens = 0,
      outputTokens = 0,
      cachedTokens = 0;
    for (const r of results) {
      inputTokens += r.input_tokens || 0;
      outputTokens += r.output_tokens || 0;
      cachedTokens += r.cached_tokens || 0;
    }
    return { inputTokens, outputTokens, cachedTokens };
  }, [results]);

  if (loading && !run) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="text-primary-500" />
      </div>
    );
  }

  if (!run) {
    return <EmptyState icon={XCircle} title={t('eval.runNotFound')} />;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← {t('common.back')}
        </Button>
        {editingName ? (
          <div className="flex items-center gap-2">
            <Input
              type="text"
              value={nameValue}
              onChange={(e) => setNameValue(e.target.value)}
              onKeyDown={async (e) => {
                if (e.key === 'Enter') {
                  await evalApi.updateRun(run.id, { name: nameValue });
                  setRun({ ...run, name: nameValue });
                  setEditingName(false);
                } else if (e.key === 'Escape') {
                  setEditingName(false);
                }
              }}
              className="text-lg font-semibold"
              autoFocus
            />
            <Button
              size="sm"
              onClick={async () => {
                await evalApi.updateRun(run.id, { name: nameValue });
                setRun({ ...run, name: nameValue });
                setEditingName(false);
              }}
            >
              {t('common.save')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditingName(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        ) : (
          <h2
            className="text-lg font-semibold text-fg cursor-pointer hover:text-primary-fg-strong transition-colors"
            onClick={() => {
              setNameValue(run.name || run.id.slice(0, 8));
              setEditingName(true);
            }}
            title={t('eval.clickEditName')}
          >
            {run.name || run.id.slice(0, 8)} <Pencil size={10} className="text-fg-faint inline" />
          </h2>
        )}
        <Badge
          variant={
            run.status === 'completed'
              ? 'success'
              : run.status === 'failed'
                ? 'destructive'
                : run.status === 'cancelled'
                  ? 'secondary'
                  : 'warning'
          }
        >
          {t(RUN_STATUS_KEYS[run.status] ?? 'common.pending')}
        </Badge>
        <span className="text-[11px] font-mono text-fg-faint select-all" title={t('eval.runId')}>
          {run.id}
        </span>
        {run.status === 'running' && (
          <>
            <Spinner className="text-primary-500" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmCancelOpen(true)}
              disabled={cancelling}
              className="text-orange-600 border-orange-300 hover:bg-orange-50"
            >
              {cancelling ? (
                <>
                  <Spinner className="mr-1" /> {t('eval.stopping')}
                </>
              ) : (
                t('common.stop')
              )}
            </Button>
          </>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <SummaryCard label={t('eval.overall')} score={run.avg_score} />
        <SummaryCard label={t('eval.accuracy')} score={run.avg_accuracy} />
        <SummaryCard label={t('eval.completeness')} score={run.avg_completeness} />
        <SummaryCard label={t('eval.relevance')} score={run.avg_relevance} />
        <SummaryCard label={t('eval.speed')} score={run.avg_speed} />
      </div>

      {/* Progress bar if running */}
      {run.status === 'running' && (
        <div className="bg-surface-raised border border-edge rounded-lg p-3">
          <div className="flex items-center justify-between text-sm text-fg-muted mb-1">
            <span>{t('eval.progress')}</span>
            <span>
              <span className="text-success">✓{run.passed}</span>
              {run.failed > 0 && <span className="text-danger ml-1">✗{run.failed}</span>}
              <span className="text-fg-faint ml-1">/ {run.total}</span>
              <span className="ml-2">({((run.completed / run.total) * 100).toFixed(0)}%)</span>
            </span>
          </div>
          <div className="w-full bg-surface-muted rounded-full h-2">
            <div
              className="bg-primary-500 h-2 rounded-full transition-all"
              style={{ width: `${(run.completed / run.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Meta info */}
      <div className="text-xs text-fg-faint flex gap-4 flex-wrap">
        <span>{t('eval.modelLabel', { model: run.model ?? '—' })}</span>
        {run.profile_id && <span>{t('eval.profileLabel', { profile: run.profile_id })}</span>}
        <span>{t('eval.passedCount', { count: run.passed })}</span>
        {run.failed > 0 && <span className="text-danger">{t('eval.failedCount', { count: run.failed })}</span>}
        <span>
          <RunDuration run={run} />
        </span>
        <span>{t('eval.startedAt', { date: formatDate(run.started_at) })}</span>
        {run.finished_at && <span>{t('eval.finishedAt', { date: formatDate(run.finished_at) })}</span>}
        {runTokenTotals.inputTokens > 0 && (
          <>
            <span className="border-l border-edge-strong pl-4">
              {t('eval.inputShort', { count: runTokenTotals.inputTokens.toLocaleString() })}
            </span>
            <span>{t('eval.outputShort', { count: runTokenTotals.outputTokens.toLocaleString() })}</span>
            {runTokenTotals.cachedTokens > 0 && (
              <span>{t('eval.cachedShort', { count: runTokenTotals.cachedTokens.toLocaleString() })}</span>
            )}
          </>
        )}
      </div>

      {/* Results Table */}
      <div className="bg-surface-raised border border-edge rounded-lg overflow-x-auto">
        {/* Selection toolbar */}
        {selectedIds.size > 0 && (
          <div className="sticky left-0 px-3 py-2 bg-primary-subtle border-b border-primary-edge flex min-w-[760px] items-center gap-3">
            <span className="text-sm font-medium text-primary-fg-strong">
              {t('eval.questionsSelected', { count: selectedIds.size })}
            </span>
            <Button size="sm" onClick={() => setShowRerunDialog(true)}>
              <>
                <RefreshCw size={14} className="mr-1 inline" /> {t('eval.rerunSelected')}
              </>
            </Button>
            <div className="flex-1" />
            <button onClick={() => setSelectedIds(new Set())} className="text-xs text-fg-muted hover:text-fg-secondary">
              {t('eval.clearSelection')}
            </button>
          </div>
        )}
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-surface-sunken text-fg-muted">
            <tr>
              <th className="text-center px-2 py-2 w-8">
                <Checkbox
                  checked={allSelected}
                  onChange={(e) => {
                    if (e.target.checked) setSelectedIds(new Set(results.map((r) => r.dataset_id)));
                    else setSelectedIds(new Set());
                  }}
                  className="rounded border-edge-strong text-primary-fg focus:ring-primary-500"
                />
              </th>
              <th className="text-left px-3 py-2 w-10">#</th>
              <th className="text-left px-3 py-2">{t('eval.question')}</th>
              <th className="text-center px-3 py-2 w-16">{t('eval.score')}</th>
              <th className="text-center px-3 py-2 w-14">{t('eval.accuracyShort')}</th>
              <th className="text-center px-3 py-2 w-14">{t('eval.completenessShort')}</th>
              <th className="text-center px-3 py-2 w-14">{t('eval.relevanceShort')}</th>
              <th className="text-center px-3 py-2 w-14">{t('eval.speedShort')}</th>
              <th className="text-center px-3 py-2 w-16">{t('common.time')}</th>
              <th className="text-center px-3 py-2 w-16">{t('eval.tokens')}</th>
              <th className="text-center px-3 py-2 w-20">{t('common.status')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {results.map((r) => (
              <tr
                key={r.id}
                className={`hover:bg-surface-sunken cursor-pointer ${selectedIds.has(r.dataset_id) ? 'bg-primary-subtle/50' : ''}`}
                onClick={() => setSelectedResult(r)}
              >
                <td className="text-center px-2 py-2" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selectedIds.has(r.dataset_id)}
                    onChange={() => toggleResultId(r.dataset_id)}
                    className="rounded border-edge-strong text-primary-fg focus:ring-primary-500"
                  />
                </td>
                <td className="px-3 py-2 text-fg-faint">{r.dataset_id}</td>
                <td className="px-3 py-2 text-fg max-w-sm">
                  <div className="truncate">{r.question}</div>
                  <div className="flex gap-1 mt-0.5">
                    <Badge variant="secondary">{r.category}</Badge>
                    <Badge
                      variant={
                        r.difficulty === 'easy' ? 'success' : r.difficulty === 'hard' ? 'destructive' : 'warning'
                      }
                    >
                      {r.difficulty}
                    </Badge>
                    {r.is_negative === 1 && <Badge variant="destructive">{t('eval.negative')}</Badge>}
                  </div>
                </td>
                <td className="px-3 py-2">
                  <ScoreCell score={r.score_final} />
                </td>
                <td className="px-3 py-2">
                  <ScoreCell score={r.score_accuracy} />
                </td>
                <td className="px-3 py-2">
                  <ScoreCell score={r.score_completeness} />
                </td>
                <td className="px-3 py-2">
                  <ScoreCell score={r.score_relevance} />
                </td>
                <td className="px-3 py-2">
                  <ScoreCell score={r.score_speed} />
                </td>
                <td className="px-3 py-2 text-center text-fg-muted text-xs">
                  {r.duration_ms != null ? (
                    <div>
                      <div>{(r.duration_ms / 1000).toFixed(2)}s</div>
                      {r.ttfb_ms != null && (
                        <div className="text-[10px] text-fg-faint">TTFB {(r.ttfb_ms / 1000).toFixed(2)}s</div>
                      )}
                    </div>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-3 py-2 text-center text-fg-muted text-xs">
                  {r.input_tokens || r.output_tokens
                    ? ((r.input_tokens || 0) + (r.output_tokens || 0)).toLocaleString()
                    : '—'}
                </td>
                <td className="px-3 py-2 text-center">
                  {r.status === 'completed' ? (
                    <CheckCircle size={14} className="text-success" />
                  ) : r.status === 'error' ? (
                    <XCircle size={14} className="text-danger" />
                  ) : r.status === 'cancelled' ? (
                    <Clock size={14} className="text-fg-faint" />
                  ) : (
                    <RefreshCw size={14} className="animate-spin text-warning" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectedResult && <ResultDetailModal result={selectedResult} onClose={() => setSelectedResult(null)} />}

      {/* Re-run Dialog (reuses StartRunDialog from runs page) */}
      <StartRunDialog
        open={showRerunDialog}
        onClose={() => setShowRerunDialog(false)}
        onStarted={handleRerunStarted}
        initialDatasetIds={rerunDatasetIds}
      />
      <ConfirmDialog
        open={confirmCancelOpen}
        onClose={() => setConfirmCancelOpen(false)}
        onConfirm={handleCancelRun}
        title={t('eval.stopRunConfirmLong')}
        confirmLabel={t('common.stop')}
        confirmVariant="destructive"
      />
    </div>
  );
}
