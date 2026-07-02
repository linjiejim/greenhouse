/**
 * KnowledgeDetail — read-only Markdown view, laid out flat on the page.
 *
 * The title/tags/time and actions (Edit, Archive, History) live in the page's
 * top bar; this component renders only the body: a borderless collapsible TOC
 * and the flat Markdown content with optional questions/topics.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KnowledgeDoc, KnowledgeDocVersion } from '@greenhouse/types/api';
import { Badge, Button, Dialog, Spinner, toast } from '../ui';
import { Markdown, extractHeadings } from '../markdown';
import { ChevronLeft, Eye, EyeOff, Files, HelpCircle, RotateCcw } from '../../lib/icons';
import { safeParse, formatDate } from '../../lib/utils';
import { listKnowledgeVersions, restoreKnowledgeVersion } from '../../lib/api/knowledge';
import { computeLineDiffWithWords, type DiffLine } from '../../lib/wiki-diff';
import { renderDiffWords } from '../../lib/diff-words';
import { useT } from '../../lib/i18n';

interface KnowledgeDetailProps {
  doc: KnowledgeDoc;
}

export function KnowledgeDetail({ doc }: KnowledgeDetailProps) {
  const t = useT();
  const contentRef = useRef<HTMLDivElement>(null);
  const [tocCollapsed, setTocCollapsed] = useState(false);
  const questions = safeParse<string[]>(doc.questions, []);
  const topics = safeParse<string[]>(doc.topics, []);
  const headings = useMemo(() => extractHeadings(doc.content_markdown || ''), [doc.content_markdown]);

  const scrollToHeading = (targetId: string) => {
    const root = contentRef.current;
    if (!root) return;
    const allHeadings = root.querySelectorAll('h1, h2, h3, h4');
    for (const heading of allHeadings) {
      const text = heading.textContent || '';
      const id = text
        .toLowerCase()
        .replace(/[^a-z0-9一-鿿]+/g, '-')
        .replace(/(^-|-$)/g, '');
      if (id === targetId) {
        heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    }
  };

  return (
    <div className="h-full flex overflow-hidden">
      {/* TOC — borderless, just a vertical divider, collapsible */}
      {headings.length > 0 && (
        <aside
          className={`hidden lg:flex flex-col border-r border-edge p-3 overflow-y-auto flex-shrink-0 transition-[width] duration-200 ${
            tocCollapsed ? 'w-10 items-center' : 'w-56'
          }`}
        >
          <button
            type="button"
            onClick={() => setTocCollapsed((v) => !v)}
            title={tocCollapsed ? t('knowledge.expandToc') : t('knowledge.collapseToc')}
            className="flex items-center gap-1.5 text-xs font-semibold text-fg-faint hover:text-fg uppercase tracking-wide mb-2 transition-colors"
          >
            <Files size={12} />
            {!tocCollapsed && <span className="flex-1 text-left">{t('knowledge.onThisPage')}</span>}
            {!tocCollapsed && <ChevronLeft size={12} />}
          </button>
          {!tocCollapsed && (
            <nav className="space-y-0.5">
              {headings.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => scrollToHeading(h.id)}
                  className="block w-full text-left text-xs text-fg-muted hover:text-primary-fg py-1 truncate transition-colors"
                  style={{ paddingLeft: `${Math.max(0, h.level - 1) * 10}px` }}
                  title={h.text}
                >
                  {h.text}
                </button>
              ))}
            </nav>
          )}
        </aside>
      )}

      <main ref={contentRef} className="flex-1 overflow-y-auto px-3 md:px-6 py-4 scroll-smooth">
        <div className="max-w-4xl mx-auto">
          {doc.summary && <p className="text-sm text-fg-muted italic mb-4">{doc.summary}</p>}

          {/* Content — flat, no card */}
          <Markdown content={doc.content_markdown || ''} />

          {questions.length > 0 && (
            <section className="mt-8 border-t border-edge pt-4">
              <h3 className="text-sm font-semibold text-fg-secondary mb-2 flex items-center gap-1.5">
                <HelpCircle size={14} /> {t('knowledge.commonQuestions')}
              </h3>
              <ul className="space-y-1 text-sm text-fg-muted">
                {questions.map((q) => (
                  <li key={q} className="flex gap-2">
                    <span className="text-fg-faint">•</span>
                    <span>{q}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {topics.length > 0 && (
            <section className="mt-6 border-t border-edge pt-4">
              <h3 className="text-sm font-semibold text-fg-secondary mb-2 flex items-center gap-1.5">
                <Files size={14} /> {t('knowledge.relatedTopics')}
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {topics.map((topic) => (
                  <Badge key={topic} variant="secondary">
                    {topic}
                  </Badge>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * Version history dialog — opened from the detail top bar.
 *
 * Each row shows what THAT change did: the diff of the previous snapshot → this
 * snapshot (all snapshots come back from listVersions, so no extra fetch), plus
 * a stat line (which fields changed, chars before→after, line +/-). The body diff
 * renders inline or side-by-side. Restoring is non-destructive: the backend
 * records the rollback as a brand-new version, so history is always preserved.
 */
export function KnowledgeVersionsDialog({
  doc,
  open,
  onClose,
  onRestored,
}: {
  doc: KnowledgeDoc;
  open: boolean;
  onClose: () => void;
  onRestored?: (doc: KnowledgeDoc) => void;
}) {
  const t = useT();
  const [versions, setVersions] = useState<KnowledgeDocVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [diffVersion, setDiffVersion] = useState<number | null>(null);
  const [confirmVersion, setConfirmVersion] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    listKnowledgeVersions(doc.id)
      .then(setVersions)
      .catch(() => setVersions([]))
      .finally(() => setLoading(false));
  }, [doc.id]);

  useEffect(() => {
    if (!open) return;
    setDiffVersion(null);
    setConfirmVersion(null);
    reload();
  }, [open, reload]);

  const handleRestore = async (version: number) => {
    setRestoring(version);
    try {
      const restored = await restoreKnowledgeVersion(doc.id, version);
      toast(t('knowledge.restoredToVersion', { version }), 'success');
      setConfirmVersion(null);
      setDiffVersion(null);
      onRestored?.(restored);
      reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('knowledge.restoreFailed'), 'error');
    } finally {
      setRestoring(null);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('knowledge.versionHistory')} size="xl">
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-fg-faint py-4">
          <Spinner /> {t('knowledge.loadingVersions')}
        </div>
      ) : versions.length === 0 ? (
        <p className="text-sm text-fg-faint py-4">{t('knowledge.noVersions')}</p>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
          {versions.map((v, idx) => {
            const isLatest = idx === 0;
            // versions are newest-first, so idx+1 is the snapshot this change was made against.
            const prev = versions[idx + 1];
            const showDiff = diffVersion === v.version;
            const fields = changedFields(prev, v);
            const charDelta = (v.content_markdown || '').length - (prev?.content_markdown || '').length;
            return (
              <div key={v.id} className="text-sm border border-edge rounded-md px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-fg">v{v.version}</span>
                    {isLatest && <span className="text-[10px] text-fg-faint">{t('knowledge.currentTag')}</span>}
                    <span className="text-fg-muted truncate">{v.change_reason || t('knowledge.updatedReason')}</span>
                    <FieldBadges fields={fields} />
                    {charDelta !== 0 && (
                      <span className={`text-[10px] font-mono ${charDelta > 0 ? 'text-success' : 'text-danger'}`}>
                        {charDelta > 0 ? '+' : '−'}
                        {Math.abs(charDelta).toLocaleString()} {t('knowledge.charsWord')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <span className="text-xs text-fg-faint mr-1">{v.created_at ? formatDate(v.created_at) : '—'}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      title={t('knowledge.viewChange')}
                      onClick={() => setDiffVersion(showDiff ? null : v.version)}
                    >
                      {showDiff ? <EyeOff size={13} /> : <Eye size={13} />}
                    </Button>
                    {!isLatest &&
                      (confirmVersion === v.version ? (
                        <>
                          <Button size="sm" disabled={restoring === v.version} onClick={() => handleRestore(v.version)}>
                            {restoring === v.version ? <Spinner className="mr-1" /> : null}
                            {t('common.confirm')}
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setConfirmVersion(null)}>
                            {t('common.cancel')}
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          title={t('knowledge.restoreToVersion')}
                          onClick={() => setConfirmVersion(v.version)}
                        >
                          <RotateCcw size={13} className="mr-1" /> {t('common.restore')}
                        </Button>
                      ))}
                  </div>
                </div>
                {showDiff && <VersionChangeDetail before={prev} after={v} />}
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}

// ─── Version change helpers ──────────────────────────────

type ChangedField = 'title' | 'content' | 'summary';

/** Which top-level fields differ between the previous snapshot and this one. */
function changedFields(before: KnowledgeDocVersion | undefined, after: KnowledgeDocVersion): ChangedField[] {
  const fields: ChangedField[] = [];
  if ((before?.title ?? '') !== after.title) fields.push('title');
  if ((before?.content_markdown ?? '') !== (after.content_markdown ?? '')) fields.push('content');
  if ((before?.summary ?? '') !== (after.summary ?? '')) fields.push('summary');
  return fields;
}

function FieldBadges({ fields }: { fields: ChangedField[] }) {
  const t = useT();
  if (fields.length === 0) return null;
  const label: Record<ChangedField, string> = {
    title: t('knowledge.fieldTitle'),
    content: t('knowledge.fieldContent'),
    summary: t('knowledge.fieldSummary'),
  };
  return (
    <span className="flex items-center gap-1">
      {fields.map((f) => (
        <Badge key={f} variant="secondary">
          {label[f]}
        </Badge>
      ))}
    </span>
  );
}

/**
 * Detail panel for one change: previous snapshot → this snapshot. Header shows
 * the version step, chars before→after and line +/-; body renders the diff
 * inline or side-by-side. `before` is undefined for the initial (creation)
 * version, so the whole body reads as added.
 */
function VersionChangeDetail({ before, after }: { before?: KnowledgeDocVersion; after: KnowledgeDocVersion }) {
  const t = useT();
  const [layout, setLayout] = useState<'inline' | 'split'>('inline');
  const beforeBody = before?.content_markdown ?? '';
  const afterBody = after.content_markdown ?? '';
  const diffLines = useMemo(() => computeLineDiffWithWords(beforeBody, afterBody, 300), [beforeBody, afterBody]);
  const { added, removed } = useMemo(() => {
    let a = 0;
    let r = 0;
    for (const l of diffLines) {
      if (l.type === 'add') a++;
      else if (l.type === 'remove') r++;
    }
    return { added: a, removed: r };
  }, [diffLines]);
  const bodyChanged = beforeBody !== afterBody;
  const titleChanged = (before?.title ?? '') !== after.title;
  const summaryChanged = (before?.summary ?? '') !== (after.summary ?? '');

  return (
    <div className="mt-2 border-t border-edge pt-2">
      <div className="flex items-center justify-between gap-2 mb-1.5 flex-wrap">
        <div className="flex items-center gap-2 text-[11px] text-fg-faint">
          <span className="font-mono text-fg-muted">
            {before ? `v${before.version} → v${after.version}` : t('knowledge.initialVersion')}
          </span>
          {bodyChanged && (
            <span className="font-mono">
              {beforeBody.length.toLocaleString()} → {afterBody.length.toLocaleString()} {t('knowledge.charsWord')}
              {added > 0 && <span className="text-success ml-1.5">+{added}</span>}
              {removed > 0 && <span className="text-danger ml-1">−{removed}</span>}
            </span>
          )}
        </div>
        {bodyChanged && (
          <div className="flex items-center gap-0.5 bg-surface-muted rounded-md p-0.5">
            {(['inline', 'split'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setLayout(mode)}
                className={`px-2 py-0.5 text-[10px] rounded transition-colors ${
                  layout === mode
                    ? 'bg-surface-raised text-fg font-medium shadow-sm'
                    : 'text-fg-faint hover:text-fg-secondary'
                }`}
              >
                {mode === 'inline' ? t('knowledge.diffInline') : t('knowledge.diffSplit')}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Title / summary changes read as short before→after lines, not a body diff. */}
      {(titleChanged || summaryChanged) && (
        <div className="mb-1.5 space-y-0.5">
          {titleChanged && (
            <MetaChange label={t('knowledge.fieldTitle')} before={before?.title ?? ''} after={after.title} />
          )}
          {summaryChanged && (
            <MetaChange
              label={t('knowledge.fieldSummary')}
              before={before?.summary ?? ''}
              after={after.summary ?? ''}
            />
          )}
        </div>
      )}

      {bodyChanged ? (
        layout === 'inline' ? (
          <InlineDiff lines={diffLines} />
        ) : (
          <SplitDiff lines={diffLines} />
        )
      ) : (
        <p className="text-[11px] text-fg-faint">{t('knowledge.noContentChange')}</p>
      )}
    </div>
  );
}

/** One field's before→after value, shown for title/summary changes. */
function MetaChange({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <div className="text-[11px] flex flex-wrap items-baseline gap-1.5">
      <span className="text-fg-faint">{label}:</span>
      {before ? (
        <span className="text-danger line-through decoration-danger/50">{before}</span>
      ) : (
        <span className="text-fg-faint italic">∅</span>
      )}
      <span className="text-fg-faint">→</span>
      {after ? <span className="text-success-fg">{after}</span> : <span className="text-fg-faint italic">∅</span>}
    </div>
  );
}

/** Unified inline diff: one column, +/- gutter, word-level highlights. */
function InlineDiff({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="rounded border border-edge overflow-auto max-h-[55vh] text-[11px] font-mono leading-relaxed">
      {lines.map((line, i) => (
        <div
          key={i}
          className={`px-2 py-0.5 ${line.type === 'add' ? 'bg-success-subtle' : line.type === 'remove' ? 'bg-danger-subtle' : ''}`}
        >
          <span className="inline-block w-4 text-right mr-2 text-fg-faint select-none text-[10px]">
            {line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}
          </span>
          {line.type === 'same' ? (
            <span className="text-fg-secondary">{line.text}</span>
          ) : line.type === 'remove' ? (
            <span className="text-danger">{line.words ? renderDiffWords(line.words, 'remove') : line.text}</span>
          ) : (
            <span className="text-success-fg">{line.words ? renderDiffWords(line.words, 'add') : line.text}</span>
          )}
        </div>
      ))}
    </div>
  );
}

interface SplitRow {
  left?: DiffLine;
  right?: DiffLine;
}

/**
 * Reshape the unified diff into aligned left(before)/right(after) rows.
 * computeLineDiffWithWords emits a changed line as remove-then-add, so a remove
 * directly followed by an add is one edited row; lone removes/adds sit on one side.
 */
function buildSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.type === 'same') {
      rows.push({ left: line, right: line });
      i++;
    } else if (line.type === 'remove') {
      const next = lines[i + 1];
      if (next && next.type === 'add') {
        rows.push({ left: line, right: next });
        i += 2;
      } else {
        rows.push({ left: line });
        i++;
      }
    } else {
      rows.push({ right: line });
      i++;
    }
  }
  return rows;
}

/** Side-by-side diff: before on the left, after on the right. */
function SplitDiff({ lines }: { lines: DiffLine[] }) {
  const t = useT();
  const rows = useMemo(() => buildSplitRows(lines), [lines]);
  return (
    <div className="rounded border border-edge overflow-auto max-h-[55vh] text-[11px] font-mono leading-relaxed">
      <div className="grid grid-cols-2 sticky top-0 bg-surface-sunken border-b border-edge text-[10px] text-fg-faint z-10">
        <div className="px-2 py-0.5 border-r border-edge">{t('knowledge.beforeLabel')}</div>
        <div className="px-2 py-0.5">{t('knowledge.afterLabel')}</div>
      </div>
      {rows.map((row, i) => (
        <div key={i} className="grid grid-cols-2">
          <SplitCell line={row.left} side="remove" />
          <SplitCell line={row.right} side="add" />
        </div>
      ))}
    </div>
  );
}

function SplitCell({ line, side }: { line?: DiffLine; side: 'add' | 'remove' }) {
  if (!line) return <div className="px-2 py-0.5 bg-surface-sunken/40 border-r border-edge last:border-r-0" />;
  const changed = line.type !== 'same';
  const tint = !changed ? '' : side === 'add' ? 'bg-success-subtle' : 'bg-danger-subtle';
  const textColor = !changed ? 'text-fg-secondary' : side === 'add' ? 'text-success-fg' : 'text-danger';
  return (
    <div className={`px-2 py-0.5 border-r border-edge last:border-r-0 ${tint}`}>
      <span className={textColor}>{changed && line.words ? renderDiffWords(line.words, side) : line.text || ' '}</span>
    </div>
  );
}
