/**
 * Runs sub-page — list eval runs, start new runs with dataset selection.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Button,
  Badge,
  Input,
  Dialog,
  ConfirmDialog,
  EmptyState,
  Spinner,
  Select,
  Checkbox,
  toast,
} from '../../components/ui';
import { FlaskConical, BarChart3, Trash2, SquareX } from '../../lib/icons';
import { fetchProfiles } from '../../lib/api';
import type { Profile } from '../../lib/api';
import * as evalApi from '../../lib/eval-api';
import { ScoreCell } from './helpers';
import { useT, type TranslationKey } from '../../lib/i18n';
import { formatDate } from '../../lib/utils';

const CATEGORY_KEYS: Record<string, TranslationKey> = {
  faq: 'eval.categoryFaq',
  plant: 'eval.categoryPlant',
  product: 'eval.categoryProduct',
  guide: 'eval.categoryGuide',
  troubleshooting: 'eval.categoryTroubleshooting',
  comparison: 'eval.categoryComparison',
  negative: 'eval.categoryNegative',
  edge: 'eval.categoryEdge',
  topic: 'eval.categoryTopic',
};
const DIFFICULTY_KEYS: Record<string, TranslationKey> = {
  easy: 'eval.easy',
  medium: 'eval.medium',
  hard: 'eval.hard',
};
const RUN_STATUS_KEYS: Record<string, TranslationKey> = {
  pending: 'common.pending',
  running: 'common.running',
  completed: 'common.completed',
  failed: 'common.failed',
  cancelled: 'common.cancelled',
};

// ─── Run Duration (live for running, static for completed) ──

export function RunDuration({ run }: { run: evalApi.EvalRun }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (run.status !== 'running') return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [run.status]);

  const startMs = new Date(run.started_at).getTime();
  const endMs = run.finished_at ? new Date(run.finished_at).getTime() : now;
  const elapsed = Math.max(0, endMs - startMs);

  if (elapsed < 60_000) return <span>{(elapsed / 1000).toFixed(0)}s</span>;
  const mins = Math.floor(elapsed / 60_000);
  const secs = Math.floor((elapsed % 60_000) / 1000);
  return (
    <span>
      {mins}m {secs}s
    </span>
  );
}

// ─── Start Run Dialog ────────────────────────────────────

export function StartRunDialog({
  open,
  onClose,
  onStarted,
  initialDatasetIds,
}: {
  open: boolean;
  onClose: () => void;
  onStarted: (runId: string) => void;
  initialDatasetIds?: number[];
}) {
  const t = useT();
  const [runName, setRunName] = useState('');
  const [concurrency, setConcurrency] = useState(5);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('team');
  const [datasets, setDatasets] = useState<evalApi.EvalDataset[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);

  // Filters
  const [searchText, setSearchText] = useState('');
  const [catFilter, setCatFilter] = useState('all');
  const [diffFilter, setDiffFilter] = useState('all');

  // Load datasets and profiles
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    Promise.all([evalApi.listDatasets({ enabled: '1' }), fetchProfiles()])
      .then(([result, ps]) => {
        const ds = result.datasets;
        setDatasets(ds);
        setProfiles(ps);
        // Use initial dataset IDs if provided, otherwise select all
        if (initialDatasetIds && initialDatasetIds.length > 0) {
          setSelectedIds(new Set(initialDatasetIds.filter((id) => ds.some((d) => d.id === id))));
        } else {
          setSelectedIds(new Set(ds.map((d) => d.id)));
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load data:', err);
        setLoading(false);
      });
  }, [open, initialDatasetIds]);

  // Compute categories from actual data
  const categories = useMemo(() => {
    const cats = new Set(datasets.map((d) => d.category));
    return ['all', ...Array.from(cats).sort()];
  }, [datasets]);

  // Filtered datasets
  const filtered = useMemo(() => {
    let result = datasets;
    if (catFilter !== 'all') result = result.filter((d) => d.category === catFilter);
    if (diffFilter !== 'all') result = result.filter((d) => d.difficulty === diffFilter);
    if (searchText.trim()) {
      const q = searchText.toLowerCase();
      result = result.filter(
        (d) =>
          d.question.toLowerCase().includes(q) ||
          d.category.toLowerCase().includes(q) ||
          (d.tags && d.tags.toLowerCase().includes(q)),
      );
    }
    return result;
  }, [datasets, catFilter, diffFilter, searchText]);

  // Selection helpers
  const toggleId = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filtered.forEach((d) => next.add(d.id));
      return next;
    });
  };

  const deselectAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filtered.forEach((d) => next.delete(d.id));
      return next;
    });
  };

  const selectOnlyFiltered = () => {
    setSelectedIds(new Set(filtered.map((d) => d.id)));
  };

  const filteredSelectedCount = filtered.filter((d) => selectedIds.has(d.id)).length;
  const allFilteredSelected = filteredSelectedCount === filtered.length && filtered.length > 0;

  // Start run
  const handleStart = async () => {
    if (selectedIds.size === 0) return;
    setStarting(true);
    try {
      const datasetIds = selectedIds.size === datasets.length ? undefined : Array.from(selectedIds);
      const run = await evalApi.startRun(runName || undefined, concurrency, selectedProfileId, datasetIds);
      if (run.error) {
        toast(run.error, 'error');
        setStarting(false);
        return;
      }
      onStarted(run.id);
    } catch (_err) {
      toast(t('eval.failedToStartRun'), 'error');
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('eval.startRun')} size="workspace">
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner className="text-primary-500" />
        </div>
      ) : (
        <div className="space-y-4">
          {/* Run config */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-fg-muted mb-1">{t('eval.runNameOptional')}</label>
              <Input value={runName} onChange={(e) => setRunName(e.target.value)} placeholder={t('eval.egBaseline')} />
            </div>
            <div>
              <label className="block text-xs font-medium text-fg-muted mb-1">{t('eval.profile')}</label>
              <Select value={selectedProfileId} onChange={(e) => setSelectedProfileId(e.target.value)}>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="block text-xs font-medium text-fg-muted mb-1">{t('eval.concurrency')}</label>
              <Input
                type="number"
                min={1}
                max={50}
                value={concurrency}
                onChange={(e) => setConcurrency(Math.max(1, Math.min(50, parseInt(e.target.value) || 5)))}
              />
            </div>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-2 flex-wrap border-t border-edge pt-3">
            <div className="flex-1 min-w-[200px]">
              <Input
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder={t('eval.searchQuestionsTags')}
                className="text-sm"
              />
            </div>
            <Select value={catFilter} onChange={(e) => setCatFilter(e.target.value)} className="w-auto">
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c === 'all' ? t('eval.allCategories') : t(CATEGORY_KEYS[c] ?? 'eval.categoryTopic')}
                </option>
              ))}
            </Select>
            <Select value={diffFilter} onChange={(e) => setDiffFilter(e.target.value)} className="w-auto">
              <option value="all">{t('eval.allDifficulties')}</option>
              <option value="easy">{t('eval.easy')}</option>
              <option value="medium">{t('eval.medium')}</option>
              <option value="hard">{t('eval.hard')}</option>
            </Select>
          </div>

          {/* Selection controls */}
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <span className="font-medium text-fg-secondary">
              {t('eval.selectedOfTotal', { selected: selectedIds.size, total: datasets.length })}
            </span>
            <span className="text-fg-faint">|</span>
            <span>{t('eval.showingItems', { count: filtered.length })}</span>
            <div className="flex-1" />
            <button onClick={selectAllFiltered} className="text-primary-fg hover:text-primary-fg-strong font-medium">
              {t('eval.selectFiltered')}
            </button>
            <button onClick={deselectAllFiltered} className="text-fg-muted hover:text-fg-secondary font-medium">
              {t('eval.deselectFiltered')}
            </button>
            <button onClick={selectOnlyFiltered} className="text-info hover:text-info font-medium">
              {t('eval.onlyFiltered')}
            </button>
            <button
              onClick={() => setSelectedIds(new Set(datasets.map((d) => d.id)))}
              className="text-primary-fg hover:text-primary-fg-strong font-medium"
            >
              {t('eval.selectAll')}
            </button>
            <button onClick={() => setSelectedIds(new Set())} className="text-danger hover:text-danger font-medium">
              {t('eval.clearAll')}
            </button>
          </div>

          {/* Dataset list */}
          <div className="border border-edge rounded-lg max-h-[340px] overflow-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead className="bg-surface-sunken text-fg-muted sticky top-0 z-10">
                <tr>
                  <th className="text-center px-2 py-1.5 w-8">
                    <Checkbox
                      checked={allFilteredSelected}
                      onChange={(e) => (e.target.checked ? selectAllFiltered() : deselectAllFiltered())}
                    />
                  </th>
                  <th className="text-left px-2 py-1.5 w-8">#</th>
                  <th className="text-left px-2 py-1.5">{t('eval.question')}</th>
                  <th className="text-left px-2 py-1.5 w-24">{t('eval.category')}</th>
                  <th className="text-left px-2 py-1.5 w-16">{t('eval.difficultyShort')}</th>
                  <th className="text-left px-2 py-1.5 w-10">{t('eval.languageShort')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {filtered.map((ds) => (
                  <tr
                    key={ds.id}
                    className={`hover:bg-surface-sunken cursor-pointer ${selectedIds.has(ds.id) ? 'bg-primary-subtle/50' : ''}`}
                    onClick={() => toggleId(ds.id)}
                  >
                    <td className="text-center px-2 py-1.5">
                      <Checkbox
                        checked={selectedIds.has(ds.id)}
                        onChange={() => toggleId(ds.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td className="px-2 py-1.5 text-fg-faint text-xs">{ds.id}</td>
                    <td className="px-2 py-1.5 text-fg max-w-sm">
                      <div className="truncate text-xs">{ds.question}</div>
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge variant="secondary">{t(CATEGORY_KEYS[ds.category] ?? 'eval.categoryTopic')}</Badge>
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge
                        variant={
                          ds.difficulty === 'easy' ? 'success' : ds.difficulty === 'hard' ? 'destructive' : 'warning'
                        }
                      >
                        {t(DIFFICULTY_KEYS[ds.difficulty] ?? 'eval.medium')}
                      </Badge>
                    </td>
                    <td className="px-2 py-1.5 text-fg-muted text-xs">{ds.language}</td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-fg-faint py-8 text-sm">
                      {t('eval.noMatchingDatasets')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between pt-2 border-t border-edge">
            <div className="text-xs text-fg-faint">
              {t('eval.runSummary', { count: selectedIds.size, profile: selectedProfileId })}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleStart} disabled={starting || selectedIds.size === 0}>
                {starting ? (
                  <>
                    <Spinner className="mr-2" /> {t('eval.starting')}
                  </>
                ) : (
                  t('eval.runTests', { count: selectedIds.size })
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ─── Compare Dialog ──────────────────────────────────────

function CompareDialog({ open, onClose, selectedIds }: { open: boolean; onClose: () => void; selectedIds: string[] }) {
  const t = useT();
  const [comparison, setComparison] = useState<{
    runs: evalApi.EvalRun[];
    results: Record<number, Record<string, evalApi.EvalResult>>;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || selectedIds.length < 2) {
      setComparison(null);
      return;
    }
    setLoading(true);
    evalApi
      .compareRuns(selectedIds)
      .then((data) => {
        setComparison(data);
        setLoading(false);
      })
      .catch((err) => {
        console.warn('Failed to compare runs:', err);
        setLoading(false);
      });
  }, [open, selectedIds]);

  return (
    <Dialog open={open} onClose={onClose} title={t('eval.compareRuns')} size="workspace">
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner className="text-primary-500" />
        </div>
      ) : comparison ? (
        <div className="space-y-4 max-h-[min(70dvh,44rem)] overflow-y-auto">
          {/* Summary comparison */}
          <div className="bg-surface-raised border border-edge rounded-lg overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-surface-sunken text-fg-muted">
                <tr>
                  <th className="text-left px-3 py-2">{t('eval.run')}</th>
                  <th className="text-left px-3 py-2 w-20">{t('eval.profile')}</th>
                  <th className="text-center px-3 py-2 w-16">{t('eval.score')}</th>
                  <th className="text-center px-3 py-2 w-14">{t('eval.accuracyShort')}</th>
                  <th className="text-center px-3 py-2 w-14">{t('eval.completenessShort')}</th>
                  <th className="text-center px-3 py-2 w-14">{t('eval.relevanceShort')}</th>
                  <th className="text-center px-3 py-2 w-14">{t('eval.speedShort')}</th>
                  <th className="text-center px-3 py-2 w-20">{t('eval.progress')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-edge">
                {comparison.runs.map((run) => (
                  <tr key={run.id} className="hover:bg-surface-sunken">
                    <td className="px-3 py-2">
                      <div className="font-medium text-fg">{run.name || run.id.slice(0, 8)}</div>
                      <div className="text-xs text-fg-faint">
                        {run.model} · {formatDate(run.started_at)}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="secondary">{run.profile_id}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <ScoreCell score={run.avg_score} />
                    </td>
                    <td className="px-3 py-2">
                      <ScoreCell score={run.avg_accuracy} />
                    </td>
                    <td className="px-3 py-2">
                      <ScoreCell score={run.avg_completeness} />
                    </td>
                    <td className="px-3 py-2">
                      <ScoreCell score={run.avg_relevance} />
                    </td>
                    <td className="px-3 py-2">
                      <ScoreCell score={run.avg_speed} />
                    </td>
                    <td className="px-3 py-2 text-center text-xs">
                      <span className="text-success">✓{run.passed}</span>
                      {run.failed > 0 && <span className="text-danger ml-1">✗{run.failed}</span>}
                      <span className="text-fg-faint">/{run.total}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Per-question comparison */}
          <div className="bg-surface-raised border border-edge rounded-lg overflow-hidden">
            <div className="px-4 py-2 bg-surface-sunken border-b border-edge">
              <h3 className="text-sm font-medium text-fg-secondary">{t('eval.perQuestionScores')}</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-surface-sunken text-fg-muted text-xs">
                  <tr>
                    <th className="text-left px-3 py-2 sticky left-0 bg-surface-sunken z-10">#</th>
                    <th className="text-left px-3 py-2 min-w-[200px]">{t('eval.question')}</th>
                    {comparison.runs.map((run) => (
                      <th key={run.id} className="text-center px-3 py-2 min-w-[80px]">
                        <div className="truncate max-w-[100px]">{run.name || run.id.slice(0, 6)}</div>
                        {run.profile_id !== 'team' && <div className="text-[9px] text-info">{run.profile_id}</div>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge">
                  {Object.entries(comparison.results).map(([dsId, runResults]) => {
                    const firstResult = Object.values(runResults)[0];
                    if (!firstResult) return null;
                    return (
                      <tr key={dsId} className="hover:bg-surface-sunken">
                        <td className="px-3 py-1.5 text-fg-faint text-xs sticky left-0 bg-surface-raised">{dsId}</td>
                        <td className="px-3 py-1.5 text-fg-secondary text-xs truncate max-w-[250px]">
                          {firstResult.question}
                        </td>
                        {comparison.runs.map((run) => {
                          const r = runResults[run.id];
                          return (
                            <td key={run.id} className="px-3 py-1.5 text-center">
                              {r ? <ScoreCell score={r.score_final} /> : <span className="text-fg-faint">—</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="text-center py-8 text-fg-faint text-sm">{t('eval.selectTwoRuns')}</div>
      )}
    </Dialog>
  );
}

// ─── Runs Panel ──────────────────────────────────────────

export function RunsPanel() {
  const t = useT();
  const [runs, setRuns] = useState<evalApi.EvalRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [showStartDialog, setShowStartDialog] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showCompare, setShowCompare] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ type: 'delete' | 'cancel'; id: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await evalApi.listRuns(50, search || undefined);
      setRuns(data);
    } catch (err) {
      console.error('Failed to load runs:', err);
    }
    setLoading(false);
  }, [search]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh when a run is in progress
  useEffect(() => {
    const hasRunning = runs.some((r) => r.status === 'running');
    if (!hasRunning) return;
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [runs, load]);

  const handleRunStarted = (runId: string) => {
    setShowStartDialog(false);
    // Navigate to the run detail
    window.location.hash = `#/administration/eval/runs/${runId}`;
  };

  const handleConfirmedAction = async () => {
    const action = confirmAction;
    if (!action) return;
    setConfirmAction(null);

    if (action.type === 'delete') {
      await evalApi.deleteRun(action.id);
      setRuns((prev) => prev.filter((r) => r.id !== action.id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(action.id);
        return next;
      });
      return;
    }

    try {
      await evalApi.cancelRun(action.id);
      load();
    } catch (_err) {
      toast(t('eval.cancelRunFailed'), 'error');
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading && runs.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="text-primary-500" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Start Run Button + Search + Compare */}
      <div className="flex items-center gap-3">
        <Button onClick={() => setShowStartDialog(true)}>{t('eval.startNewRun')}</Button>
        <div className="flex-1 max-w-xs">
          <Input placeholder={t('eval.searchRuns')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex-1" />
        {selectedIds.size >= 2 && (
          <Button variant="outline" size="sm" onClick={() => setShowCompare(true)}>
            <>
              <BarChart3 size={14} className="mr-1 inline" /> {t('eval.compareRunCount', { count: selectedIds.size })}
            </>
          </Button>
        )}
        {selectedIds.size > 0 && selectedIds.size < 2 && (
          <span className="text-xs text-fg-faint">
            {t('eval.selectMoreToCompare', { count: 2 - selectedIds.size })}
          </span>
        )}
      </div>

      {runs.length === 0 ? (
        <EmptyState icon={FlaskConical} title={t('eval.noRunsYet')} description={t('eval.startFirstRun')} />
      ) : (
        <div className="bg-surface-raised border border-edge rounded-lg overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-surface-sunken text-fg-muted">
              <tr>
                <th className="text-center px-2 py-2 w-10">
                  <Checkbox
                    checked={runs.length > 0 && runs.every((r) => selectedIds.has(r.id))}
                    onChange={(e) => {
                      if (e.target.checked) setSelectedIds(new Set(runs.map((r) => r.id)));
                      else setSelectedIds(new Set());
                    }}
                    className="rounded border-edge-strong text-primary-fg focus:ring-primary-500"
                  />
                </th>
                <th className="text-left px-3 py-2">{t('eval.run')}</th>
                <th className="text-center px-3 py-2 w-16">{t('eval.score')}</th>
                <th className="text-center px-3 py-2 w-14">{t('eval.accuracyShort')}</th>
                <th className="text-center px-3 py-2 w-14">{t('eval.completenessShort')}</th>
                <th className="text-center px-3 py-2 w-14">{t('eval.relevanceShort')}</th>
                <th className="text-center px-3 py-2 w-14">{t('eval.speedShort')}</th>
                <th className="text-center px-3 py-2 w-20">{t('common.status')}</th>
                <th className="text-center px-3 py-2 w-28">{t('eval.progress')}</th>
                <th className="text-center px-3 py-2 w-20">{t('eval.duration')}</th>
                <th className="text-center px-3 py-2 w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {runs.map((run) => (
                <tr
                  key={run.id}
                  className={`hover:bg-surface-sunken cursor-pointer ${selectedIds.has(run.id) ? 'bg-primary-subtle/50' : ''}`}
                  onClick={() => (window.location.hash = `#/administration/eval/runs/${run.id}`)}
                >
                  <td className="text-center px-2 py-2" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(run.id)}
                      onChange={() => toggleSelect(run.id)}
                      className="rounded border-edge-strong text-primary-fg focus:ring-primary-500"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-fg">{run.name || run.id.slice(0, 8)}</div>
                    <div className="text-xs text-fg-faint flex items-center gap-1.5">
                      <span className="font-mono text-[10px] select-all">{run.id.slice(0, 8)}</span>
                      <span>{run.model}</span>
                      {run.profile_id && run.profile_id !== 'team' && (
                        <span className="inline-flex items-center px-1.5 py-0 text-[10px] font-medium rounded-full bg-info-subtle text-info border border-info">
                          {run.profile_id}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <ScoreCell score={run.avg_score} />
                  </td>
                  <td className="px-3 py-2">
                    <ScoreCell score={run.avg_accuracy} />
                  </td>
                  <td className="px-3 py-2">
                    <ScoreCell score={run.avg_completeness} />
                  </td>
                  <td className="px-3 py-2">
                    <ScoreCell score={run.avg_relevance} />
                  </td>
                  <td className="px-3 py-2">
                    <ScoreCell score={run.avg_speed} />
                  </td>
                  <td className="px-3 py-2 text-center">
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
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="text-fg-secondary text-xs">
                      <span className="text-success">✓{run.passed}</span>
                      {run.failed > 0 && <span className="text-danger ml-1">✗{run.failed}</span>}
                      <span className="text-fg-faint ml-1">/{run.total}</span>
                    </div>
                    {run.status === 'running' && (
                      <div className="w-full bg-surface-muted rounded-full h-1 mt-1">
                        <div
                          className="bg-primary-500 h-1 rounded-full transition-all"
                          style={{ width: `${(run.completed / run.total) * 100}%` }}
                        />
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center text-xs text-fg-muted">
                    <RunDuration run={run} />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <div className="flex items-center justify-center gap-1">
                      {run.status === 'running' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmAction({ type: 'cancel', id: run.id });
                          }}
                          className="text-orange-500 hover:text-danger text-xs"
                          title={t('eval.stopRun')}
                        >
                          <SquareX size={12} />
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmAction({ type: 'delete', id: run.id });
                        }}
                        className="text-fg-faint hover:text-danger text-xs"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Start Run Dialog */}
      <StartRunDialog open={showStartDialog} onClose={() => setShowStartDialog(false)} onStarted={handleRunStarted} />

      {/* Compare Dialog */}
      <CompareDialog open={showCompare} onClose={() => setShowCompare(false)} selectedIds={[...selectedIds]} />

      <ConfirmDialog
        open={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        onConfirm={handleConfirmedAction}
        title={confirmAction?.type === 'delete' ? t('eval.deleteRunConfirm') : t('eval.stopRunConfirm')}
        confirmLabel={confirmAction?.type === 'delete' ? t('common.delete') : t('common.stop')}
        confirmVariant="destructive"
      />
    </div>
  );
}
