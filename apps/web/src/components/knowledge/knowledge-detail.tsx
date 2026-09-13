/**
 * KnowledgeDetail — read-only Markdown view, laid out flat on the page.
 *
 * The title/tags/time and actions (Edit, Archive, History) live in the page's
 * top bar; this component renders only the body: the flat Markdown content with
 * optional questions/topics, plus an outline rail down the right edge.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KnowledgeDoc, KnowledgeDocVersion, KnowledgeBacklink, KnowledgeComment } from '@greenhouse/types/api';
import { Badge, Button, Dialog, Select, Spinner, ConfirmDialog, toast } from '../ui';
import { KnowledgeEditor, type KnowledgeEditorValue } from './knowledge-editor';
import { Markdown, useActiveHeading, useDocumentHeadings, type DocHeading } from '../markdown';
import { ChevronRight, Eye, Files, HelpCircle, Pin, RotateCcw, Link, MessageSquare, Trash2 } from '../../lib/icons';
import { safeParse, formatDate } from '../../lib/utils';
import {
  listKnowledgeVersions,
  restoreKnowledgeVersion,
  listKnowledgeBacklinks,
  listKnowledgeComments,
  addKnowledgeComment,
  deleteKnowledgeComment,
} from '../../lib/api/knowledge';
import { computeLineDiffWithWords } from '../../lib/wiki-diff';
import { renderDiffWords } from '../../lib/diff-words';
import { useT } from '../../lib/i18n';
import { useHoverFlyout } from '../../hooks/use-hover-flyout';

interface KnowledgeDetailProps {
  doc: KnowledgeDoc;
}

/** DOM id of the comment section, so the top bar can scroll to it. */
export const KNOWLEDGE_COMMENTS_ANCHOR = 'knowledge-comments';

/** Scroll the open document's comment section into view. */
export function scrollToKnowledgeComments(): void {
  document.getElementById(KNOWLEDGE_COMMENTS_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function KnowledgeDetail({ doc }: KnowledgeDetailProps) {
  const t = useT();
  const contentRef = useRef<HTMLDivElement>(null);
  const questions = safeParse<string[]>(doc.questions, []);
  const topics = safeParse<string[]>(doc.topics, []);
  const headings = useDocumentHeadings(contentRef, doc.content_markdown || '');

  // The scroll container is reused when switching docs, so the previous
  // article's scroll position would stick. Every doc opens at the top;
  // 'instant' because the container is scroll-smooth (an animated reset
  // both looks wrong and lies to immediate scroll reads).
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0, behavior: 'instant' });
  }, [doc.id]);

  return (
    <div className="h-full flex overflow-hidden">
      <main ref={contentRef} className="flex-1 overflow-y-auto px-3 md:px-6 py-4 scroll-smooth">
        <div className="max-w-4xl mx-auto">
          {doc.summary && <p className="text-sm text-fg-muted italic mb-4">{doc.summary}</p>}

          {/* Content — flat, no card */}
          <Markdown content={doc.content_markdown || ''} anchors />

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

          <KnowledgeBacklinks docId={doc.id} />
          <KnowledgeComments docId={doc.id} />
        </div>
      </main>

      <DocOutline scrollRef={contentRef} headings={headings} />
    </div>
  );
}

/** Remembers whether the reader keeps the outline open. */
const TOC_PINNED_KEY = 'knowledge.tocPinned';

/**
 * Outline rail down the right edge of a document.
 *
 * Collapsed it is barely wider than a scrollbar — one tick per heading, so the
 * document keeps the full column and you can still see where you are in it.
 * Hovering opens the full list over the content (no layout shift, no click), and
 * the pin turns that into a permanent column for readers who want it there.
 */
function DocOutline({
  scrollRef,
  headings,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  headings: DocHeading[];
}) {
  const t = useT();
  const [pinned, setPinned] = useState(() => {
    try {
      return localStorage.getItem(TOC_PINNED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const { open: peeking, openNow: openPeek, closeSoon: scheduleClosePeek, closeNow: closePeek } = useHoverFlyout();
  const activeId = useActiveHeading(scrollRef, headings);

  if (headings.length === 0) return null;

  const togglePinned = () => {
    const next = !pinned;
    setPinned(next);
    closePeek();
    try {
      localStorage.setItem(TOC_PINNED_KEY, next ? '1' : '0');
    } catch {
      /* ignore quota / private-mode errors */
    }
  };

  const jumpTo = (id: string) => {
    scrollRef.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const heading = (
    <span className="flex-1 text-[10px] font-semibold text-fg-faint uppercase tracking-wide">
      {t('knowledge.onThisPage')}
    </span>
  );

  const list = (
    <nav className="space-y-0.5">
      {headings.map((h) => (
        <button
          key={h.id}
          type="button"
          onClick={() => jumpTo(h.id)}
          className={`block w-full text-left text-xs py-1 truncate transition-colors ${
            h.id === activeId ? 'text-primary-fg-strong font-medium' : 'text-fg-muted hover:text-fg'
          }`}
          style={{ paddingLeft: `${Math.max(0, h.level - 1) * 8}px` }}
          title={h.text}
        >
          {h.text}
        </button>
      ))}
    </nav>
  );

  if (pinned) {
    return (
      <aside className="hidden lg:flex flex-col w-40 flex-shrink-0 border-l border-edge px-2 py-3 overflow-y-auto">
        <div className="flex items-center gap-1 mb-1.5">
          {heading}
          <button
            type="button"
            onClick={togglePinned}
            title={t('knowledge.collapseToc')}
            className="text-fg-faint hover:text-fg transition-colors"
          >
            <ChevronRight size={12} />
          </button>
        </div>
        {list}
      </aside>
    );
  }

  return (
    <aside
      className="hidden lg:block relative w-9 flex-shrink-0 border-l border-edge"
      onMouseEnter={openPeek}
      onMouseLeave={scheduleClosePeek}
    >
      {/* Minimap: tick width tracks heading depth, so the shape of the document
          is legible even while the list itself is closed. */}
      <div className="flex flex-col items-end pt-4 max-h-full overflow-y-auto scrollbar-hide">
        {headings.map((h) => (
          <button
            key={h.id}
            type="button"
            onClick={() => jumpTo(h.id)}
            title={h.text}
            className="group flex w-full justify-end py-[3px] pr-2.5"
          >
            <span
              className={`h-0.5 rounded-full transition-colors ${
                h.id === activeId ? 'bg-primary-600' : 'bg-edge-strong group-hover:bg-fg-faint'
              }`}
              style={{ width: `${16 - Math.min(h.level - 1, 3) * 3}px` }}
            />
          </button>
        ))}
      </div>

      {peeking && (
        <div className="absolute top-2 right-full w-[196px] pr-1 z-20">
          {/* Padding preserves the visual gap while keeping one continuous hover target. */}
          <div className="w-full max-h-[70vh] overflow-y-auto rounded-lg border border-edge bg-surface-raised shadow-lg p-2">
            <div className="flex items-center gap-1 mb-1">
              {heading}
              <button
                type="button"
                onClick={togglePinned}
                title={t('knowledge.pinToc')}
                className="text-fg-faint hover:text-fg transition-colors"
              >
                <Pin size={12} />
              </button>
            </div>
            {list}
          </div>
        </div>
      )}
    </aside>
  );
}

/** Documents that link TO this one (backlinks). Hidden when there are none. */
function KnowledgeBacklinks({ docId }: { docId: number }) {
  const t = useT();
  const [links, setLinks] = useState<KnowledgeBacklink[] | null>(null);
  useEffect(() => {
    let alive = true;
    listKnowledgeBacklinks(docId)
      .then((l) => alive && setLinks(l))
      .catch(() => alive && setLinks([]));
    return () => {
      alive = false;
    };
  }, [docId]);
  if (!links || links.length === 0) return null;
  return (
    <section className="mt-6 border-t border-edge pt-4">
      <h3 className="text-sm font-semibold text-fg-secondary mb-2 flex items-center gap-1.5">
        <Link size={14} /> {t('knowledge.backlinks')}
      </h3>
      <ul className="space-y-1 text-sm">
        {links.map((l) => (
          <li key={l.id}>
            <a
              className="text-primary-fg hover:underline"
              href={`#/knowledge/doc/${l.id}-${encodeURIComponent(l.slug)}`}
            >
              {l.title}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A cleared comment box. Shared constant so "reset" is always the same object shape. */
const EMPTY_DRAFT: KnowledgeEditorValue = { markdown: '', json: '{}' };

/** Document-level comments: list + add + delete (author/super). */
function KnowledgeComments({ docId }: { docId: number }) {
  const t = useT();
  const [comments, setComments] = useState<KnowledgeComment[]>([]);
  // Same shape the doc editor works in: Markdown is what we send (and what the
  // mention-notification parser reads); the JSON drives the editor itself.
  const [draft, setDraft] = useState<KnowledgeEditorValue>(EMPTY_DRAFT);
  const [posting, setPosting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);

  const load = useCallback(() => {
    listKnowledgeComments(docId)
      .then(setComments)
      .catch(() => setComments([]));
  }, [docId]);
  useEffect(() => load(), [load]);

  // Leaving one doc for another must not carry the half-written comment over.
  useEffect(() => setDraft(EMPTY_DRAFT), [docId]);

  const post = async () => {
    const content = draft.markdown.trim();
    if (!content || posting) return;
    setPosting(true);
    try {
      await addKnowledgeComment(docId, content);
      setDraft(EMPTY_DRAFT);
      toast(t('knowledge.commentPosted'), 'success');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('knowledge.commentFailed'), 'error');
    } finally {
      setPosting(false);
    }
  };

  const remove = async (id: number) => {
    try {
      await deleteKnowledgeComment(id);
      toast(t('knowledge.commentDeleted'), 'success');
      setConfirmDelete(null);
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('knowledge.commentFailed'), 'error');
    }
  };

  return (
    // Anchor for the top bar's comment button — it scrolls here rather than
    // threading a ref up through the page for one jump.
    <section id={KNOWLEDGE_COMMENTS_ANCHOR} className="mt-8 border-t border-edge pt-4 scroll-mt-4">
      <h3 className="text-sm font-semibold text-fg-secondary mb-3 flex items-center gap-1.5">
        <MessageSquare size={14} /> {t('knowledge.comments')}
        {comments.length > 0 && <span className="text-fg-faint font-normal">· {comments.length}</span>}
      </h3>

      {comments.length === 0 ? (
        <p className="text-sm text-fg-faint mb-3">{t('knowledge.noComments')}</p>
      ) : (
        <ul className="space-y-3 mb-4">
          {comments.map((c) => (
            <li key={c.id} className="text-sm">
              <div className="flex items-center gap-2 text-xs text-fg-faint mb-0.5">
                <span className="font-medium text-fg-muted">{c.author_nickname}</span>
                <span>{formatDate(c.created_at ?? undefined)}</span>
                {c.can_delete && (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(c.id)}
                    className="text-fg-faint hover:text-danger transition-colors"
                    title={t('knowledge.deleteComment')}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
              <div className="text-fg-secondary [&_a]:text-primary-fg [&_a]:no-underline">
                <Markdown content={c.content} compact />
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2">
        {/* Same editor as the document body (compact): `@` inserts a real mention
            chip instead of raw `[@name](user:id)` markdown. */}
        <KnowledgeEditor
          value={draft}
          onChange={setDraft}
          placeholder={t('knowledge.addCommentPlaceholder')}
          compact
          onSubmit={post}
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={post} disabled={posting || !draft.markdown.trim()}>
            {t('knowledge.postComment')}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete !== null && remove(confirmDelete)}
        title={t('knowledge.deleteCommentConfirm')}
        confirmLabel={t('knowledge.deleteComment')}
        confirmVariant="destructive"
      />
    </section>
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
  // Two-version compare: value is a version number as string, or 'current'.
  const [fromV, setFromV] = useState('');
  const [toV, setToV] = useState('current');

  const contentOf = useCallback(
    (val: string): string =>
      val === 'current'
        ? doc.content_markdown || ''
        : versions.find((v) => String(v.version) === val)?.content_markdown || '',
    [doc.content_markdown, versions],
  );

  const reload = useCallback(() => {
    setLoading(true);
    listKnowledgeVersions(doc.id)
      .then((vs) => {
        setVersions(vs);
        // Default the compare pane to "previous version → current".
        setToV('current');
        setFromV(vs.length >= 2 ? String(vs[1].version) : vs.length === 1 ? String(vs[0].version) : '');
      })
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
    <Dialog open={open} onClose={onClose} title={t('knowledge.versionHistory')} size="workspace">
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-fg-faint py-4">
          <Spinner /> {t('knowledge.loadingVersions')}
        </div>
      ) : versions.length === 0 ? (
        <p className="text-sm text-fg-faint py-4">{t('knowledge.noVersions')}</p>
      ) : (
        <div className="space-y-2">
          {/* Compare any two versions (or a version vs current). */}
          <div className="border border-edge rounded-md p-2 bg-surface-muted/40">
            <div className="flex items-center gap-2 text-xs flex-wrap">
              <span className="text-fg-faint">{t('knowledge.compareVersions')}:</span>
              <div className="flex items-center gap-2">
                <Select size="sm" inline value={fromV} onChange={(e) => setFromV(e.target.value)}>
                  {versions.map((v) => (
                    <option key={v.id} value={String(v.version)}>
                      v{v.version}
                    </option>
                  ))}
                </Select>
                <span className="text-fg-faint">→</span>
                <Select size="sm" inline value={toV} onChange={(e) => setToV(e.target.value)}>
                  <option value="current">{t('knowledge.currentTag')}</option>
                  {versions.map((v) => (
                    <option key={v.id} value={String(v.version)}>
                      v{v.version}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            {fromV && fromV !== toV && (
              <div className="mt-2">
                <VersionDiff before={contentOf(fromV)} after={contentOf(toV)} />
              </div>
            )}
            {fromV && fromV === toV && <p className="mt-2 text-[10px] text-fg-faint">{t('knowledge.sameAsCurrent')}</p>}
          </div>

          {versions.map((v, idx) => {
            const isLatest = idx === 0;
            const showDiff = diffVersion === v.version;
            return (
              <div key={v.id} className="text-sm border border-edge rounded-md px-3 py-2">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <div className="min-w-0">
                    <span className="font-medium text-fg">v{v.version}</span>
                    {isLatest && <span className="text-[10px] text-fg-faint ml-1.5">{t('knowledge.currentTag')}</span>}
                    <span className="ml-2 break-words text-fg-muted">
                      {v.change_reason || t('knowledge.updatedReason')}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-1 sm:flex-shrink-0 sm:justify-end">
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
