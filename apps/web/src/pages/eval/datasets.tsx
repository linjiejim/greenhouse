/**
 * Datasets sub-page — manage eval test datasets.
 *
 * Features: CRUD, batch ops, tag/status/source filtering, pagination,
 * creator tracking, archive/restore lifecycle.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Button,
  Badge,
  Input,
  Dialog,
  EmptyState,
  Spinner,
  Select,
  Textarea,
  toast,
  Checkbox,
  ConfirmDialog,
  SearchInput,
  Pagination,
} from '../../components/ui';
import {
  FileEdit,
  Sprout,
  Ban,
  Trash2,
  Archive,
  RotateCcw,
  ExternalLink,
  Pencil,
  Bot,
  Upload,
  User,
} from '../../lib/icons';
import * as evalApi from '../../lib/eval-api';
import { useT, type TranslationKey } from '../../lib/i18n';
import { formatDate } from '../../lib/utils';
import { usePersistedPageSize } from '../../hooks/use-persisted-page-size';
import { parseEvalTraceNotes } from '../../lib/eval-trace-provenance';

// ─── Constants ───────────────────────────────────────────

const CATEGORIES = ['faq', 'plant', 'product', 'guide', 'troubleshooting', 'comparison', 'negative', 'edge', 'topic'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const LANGUAGES = ['en', 'zh'];
const STATUSES = ['active', 'archived', 'deprecated'];
const SOURCES = ['manual', 'agent', 'import', 'seed'];

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
const STATUS_KEYS: Record<string, TranslationKey> = {
  active: 'eval.active',
  archived: 'eval.archived',
  deprecated: 'eval.deprecated',
};
const SOURCE_KEYS: Record<string, TranslationKey> = {
  manual: 'eval.manual',
  agent: 'eval.agent',
  import: 'eval.import',
  seed: 'eval.seed',
};

const SOURCE_ICONS: Record<string, React.ReactNode> = {
  agent: <Bot size={12} className="text-primary-500" />,
  manual: <User size={12} className="text-fg-muted" />,
  import: <Upload size={12} className="text-info" />,
  seed: <Sprout size={12} className="text-success" />,
};

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'default'> = {
  active: 'success',
  archived: 'warning',
  deprecated: 'destructive',
};

// ─── Add/Edit Dataset Dialog ─────────────────────────────

function DatasetDialog({
  open,
  onClose,
  onSaved,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  editing: evalApi.EvalDataset | null;
}) {
  const t = useT();
  const [question, setQuestion] = useState('');
  const [groundTruth, setGroundTruth] = useState('');
  const [category, setCategory] = useState('faq');
  const [difficulty, setDifficulty] = useState('medium');
  const [language, setLanguage] = useState('en');
  const [isNegative, setIsNegative] = useState(false);
  const [expectedBehavior, setExpectedBehavior] = useState('');
  const [tagsStr, setTagsStr] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editing) {
      setQuestion(editing.question);
      try {
        setGroundTruth(JSON.parse(editing.ground_truth).join('\n'));
      } catch {
        setGroundTruth(editing.ground_truth);
      }
      setCategory(editing.category);
      setDifficulty(editing.difficulty);
      setLanguage(editing.language);
      setIsNegative(editing.is_negative === 1);
      setExpectedBehavior(editing.expected_behavior || '');
      try {
        const tags = JSON.parse(editing.tags || '[]');
        setTagsStr(tags.join(', '));
      } catch {
        setTagsStr('');
      }
      setNotes(parseEvalTraceNotes(editing.notes).notes);
    } else {
      setQuestion('');
      setGroundTruth('');
      setCategory('faq');
      setDifficulty('medium');
      setLanguage('en');
      setIsNegative(false);
      setExpectedBehavior('');
      setTagsStr('');
      setNotes('');
    }
  }, [editing, open]);

  const handleSave = async () => {
    if (!question.trim() || !groundTruth.trim()) return;
    setSaving(true);
    try {
      const facts = groundTruth.split('\n').filter((l) => l.trim());
      const tags = tagsStr
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      const payload: evalApi.DatasetInput = {
        category,
        difficulty,
        language,
        question: question.trim(),
        ground_truth: JSON.stringify(facts),
        is_negative: isNegative,
        expected_behavior: expectedBehavior.trim() || undefined,
        tags,
        notes: notes.trim() || undefined,
      };
      if (editing) {
        await evalApi.updateDataset(editing.id, payload);
      } else {
        await evalApi.createDataset(payload);
      }
      onSaved();
    } catch (_err) {
      toast(
        t('eval.datasetSaveFailed', {
          action: t(editing ? 'eval.updateAction' : 'eval.createAction'),
        }),
        'error',
      );
    }
    setSaving(false);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? t('eval.editTestCase', { id: editing.id }) : t('eval.addTestCase')}
    >
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-fg-secondary mb-1">{t('eval.question')}</label>
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            className="h-20"
            placeholder={t('eval.enterTestQuestion')}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-fg-secondary mb-1">{t('eval.groundTruth')}</label>
          <Textarea
            value={groundTruth}
            onChange={(e) => setGroundTruth(e.target.value)}
            className="h-28"
            placeholder={t('eval.facts')}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-fg-secondary mb-1">{t('eval.expectedBehavior')}</label>
          <Textarea
            value={expectedBehavior}
            onChange={(e) => setExpectedBehavior(e.target.value)}
            className="h-14"
            placeholder={t('eval.expectedBehaviorPlaceholder')}
          />
        </div>
        <div className="flex gap-3">
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="flex-1">
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(CATEGORY_KEYS[c])}
              </option>
            ))}
          </Select>
          <Select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} className="flex-1">
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>
                {t(DIFFICULTY_KEYS[d])}
              </option>
            ))}
          </Select>
          <Select value={language} onChange={(e) => setLanguage(e.target.value)} className="flex-1">
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {t(l === 'en' ? 'eval.english' : 'eval.chinese')}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="block text-sm font-medium text-fg-secondary mb-1">{t('eval.tagsCommaSeparated')}</label>
          <Input value={tagsStr} onChange={(e) => setTagsStr(e.target.value)} placeholder={t('eval.tagsPlaceholder')} />
        </div>
        <div>
          <label className="block text-sm font-medium text-fg-secondary mb-1">{t('eval.notes')}</label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="h-14"
            placeholder={t('eval.notesPlaceholder')}
          />
        </div>
        <Checkbox
          label={t('eval.negativeTest')}
          checked={isNegative}
          onChange={(e) => setIsNegative(e.target.checked)}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || !question.trim() || !groundTruth.trim()}>
            {saving ? t('common.saving') : t(editing ? 'common.update' : 'common.add')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ─── Batch Action Bar ────────────────────────────────────

function BatchBar({
  count,
  onAction,
  onClear,
}: {
  count: number;
  onAction: (action: string) => void;
  onClear: () => void;
}) {
  const t = useT();
  if (count === 0) return null;
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-primary-500/10 border border-primary-500/30 rounded-lg animate-fade-in">
      <span className="text-sm font-medium text-fg">{t('common.selected', { count })}</span>
      <div className="flex-1" />
      <Button size="sm" variant="outline" onClick={() => onAction('enable')}>
        {t('eval.enable')}
      </Button>
      <Button size="sm" variant="outline" onClick={() => onAction('disable')}>
        {t('eval.disable')}
      </Button>
      <Button size="sm" variant="outline" onClick={() => onAction('archive')}>
        <>
          <Archive size={12} className="mr-1 inline" />
          {t('common.archive')}
        </>
      </Button>
      <Button size="sm" variant="outline" onClick={() => onAction('restore')}>
        <>
          <RotateCcw size={12} className="mr-1 inline" />
          {t('common.restore')}
        </>
      </Button>
      <Button size="sm" variant="destructive" onClick={() => onAction('delete')}>
        <>
          <Trash2 size={12} className="mr-1 inline" />
          {t('common.delete')}
        </>
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear}>
        {t('eval.clear')}
      </Button>
    </div>
  );
}

// ─── Datasets Panel ──────────────────────────────────────

export function DatasetsPanel() {
  const t = useT();
  const [datasets, setDatasets] = useState<evalApi.EvalDataset[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePersistedPageSize('eval.datasets', 30);

  // Filters
  const [catFilter, setCatFilter] = useState('all');
  const [diffFilter, setDiffFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('active');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');

  // UI state
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [showDialog, setShowDialog] = useState(false);
  const [editingDs, setEditingDs] = useState<evalApi.EvalDataset | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState<{ ids: number[]; single?: boolean } | null>(null);
  const [isEmpty, setIsEmpty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await evalApi.listDatasets({
        category: catFilter !== 'all' ? catFilter : undefined,
        difficulty: diffFilter !== 'all' ? diffFilter : undefined,
        status: statusFilter !== 'all' ? statusFilter : undefined,
        source: sourceFilter !== 'all' ? sourceFilter : undefined,
        search: search.trim() || undefined,
        tags: tagFilter || undefined,
        page,
        page_size: pageSize,
        sort_by: 'id',
        sort_order: 'desc',
      });
      setDatasets(result.datasets);
      setTotal(result.total);
      setIsEmpty(
        result.total === 0 &&
          !search &&
          catFilter === 'all' &&
          diffFilter === 'all' &&
          statusFilter === 'active' &&
          sourceFilter === 'all' &&
          !tagFilter,
      );
    } catch (err) {
      console.error('Failed to load datasets:', err);
    }
    setLoading(false);
  }, [catFilter, diffFilter, statusFilter, sourceFilter, search, tagFilter, page, pageSize]);

  useEffect(() => {
    load();
  }, [load]);

  // Reset page when filters or page size change
  useEffect(() => {
    setPage(1);
  }, [catFilter, diffFilter, statusFilter, sourceFilter, search, tagFilter, pageSize]);

  // All tags from loaded datasets (for tag chips)
  const allTags = useMemo(() => {
    const tags = new Set<string>();
    datasets.forEach((d) => {
      try {
        JSON.parse(d.tags || '[]').forEach((t: string) => tags.add(t));
      } catch {
        /* ignore malformed JSON */
      }
    });
    return [...tags].sort();
  }, [datasets]);

  const handleSeed = async () => {
    try {
      const result = await evalApi.seedDatasets();
      if ((result as any).error) {
        toast((result as any).error, 'error');
        return;
      }
      await load();
    } catch (_err) {
      toast(t('eval.seedFailed'), 'error');
    }
  };

  const handleToggle = async (ds: evalApi.EvalDataset) => {
    await evalApi.updateDataset(ds.id, { enabled: !ds.enabled });
    setDatasets((prev) => prev.map((d) => (d.id === ds.id ? { ...d, enabled: d.enabled ? 0 : 1 } : d)));
  };

  const handleEdit = (ds: evalApi.EvalDataset) => {
    setEditingDs(ds);
    setShowDialog(true);
  };

  const handleBatchAction = async (action: string) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;

    if (action === 'delete') {
      setConfirmDelete({ ids });
      return;
    }

    try {
      await evalApi.batchUpdateDatasets(action, ids);
      toast(t('eval.batchApplied', { action, count: ids.length }), 'success');
      setSelectedIds(new Set());
      load();
    } catch {
      toast(t('eval.batchFailed', { action }), 'error');
    }
  };

  const handleDeleteConfirmed = async () => {
    if (!confirmDelete) return;
    try {
      if (confirmDelete.single) {
        await evalApi.deleteDataset(confirmDelete.ids[0]);
      } else {
        await evalApi.batchUpdateDatasets('delete', confirmDelete.ids);
      }
      toast(t('eval.deletedItems', { count: confirmDelete.ids.length }), 'success');
      setSelectedIds(new Set());
      setConfirmDelete(null);
      load();
    } catch {
      toast(t('common.deleteFailed'), 'error');
    }
  };

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === datasets.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(datasets.map((d) => d.id)));
    }
  };

  if (loading && datasets.length === 0) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spinner className="text-primary-500" />
      </div>
    );
  }

  if (isEmpty && datasets.length === 0) {
    return (
      <EmptyState
        icon={FileEdit}
        title={t('eval.noDatasetsYet')}
        description={t('eval.seedTestCases')}
        action={
          <Button onClick={handleSeed} size="sm">
            <Sprout size={14} className="mr-1" /> {t('eval.seedInitialDatasets')}
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <SearchInput value={search} onChange={setSearch} placeholder={t('eval.searchQuestions')} className="w-48" />
        <Select inline value={catFilter} onChange={(e) => setCatFilter(e.target.value)} size="sm">
          <option value="all">{t('eval.allCategories')}</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(CATEGORY_KEYS[c])}
            </option>
          ))}
        </Select>
        <Select inline value={diffFilter} onChange={(e) => setDiffFilter(e.target.value)} size="sm">
          <option value="all">{t('eval.allDifficulties')}</option>
          {DIFFICULTIES.map((d) => (
            <option key={d} value={d}>
              {t(DIFFICULTY_KEYS[d])}
            </option>
          ))}
        </Select>
        <Select inline value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} size="sm">
          <option value="all">{t('eval.allStatus')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(STATUS_KEYS[s])}
            </option>
          ))}
        </Select>
        <Select inline value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} size="sm">
          <option value="all">{t('eval.allSources')}</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {t(SOURCE_KEYS[s])}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        <span className="text-sm text-fg-faint">
          {datasets.length} / {total}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditingDs(null);
            setShowDialog(true);
          }}
        >
          + {t('common.add')}
        </Button>
      </div>

      {/* Tag chips (quick filter) */}
      {allTags.length > 0 && (
        <div className="flex items-center gap-1 flex-wrap">
          <span className="text-xs text-fg-faint mr-1">{t('common.tags')}:</span>
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setTagFilter(tagFilter === tag ? '' : tag)}
              className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                tagFilter === tag
                  ? 'bg-primary-500 text-white border-primary-500'
                  : 'bg-surface-sunken text-fg-muted border-edge hover:border-edge-strong'
              }`}
            >
              {tag}
            </button>
          ))}
          {tagFilter && (
            <button onClick={() => setTagFilter('')} className="text-xs text-fg-faint hover:text-fg-muted ml-1">
              {t('eval.clear')}
            </button>
          )}
        </div>
      )}

      {/* Batch action bar */}
      <BatchBar count={selectedIds.size} onAction={handleBatchAction} onClear={() => setSelectedIds(new Set())} />

      {/* Table */}
      <div className="bg-surface-raised border border-edge rounded-lg overflow-hidden overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]">
          <thead className="bg-surface-sunken text-fg-muted">
            <tr>
              <th className="text-center px-2 py-2 w-10">
                <Checkbox
                  checked={selectedIds.size === datasets.length && datasets.length > 0}
                  onChange={toggleSelectAll}
                />
              </th>
              <th className="text-left px-3 py-2 w-10">#</th>
              <th className="text-left px-3 py-2">{t('eval.question')}</th>
              <th className="text-left px-3 py-2 w-24">{t('eval.category')}</th>
              <th className="text-left px-3 py-2 w-20">{t('eval.difficultyShort')}</th>
              <th className="text-left px-3 py-2 w-14 hidden lg:table-cell">{t('eval.languageShort')}</th>
              <th className="text-center px-3 py-2 w-16">{t('common.status')}</th>
              <th className="text-center px-3 py-2 w-16">{t('eval.source')}</th>
              <th className="text-center px-3 py-2 w-14">{t('eval.enabledShort')}</th>
              <th className="text-left px-3 py-2 w-28 hidden md:table-cell">{t('eval.created')}</th>
              <th className="text-center px-3 py-2 w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {datasets.map((ds) => {
              const traceNotes = parseEvalTraceNotes(ds.notes);

              return (
                <React.Fragment key={ds.id}>
                  <tr
                    className={`hover:bg-surface-sunken cursor-pointer ${ds.status !== 'active' ? 'opacity-60' : ''}`}
                    onClick={() => setExpandedId(expandedId === ds.id ? null : ds.id)}
                  >
                    <td className="px-2 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={selectedIds.has(ds.id)} onChange={() => toggleSelect(ds.id)} />
                    </td>
                    <td className="px-3 py-2 text-fg-faint">{ds.id}</td>
                    <td className="px-3 py-2 text-fg max-w-md truncate" title={ds.question}>
                      {ds.question}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant="secondary">{ds.category}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        variant={
                          ds.difficulty === 'easy' ? 'success' : ds.difficulty === 'hard' ? 'destructive' : 'warning'
                        }
                      >
                        {t(DIFFICULTY_KEYS[ds.difficulty] ?? 'eval.medium')}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-fg-muted hidden lg:table-cell">{ds.language}</td>
                    <td className="px-3 py-2 text-center">
                      <Badge variant={STATUS_VARIANT[ds.status] || 'default'}>
                        {t(STATUS_KEYS[ds.status] ?? 'eval.active')}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span
                        className="inline-flex items-center gap-1 text-xs"
                        title={t(SOURCE_KEYS[ds.source] ?? 'eval.manual')}
                      >
                        {SOURCE_ICONS[ds.source] || null}
                        <span className="hidden sm:inline">{t(SOURCE_KEYS[ds.source] ?? 'eval.manual')}</span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => handleToggle(ds)}
                        className={`w-4 h-4 rounded border transition-colors ${ds.enabled ? 'bg-primary-500 border-primary-500' : 'bg-surface-raised border-edge-strong'}`}
                      />
                    </td>
                    <td className="px-3 py-2 text-[11px] text-fg-faint whitespace-nowrap hidden md:table-cell">
                      {ds.created_at ? formatDate(ds.created_at) : '-'}
                    </td>
                    <td className="px-3 py-2 text-center" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-1 justify-center">
                        <button
                          onClick={() => handleEdit(ds)}
                          className="text-fg-faint hover:text-primary-500 p-1"
                          title={t('common.edit')}
                        >
                          <Pencil size={12} />
                        </button>
                        {ds.status === 'active' ? (
                          <button
                            onClick={async () => {
                              await evalApi.updateDataset(ds.id, { status: 'archived' });
                              load();
                            }}
                            className="text-fg-faint hover:text-warning p-1"
                            title={t('common.archive')}
                          >
                            <Archive size={12} />
                          </button>
                        ) : (
                          <button
                            onClick={async () => {
                              await evalApi.updateDataset(ds.id, { status: 'active' });
                              load();
                            }}
                            className="text-fg-faint hover:text-success p-1"
                            title={t('common.restore')}
                          >
                            <RotateCcw size={12} />
                          </button>
                        )}
                        <button
                          onClick={() => setConfirmDelete({ ids: [ds.id], single: true })}
                          className="text-fg-faint hover:text-danger p-1"
                          title={t('common.delete')}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === ds.id && (
                    <tr>
                      <td colSpan={11} className="px-6 py-3 bg-surface-sunken">
                        <div className="space-y-2 text-sm">
                          <div>
                            <span className="font-medium text-fg-muted">{t('eval.groundTruthShort')}</span>
                          </div>
                          <ul className="list-disc list-inside text-fg-secondary space-y-0.5">
                            {(() => {
                              try {
                                return JSON.parse(ds.ground_truth);
                              } catch {
                                return [ds.ground_truth];
                              }
                            })().map((fact: string, i: number) => (
                              <li key={i}>{fact}</li>
                            ))}
                          </ul>
                          {ds.expected_behavior && (
                            <div className="text-fg-muted">
                              <span className="font-medium">{t('eval.expectedBehaviorShort')}</span>{' '}
                              {ds.expected_behavior}
                            </div>
                          )}
                          {ds.tags && ds.tags !== '[]' && (
                            <div className="flex gap-1 flex-wrap items-center">
                              <span className="text-fg-faint text-xs">{t('common.tags')}:</span>
                              {(() => {
                                try {
                                  return JSON.parse(ds.tags);
                                } catch {
                                  return [];
                                }
                              })().map((tag: string) => (
                                <button
                                  key={tag}
                                  onClick={() => setTagFilter(tag)}
                                  className="text-xs px-2 py-0.5 rounded-full bg-surface-raised border border-edge hover:border-primary-500 transition-colors"
                                >
                                  {tag}
                                </button>
                              ))}
                            </div>
                          )}
                          {traceNotes.notes && (
                            <div className="text-fg-muted">
                              <span className="font-medium">{t('eval.notesShort')}</span> {traceNotes.notes}
                            </div>
                          )}
                          <div className="flex gap-4 text-xs text-fg-faint pt-1">
                            {ds.is_negative === 1 && (
                              <span className="flex items-center gap-1">
                                <Ban size={10} className="text-danger" /> {t('eval.negativeTestShort')}
                              </span>
                            )}
                            {ds.source_session_id && (
                              <a
                                href={`#/chat?session=${encodeURIComponent(ds.source_session_id)}`}
                                className="flex items-center gap-1 text-primary-500 hover:underline"
                              >
                                <ExternalLink size={10} /> {t('eval.viewSourceConversation')}
                              </a>
                            )}
                            {traceNotes.provenance && (
                              <a
                                href={`#/executions/${encodeURIComponent(traceNotes.provenance.runtime_kind)}/${encodeURIComponent(traceNotes.provenance.runtime_run_id)}`}
                                className="flex items-center gap-1 text-primary-500 hover:underline"
                              >
                                <ExternalLink size={10} /> {t('eval.viewSourceRuntime')}
                              </a>
                            )}
                            {ds.created_by && (
                              <span>{t('eval.createdBy', { name: `${ds.created_by.slice(0, 8)}…` })}</span>
                            )}
                            {ds.updated_by && (
                              <span>{t('eval.updatedBy', { name: `${ds.updated_by.slice(0, 8)}…` })}</span>
                            )}
                            {ds.archived_at && (
                              <span>{t('eval.archivedAt', { date: formatDate(ds.archived_at) })}</span>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
            {datasets.length === 0 && !loading && (
              <tr>
                <td colSpan={11} className="px-3 py-12 text-center text-fg-faint">
                  {t('eval.noDatasetsMatch')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination — local page state is 1-based; <Pagination> is 0-based. */}
      <Pagination
        page={page - 1}
        pageSize={pageSize}
        total={total}
        onPageChange={(p) => setPage(p + 1)}
        onPageSizeChange={setPageSize}
      />

      {/* Dialogs */}
      <DatasetDialog
        open={showDialog}
        onClose={() => {
          setShowDialog(false);
          setEditingDs(null);
        }}
        onSaved={() => {
          setShowDialog(false);
          setEditingDs(null);
          load();
        }}
        editing={editingDs}
      />

      <ConfirmDialog
        open={!!confirmDelete}
        title={t('eval.deleteDatasets')}
        description={confirmDelete ? t('eval.deleteDatasetsConfirm', { count: confirmDelete.ids.length }) : ''}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
        onConfirm={handleDeleteConfirmed}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}
