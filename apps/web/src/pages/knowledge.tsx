/**
 * Unified Knowledge page — routes to:
 *   internal/:sp  — team knowledge docs by space
 *   personal/:sl  — private knowledge docs
 *   shared/:sl    — private docs others shared with me
 *   new           — create editor (defaults to team)
 */

import React, { useCallback, useEffect, useState } from 'react';
import type { KnowledgeDoc } from '@greenhouse/types/api';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  SearchInput,
  Select,
  Spinner,
  toast,
} from '../components/ui';
import {
  KnowledgeDetail,
  KnowledgeEditor,
  KnowledgeShareDialog,
  KnowledgeVersionsDialog,
  type KnowledgeEditorValue,
} from '../components/knowledge';
import { useKnowledgeStore } from '../stores';
import { useT } from '../lib/i18n';
import { safeParse, timeAgo, formatDate } from '../lib/utils';
import { isSpaceInSubtree, normalizeSpacePath } from '../lib/knowledge-spaces';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Edit3,
  FileEdit,
  History,
  Plus,
  RotateCcw,
  Save,
  Share2,
} from '../lib/icons';
import {
  archiveKnowledgeDoc,
  createKnowledgeDoc,
  getKnowledgeDoc,
  listKnowledgeDocs,
  updateKnowledgeDoc,
} from '../lib/api/knowledge';

// ─── Shared helpers ─────────────────────────────────────

interface EditorState {
  id?: number;
  title: string;
  space: string;
  visibility: 'team' | 'private';
  status: 'draft' | 'published';
  tagsText: string;
  summary: string;
  value: KnowledgeEditorValue;
}

const emptyEditor = (visibility: 'team' | 'private' = 'team'): EditorState => ({
  title: '',
  space: 'general',
  visibility,
  status: 'published',
  tagsText: '',
  summary: '',
  value: { markdown: '', json: '{}' },
});

function docToEditor(doc: KnowledgeDoc): EditorState {
  return {
    id: doc.id,
    title: doc.title,
    space: doc.space || 'general',
    visibility: doc.visibility,
    status: doc.status === 'draft' ? 'draft' : 'published',
    tagsText: safeParse<string[]>(doc.tags, []).join(', '),
    summary: doc.summary || '',
    value: { markdown: doc.content_markdown || '', json: doc.content_json || '{}' },
  };
}

/** Decode a URL space token, tolerating a malformed `%` (falls back to raw). */
function safeDecodeSpace(token: string): string {
  try {
    return decodeURIComponent(token);
  } catch {
    return token;
  }
}

function parseTags(tagsText: string): string[] {
  return tagsText
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

// ─── Main Router ────────────────────────────────────────

interface KnowledgePageProps {
  subPath?: string;
  basePath?: string;
}

export function KnowledgePage({ subPath = '', basePath = '#/knowledge' }: KnowledgePageProps) {
  const segments = subPath.split('/').filter(Boolean);
  const section = segments[0] || '';
  const rest = segments.slice(1).join('/');

  switch (section) {
    case 'internal': {
      // The hash router doesn't decode segments, and a nested space travels as a
      // single `%2F`-encoded token — decode + canonicalize it here. Empty stays
      // empty (the internal landing lists every team doc).
      const space = segments[1] ? normalizeSpacePath(safeDecodeSpace(segments[1])) : '';
      return <InternalDocsView space={space} docSlug={segments.slice(2).join('/')} basePath={basePath} />;
    }
    case 'personal':
      return <PersonalDocsView docSlug={rest} basePath={basePath} />;
    case 'shared':
      return <SharedDocsView docSlug={rest} basePath={basePath} />;
    case 'new':
      return <NewDocView basePath={basePath} defaultVisibility={rest === 'personal' ? 'private' : 'team'} />;
    default:
      // Default redirect to the internal (team) knowledge base.
      if (!section) {
        window.location.hash = `${basePath}/internal`;
        return null;
      }
      // Legacy: treat unknown as doc slug for backward compat
      return <InternalDocsView space="" docSlug={subPath} basePath={basePath} />;
  }
}

// ─── Internal Docs View ─────────────────────────────────

function InternalDocsView({ space, docSlug, basePath }: { space: string; docSlug: string; basePath: string }) {
  return <DocsScopeView scope="team" space={space} docSlug={docSlug} basePath={basePath} />;
}

// ─── Personal Docs View ─────────────────────────────────

function PersonalDocsView({ docSlug, basePath }: { docSlug: string; basePath: string }) {
  return <DocsScopeView scope="private" space="" docSlug={docSlug} basePath={basePath} />;
}

// ─── Shared Docs View (private docs others shared with me) ──

function SharedDocsView({ docSlug, basePath }: { docSlug: string; basePath: string }) {
  return <DocsScopeView scope="shared" space="" docSlug={docSlug} basePath={basePath} />;
}

// ─── Shared Docs Scope View (internal + personal + shared) ──

function DocsScopeView({
  scope,
  space,
  docSlug,
  basePath,
}: {
  scope: 'team' | 'private' | 'shared';
  space: string;
  docSlug: string;
  basePath: string;
}) {
  const t = useT();
  const bump = useKnowledgeStore((s) => s.bump);
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<KnowledgeDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'published' | 'archived'>('published');

  const [editorOpen, setEditorOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(emptyEditor(scope === 'team' ? 'team' : 'private'));
  const [saving, setSaving] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<KnowledgeDoc | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const isTeam = scope === 'team';
  const isShared = scope === 'shared';
  const labels = isTeam
    ? {
        search: t('knowledge.searchDocs'),
        empty: t('knowledge.noDocs'),
        emptyDesc: t('knowledge.emptyInternalDesc'),
      }
    : isShared
      ? {
          search: t('knowledge.searchSharedDocs'),
          empty: t('knowledge.noSharedDocs'),
          emptyDesc: t('knowledge.emptySharedDesc'),
        }
      : {
          search: t('knowledge.searchPersonalDocs'),
          empty: t('knowledge.noPersonalDocs'),
          emptyDesc: t('knowledge.emptyPersonalDesc'),
        };

  // Landing path for the current scope (Back target, post-archive redirect).
  const listBasePath = isTeam
    ? space
      ? `${basePath}/internal/${encodeURIComponent(space)}`
      : `${basePath}/internal`
    : isShared
      ? `${basePath}/shared`
      : `${basePath}/personal`;

  const docPath = useCallback(
    (doc: KnowledgeDoc) =>
      isTeam
        ? `${basePath}/internal/${encodeURIComponent(doc.space || 'general')}/${encodeURIComponent(doc.slug)}`
        : isShared
          ? `${basePath}/shared/${encodeURIComponent(doc.slug)}`
          : `${basePath}/personal/${encodeURIComponent(doc.slug)}`,
    [isTeam, isShared, basePath],
  );

  const loadDocs = useCallback(() => {
    setLoading(true);
    // visibility scopes the listing server-side (private = own docs; shared = docs others
    // shared with me). Space filter only applies to team docs (client-side, see sidebar).
    listKnowledgeDocs({ search: search || undefined, status: statusFilter, visibility: scope })
      .then((all) =>
        setDocs(
          isShared
            ? all
            : all.filter((d) => d.visibility === scope && (!isTeam || !space || isSpaceInSubtree(d.space, space))),
        ),
      )
      .catch(() => toast(t('knowledge.loadFailed'), 'error'))
      .finally(() => setLoading(false));
  }, [search, space, scope, isTeam, isShared, statusFilter]);

  useEffect(() => {
    const t = setTimeout(loadDocs, 200);
    return () => clearTimeout(t);
  }, [loadDocs]);

  useEffect(() => {
    if (!docSlug) {
      setSelectedDoc(null);
      return;
    }
    getKnowledgeDoc(docSlug)
      .then(setSelectedDoc)
      .catch(() => {
        toast(t('knowledge.docNotFound'), 'error');
        window.location.hash = listBasePath;
      });
  }, [docSlug, listBasePath]);

  const openCreate = () => {
    setEditor({ ...emptyEditor(isTeam ? 'team' : 'private'), space: isTeam ? space || 'general' : 'general' });
    setEditorOpen(true);
  };
  const openEdit = (doc: KnowledgeDoc) => {
    setEditor(docToEditor(doc));
    setEditorOpen(true);
  };

  const handleSave = async () => {
    if (!editor.title.trim()) {
      toast(t('knowledge.titleRequired'), 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: editor.title.trim(),
        content_markdown: editor.value.markdown,
        content_json: editor.value.json,
        space: editor.space || 'general',
        visibility: editor.visibility,
        status: editor.status,
        tags: parseTags(editor.tagsText),
        summary: editor.summary,
        change_reason: editor.id ? 'Updated from knowledge editor' : undefined,
      };
      const saved = editor.id ? await updateKnowledgeDoc(editor.id, payload) : await createKnowledgeDoc(payload);
      toast(editor.id ? t('knowledge.docUpdated') : t('knowledge.docCreated'), 'success');
      setEditorOpen(false);
      setSelectedDoc(saved);
      bump();
      loadDocs();
      window.location.hash = docPath(saved);
    } catch (err) {
      toast(err instanceof Error ? err.message : t('knowledge.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async (doc: KnowledgeDoc) => {
    try {
      await archiveKnowledgeDoc(doc.id);
      toast(t('knowledge.docArchived'), 'success');
      setArchiveTarget(null);
      setSelectedDoc(null);
      bump();
      loadDocs();
      window.location.hash = listBasePath;
    } catch (err) {
      toast(err instanceof Error ? err.message : t('knowledge.archiveFailed'), 'error');
    }
  };

  const handleRestore = async (doc: KnowledgeDoc) => {
    try {
      const restored = await updateKnowledgeDoc(doc.id, { status: 'published' });
      toast(t('knowledge.docRestored'), 'success');
      bump();
      if (selectedDoc?.id === doc.id) setSelectedDoc(restored);
      loadDocs();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('knowledge.restoreDocFailed'), 'error');
    }
  };

  // Editor (full page) — create or edit
  if (editorOpen) {
    return (
      <EditorView
        editor={editor}
        saving={saving}
        onChange={setEditor}
        onSave={handleSave}
        onCancel={() => setEditorOpen(false)}
      />
    );
  }

  // Detail view
  if (selectedDoc && docSlug) {
    const tags = safeParse<string[]>(selectedDoc.tags, []);
    const archived = selectedDoc.status === 'archived';
    // Permission-aware controls from the caller's effective role on the doc.
    const access = selectedDoc.access ?? (isTeam ? 'editor' : 'owner');
    const canEdit = access === 'owner' || access === 'editor';
    const isOwner = access === 'owner';
    const canArchiveDoc = isTeam || isOwner; // team docs are collaborative
    const canShare = isOwner && selectedDoc.visibility === 'private';
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="flex items-center gap-3 px-3 md:px-4 py-2 border-b border-edge bg-surface-raised flex-shrink-0">
          <Button variant="ghost" size="sm" onClick={() => (window.location.hash = listBasePath)}>
            ← {t('common.back')}
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-sm font-semibold text-fg truncate" title={selectedDoc.title}>
                {selectedDoc.title}
              </h1>
              {isTeam && <Badge variant="secondary">{selectedDoc.space}</Badge>}
              {isShared && (
                <Badge variant="secondary">
                  {access === 'editor' ? t('knowledge.editable') : t('knowledge.readOnly')}
                </Badge>
              )}
              {archived && <Badge variant="warning">{t('common.archived')}</Badge>}
              {tags.slice(0, 2).map((tag) => (
                <Badge key={tag} variant="secondary">
                  {tag}
                </Badge>
              ))}
            </div>
            <p className="text-[10px] text-fg-faint truncate mt-0.5">
              {t('knowledge.updatedPrefix')} {selectedDoc.updated_at ? formatDate(selectedDoc.updated_at) : '—'} ·{' '}
              {selectedDoc.slug}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)} title={t('knowledge.versionHistory')}>
            <History size={14} className="mr-1" /> {t('knowledge.history')}
          </Button>
          {canShare && (
            <Button variant="ghost" size="sm" onClick={() => setShareOpen(true)} title={t('knowledge.share')}>
              <Share2 size={14} className="mr-1" /> {t('knowledge.share')}
            </Button>
          )}
          {archived
            ? canArchiveDoc && (
                <Button variant="secondary" size="sm" onClick={() => handleRestore(selectedDoc)}>
                  <RotateCcw size={14} className="mr-1" /> {t('common.restore')}
                </Button>
              )
            : canArchiveDoc && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger hover:text-danger hover:bg-danger-subtle"
                  onClick={() => setArchiveTarget(selectedDoc)}
                >
                  <Archive size={14} className="mr-1" /> {t('common.archive')}
                </Button>
              )}
          {canEdit && (
            <Button size="sm" onClick={() => openEdit(selectedDoc)}>
              <Edit3 size={14} className="mr-1" /> {t('common.edit')}
            </Button>
          )}
        </div>
        <KnowledgeDetail doc={selectedDoc} />
        <KnowledgeVersionsDialog
          doc={selectedDoc}
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          onRestored={(restored) => {
            setSelectedDoc(restored);
            bump();
            loadDocs();
          }}
        />
        <KnowledgeShareDialog
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          docId={selectedDoc.id}
          docTitle={selectedDoc.title}
        />
        <ConfirmDialog
          open={!!archiveTarget}
          onClose={() => setArchiveTarget(null)}
          onConfirm={() => archiveTarget && handleArchive(archiveTarget)}
          title={t('knowledge.archiveConfirmTitle')}
          description={
            archiveTarget
              ? isTeam
                ? t('knowledge.archiveConfirmTeam', { name: archiveTarget.title })
                : t('knowledge.archiveConfirmSimple', { name: archiveTarget.title })
              : undefined
          }
          confirmLabel={t('common.archive')}
          confirmVariant="destructive"
        />
      </div>
    );
  }

  // List view
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-3 md:px-4 py-2.5 border-b border-edge bg-surface-raised flex-shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <SearchInput
            size="sm"
            placeholder={labels.search}
            value={search}
            onChange={setSearch}
            className="flex-1 min-w-[160px]"
          />
          <Select
            size="sm"
            inline
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'published' | 'archived')}
          >
            <option value="published">{t('knowledge.statusActive')}</option>
            <option value="archived">{t('common.archived')}</option>
          </Select>
          <span className="text-xs text-fg-faint flex-shrink-0">
            {t('knowledge.docsCount', { count: docs.length })}
          </span>
          {!isShared && (
            <Button size="sm" onClick={openCreate}>
              <Plus size={14} className="mr-1" /> {t('knowledge.newDocBtn')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 md:px-4 py-3">
        {loading ? (
          <LoadingSpinner />
        ) : docs.length === 0 ? (
          <EmptyState
            icon={statusFilter === 'archived' ? Archive : FileEdit}
            title={statusFilter === 'archived' ? t('knowledge.noArchivedDocs') : labels.empty}
            description={statusFilter === 'archived' ? t('knowledge.noArchivedDesc') : labels.emptyDesc}
          />
        ) : (
          <div className="space-y-2">
            {docs.map((doc) => (
              <KbCard
                key={doc.id}
                title={doc.title}
                summary={doc.summary || doc.content_markdown.slice(0, 160) || undefined}
                tags={safeParse<string[]>(doc.tags, [])}
                badge={isTeam ? <Badge variant="secondary">{doc.space}</Badge> : undefined}
                footer={
                  <span className="text-[10px] text-fg-faint">{doc.updated_at ? timeAgo(doc.updated_at) : '—'}</span>
                }
                action={
                  statusFilter === 'archived' ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRestore(doc);
                      }}
                    >
                      <RotateCcw size={13} className="mr-1" /> {t('common.restore')}
                    </Button>
                  ) : undefined
                }
                onClick={() => (window.location.hash = docPath(doc))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── New Doc View (redirect to editor) ──────────────────

function NewDocView({ basePath, defaultVisibility }: { basePath: string; defaultVisibility: 'team' | 'private' }) {
  const t = useT();
  const bump = useKnowledgeStore((s) => s.bump);
  const [editor, setEditor] = useState<EditorState>(emptyEditor(defaultVisibility));
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!editor.title.trim()) {
      toast(t('knowledge.titleRequired'), 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: editor.title.trim(),
        content_markdown: editor.value.markdown,
        content_json: editor.value.json,
        space: editor.space || 'general',
        visibility: editor.visibility,
        status: editor.status,
        tags: parseTags(editor.tagsText),
        summary: editor.summary,
      };
      const saved = await createKnowledgeDoc(payload);
      toast(t('knowledge.docCreated'), 'success');
      bump();
      if (saved.visibility === 'private') {
        window.location.hash = `${basePath}/personal/${encodeURIComponent(saved.slug)}`;
      } else {
        window.location.hash = `${basePath}/internal/${encodeURIComponent(saved.space || 'general')}/${encodeURIComponent(saved.slug)}`;
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : t('knowledge.createFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditorView
      editor={editor}
      saving={saving}
      onChange={setEditor}
      onSave={handleSave}
      onCancel={() => window.history.back()}
    />
  );
}

// ─── Shared Components ──────────────────────────────────

function LoadingSpinner() {
  return (
    <div className="flex justify-center py-8">
      <Spinner className="h-6 w-6 text-fg-faint" />
    </div>
  );
}

function TagsList({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {tags.slice(0, 5).map((tag) => (
        <span key={tag} className="text-[10px] text-fg-faint bg-surface-muted px-1.5 py-0.5 rounded">
          {tag}
        </span>
      ))}
      {tags.length > 5 && <span className="text-[10px] text-fg-faint">+{tags.length - 5}</span>}
    </div>
  );
}

/**
 * Shared knowledge list card — single row, full width. Used by every KB list
 * (wiki, sources, expert, internal, personal) for a consistent look.
 */
function KbCard({
  title,
  subtitle,
  summary,
  tags = [],
  badge,
  footer,
  action,
  onClick,
}: {
  title: string;
  subtitle?: React.ReactNode;
  summary?: string;
  tags?: string[];
  badge?: React.ReactNode;
  footer?: React.ReactNode;
  action?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Card className="p-3 cursor-pointer hover:border-primary-300 transition-colors" onClick={onClick}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-medium text-fg truncate" title={title}>
            {title}
          </h4>
          {subtitle}
          {summary && <p className="text-xs text-fg-faint mt-1 line-clamp-2">{summary}</p>}
          {tags.length > 0 && <TagsList tags={tags} />}
        </div>
        {(badge || footer || action) && (
          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            {badge}
            {footer}
            {action}
          </div>
        )}
      </div>
    </Card>
  );
}

// ─── Editor Components ──────────────────────────────────

/** Full-page editor: top bar (Back/Cancel + Save top-right) over the editor fields. */
function EditorView({
  editor,
  saving,
  onChange,
  onSave,
  onCancel,
}: {
  editor: EditorState;
  saving: boolean;
  onChange: (state: EditorState) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 md:px-4 py-2 border-b border-edge bg-surface-raised flex-shrink-0">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          ← {t('common.back')}
        </Button>
        <span className="text-sm font-medium text-fg truncate">
          {editor.id ? t('knowledge.editDocTitle') : t('knowledge.newDocTitle')}
        </span>
        <div className="flex-1" />
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving ? <Spinner className="mr-1" /> : <Save size={14} className="mr-1" />}
          {t('common.save')}
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <EditorInline editor={editor} onChange={onChange} />
      </div>
    </div>
  );
}

function EditorInline({ editor, onChange }: { editor: EditorState; onChange: (state: EditorState) => void }) {
  const t = useT();
  // Advanced fields (Space/Tags/Summary) all have sensible auto-defaults, so
  // they stay collapsed to keep the form approachable. Auto-expand when editing a
  // doc that already has custom values, so they aren't hidden/forgotten.
  const hasAdvancedValues = Boolean(
    editor.tagsText.trim() || editor.summary.trim() || (editor.space && editor.space !== 'general'),
  );
  const [showAdvanced, setShowAdvanced] = useState(hasAdvancedValues);

  return (
    <div className="p-4 space-y-3">
      {/* Essentials: Title + Visibility/Status. Everything you need for a quick doc. */}
      <label className="space-y-1 block">
        <span className="text-xs font-medium text-fg-muted">{t('knowledge.fieldTitle')}</span>
        <Input
          value={editor.title}
          onChange={(e) => onChange({ ...editor, title: e.target.value })}
          placeholder={t('knowledge.titlePlaceholder')}
        />
      </label>
      <div className="grid md:grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className="text-xs font-medium text-fg-muted">{t('knowledge.fieldVisibility')}</span>
          <Select
            value={editor.visibility}
            onChange={(e) => onChange({ ...editor, visibility: e.target.value as 'team' | 'private' })}
          >
            <option value="team">{t('knowledge.visTeam')}</option>
            <option value="private">{t('knowledge.visPrivate')}</option>
          </Select>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-fg-muted">{t('knowledge.fieldStatus')}</span>
          <Select
            value={editor.status}
            onChange={(e) => onChange({ ...editor, status: e.target.value as 'draft' | 'published' })}
          >
            <option value="published">{t('common.published')}</option>
            <option value="draft">{t('common.draft')}</option>
          </Select>
        </label>
      </div>

      {/* Advanced (optional) — Space/Tags/Summary all auto-fill when left blank. */}
      <div className="border-t border-edge pt-2">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"
          aria-expanded={showAdvanced}
        >
          {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {t('knowledge.advancedOptions')}
        </button>
        {showAdvanced && (
          <div className="grid md:grid-cols-2 gap-3 mt-3">
            <label className="space-y-1">
              <span className="text-xs font-medium text-fg-muted">{t('knowledge.fieldSpace')}</span>
              <Input
                value={editor.space}
                onChange={(e) => onChange({ ...editor, space: e.target.value })}
                placeholder="general"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-fg-muted">{t('knowledge.fieldTags')}</span>
              <Input
                value={editor.tagsText}
                onChange={(e) => onChange({ ...editor, tagsText: e.target.value })}
                placeholder="sop, product, support"
              />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-medium text-fg-muted">{t('knowledge.fieldSummary')}</span>
              <Input
                value={editor.summary}
                onChange={(e) => onChange({ ...editor, summary: e.target.value })}
                placeholder={t('knowledge.summaryPlaceholder')}
              />
            </label>
          </div>
        )}
      </div>

      <KnowledgeEditor value={editor.value} onChange={(value) => onChange({ ...editor, value })} />
    </div>
  );
}
