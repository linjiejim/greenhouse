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
import { ChevronLeft, Eye, Files, HelpCircle, RotateCcw } from '../../lib/icons';
import { safeParse, formatDate } from '../../lib/utils';
import { listKnowledgeVersions, restoreKnowledgeVersion } from '../../lib/api/knowledge';
import { computeLineDiffWithWords } from '../../lib/wiki-diff';
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
 * Each version can be diffed against the current content and restored. Restoring
 * is non-destructive: the backend records the rollback as a brand-new version, so
 * history (and forward-restore) is always preserved.
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
    <Dialog open={open} onClose={onClose} title={t('knowledge.versionHistory')} size="md">
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-fg-faint py-4">
          <Spinner /> {t('knowledge.loadingVersions')}
        </div>
      ) : versions.length === 0 ? (
        <p className="text-sm text-fg-faint py-4">{t('knowledge.noVersions')}</p>
      ) : (
        <div className="space-y-2">
          {versions.map((v, idx) => {
            const isLatest = idx === 0;
            const showDiff = diffVersion === v.version;
            return (
              <div key={v.id} className="text-sm border border-edge rounded-md px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="font-medium text-fg">v{v.version}</span>
                    {isLatest && <span className="text-[10px] text-fg-faint ml-1.5">{t('knowledge.currentTag')}</span>}
                    <span className="text-fg-muted ml-2">{v.change_reason || t('knowledge.updatedReason')}</span>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <span className="text-xs text-fg-faint mr-1">{v.created_at ? formatDate(v.created_at) : '—'}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      title={t('knowledge.compareToCurrent')}
                      onClick={() => setDiffVersion(showDiff ? null : v.version)}
                    >
                      <Eye size={13} />
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
                {showDiff && (
                  <div className="mt-2">
                    <p className="text-[10px] text-fg-faint mb-1">
                      {t('knowledge.versionDiffLabel', { version: v.version })}
                    </p>
                    <VersionDiff before={v.content_markdown || ''} after={doc.content_markdown || ''} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}

/** Line+word diff between a historical version and the current content. */
function VersionDiff({ before, after }: { before: string; after: string }) {
  const t = useT();
  const diffLines = useMemo(() => computeLineDiffWithWords(before, after, 300), [before, after]);
  if (before === after) {
    return <p className="text-[11px] text-fg-faint">{t('knowledge.sameAsCurrent')}</p>;
  }
  return (
    <div className="rounded border border-edge overflow-auto max-h-64 text-[11px] font-mono leading-relaxed">
      {diffLines.map((line, i) => (
        <div
          key={i}
          className={`px-2 py-0.5 ${line.type === 'add' ? 'bg-success-subtle' : line.type === 'remove' ? 'bg-danger-subtle' : ''}`}
        >
          <span className="inline-block w-4 text-right mr-2 text-fg-faint select-none text-[10px]">
            {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
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
