/**
 * Unified Knowledge page — routes to:
 *   internal/:sp  — team knowledge docs by space
 *   personal/:sl  — private knowledge docs
 *   folder/:id    — kb folder attachments (docs themselves live in the sidebar tree)
 *   new           — create editor (defaults to team; `/folder/:id` lands it in a folder)
 *
 * Documents are navigated from the sidebar tree (KnowledgeNavPanel), so this page
 * only ever renders a DETAIL (or the editor) — never a parallel document list.
 * A trailing `/edit` on a doc route opens the editor directly, which is what the
 * sidebar's "Edit" menu item links to.
 * See docs/specs/20260725-knowledge-tree-navigator.md.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { KnowledgeDoc } from '@greenhouse/types/api';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Input,
  Select,
  Spinner,
  toast,
} from '../components/ui';
import {
  KnowledgeDetail,
  KnowledgeEditor,
  KnowledgeShareDialog,
  KnowledgeVersionsDialog,
  scrollToKnowledgeComments,
  slugify,
  nextSlug,
  type KnowledgeEditorValue,
} from '../components/knowledge';
import { useKnowledgeStore } from '../stores';
import { registerNavigationGuard } from '../lib/navigation-guard';
import { useT } from '../lib/i18n';
import { safeParse, timeAgo, formatDate } from '../lib/utils';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Edit3,
  FileEdit,
  FolderOpen,
  History,
  MessageSquare,
  Plus,
  RotateCcw,
  Save,
  Eye,
  Paperclip,
  Share2,
} from '../lib/icons';
import {
  archiveKnowledgeDoc,
  createKnowledgeDoc,
  getKnowledgeDoc,
  getKnowledgeDocById,
  listKnowledgeDocs,
  updateKnowledgeDoc,
  listKnowledgeTemplates,
  pingEditingPresence,
} from '../lib/api/knowledge';
import { driveBreadcrumb, type DriveFolder } from '../lib/api/drive';
import { DriveBrowser } from '../components/drive/drive-browser';
import type { KnowledgeEditor as KnowledgeEditorPresence } from '@greenhouse/types/api';

// ─── Shared helpers ─────────────────────────────────────

/**
 * Resolve the canonical `#/knowledge/doc/<id>-<slug>` deeplink: fetch by id
 * (authoritative) and redirect to the scope-specific route so a renamed slug
 * never breaks the link.
 */
function DocByIdRedirect({ idSlug, basePath }: { idSlug: string; basePath: string }) {
  const t = useT();
  const [error, setError] = useState(false);
  useEffect(() => {
    const id = parseInt(idSlug.split('-')[0] || '', 10);
    if (!Number.isFinite(id)) {
      setError(true);
      return;
    }
    getKnowledgeDocById(id)
      .then((doc) => {
        // Raw (un-encoded) segments — the router compares/fetches on raw values,
        // matching the sidebar nav (which navigates to raw Chinese slugs).
        const target =
          doc.visibility === 'team'
            ? `${basePath}/internal/${doc.space || 'general'}/${doc.slug}`
            : doc.access === 'owner'
              ? `${basePath}/personal/${doc.slug}`
              : `${basePath}/shared/${doc.slug}`;
        window.location.hash = target;
      })
      .catch(() => setError(true));
  }, [idSlug, basePath]);
  if (error) return <div className="p-8 text-center text-fg-faint">{t('knowledge.docNotFound')}</div>;
  return (
    <div className="flex items-center justify-center h-full">
      <Spinner />
    </div>
  );
}

/** Safely percent-decode a hash segment (browsers encode non-ASCII in location.hash). */
function decodeSeg(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * No `space` here: the one-level `meta.space` grouping was superseded by the kb
 * folder tree (`cli knowledge migrate-spaces` folded the old values into
 * folders), so the field only ever held the literal 'general' and the form was
 * asking for a second, weaker answer to "where does this doc live". The server
 * still defaults `meta.space` on create for legacy readers; nothing writes it.
 */
interface EditorState {
  id?: number;
  title: string;
  slug: string;
  visibility: 'team' | 'private';
  status: 'draft' | 'published';
  tagsText: string;
  summary: string;
  value: KnowledgeEditorValue;
}

const emptyEditor = (visibility: 'team' | 'private' = 'team'): EditorState => ({
  title: '',
  slug: '',
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
    slug: doc.slug,
    visibility: doc.visibility,
    status: doc.status === 'draft' ? 'draft' : 'published',
    tagsText: safeParse<string[]>(doc.tags, []).join(', '),
    summary: doc.summary || '',
    value: { markdown: doc.content_markdown || '', json: doc.content_json || '{}' },
  };
}

/**
 * What "unchanged" means for the editor. Markdown, not the Tiptap JSON: the JSON
 * carries positional noise that is not a content change, and Markdown is the
 * canonical field anyway.
 */
function editorSignature(e: EditorState): string {
  return JSON.stringify([e.title, e.slug, e.visibility, e.status, e.tagsText, e.summary, e.value.markdown]);
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
    case 'folder': {
      // A kb folder: #/knowledge/folder/<id> shows its attachments (its documents
      // are in the sidebar tree); #/knowledge/folder/<id>/<slug> is the legacy
      // in-folder doc deeplink and still resolves to the doc detail.
      const fid = parseInt(segments[1] || '', 10);
      if (!Number.isFinite(fid)) {
        window.location.hash = `${basePath}/internal`;
        return null;
      }
      const folderDocSlug = segments.slice(2).join('/');
      if (!folderDocSlug) return <FolderAttachmentsView folderId={fid} />;
      return <FolderDocsView folderId={fid} docSlug={folderDocSlug} basePath={basePath} />;
    }
    case 'internal':
      return <InternalDocsView space={segments[1] || ''} docSlug={segments.slice(2).join('/')} basePath={basePath} />;
    case 'personal':
      return <PersonalDocsView docSlug={rest} basePath={basePath} />;
    case 'shared':
      return <SharedDocsView docSlug={rest} basePath={basePath} />;
    case 'doc':
      // Canonical stable deeplink #/knowledge/doc/<id>-<slug>: resolve by id
      // (authoritative) and redirect to the scope-specific route so the slug can
      // be renamed without breaking the link.
      return <DocByIdRedirect idSlug={segments.slice(1).join('/')} basePath={basePath} />;
    case 'new': {
      // #/knowledge/new[/personal][/folder/<id>]
      const folderAt = segments.indexOf('folder');
      const newFolderId = folderAt > 0 ? parseInt(segments[folderAt + 1] || '', 10) : NaN;
      return (
        <NewDocView
          basePath={basePath}
          defaultVisibility={segments[1] === 'personal' ? 'private' : 'team'}
          folderId={Number.isFinite(newFolderId) ? newFolderId : undefined}
        />
      );
    }
    default:
      // Default redirect to the team knowledge base
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

// ─── Folder Docs View (team docs inside one kb folder) ──

function FolderDocsView({ folderId, docSlug, basePath }: { folderId: number; docSlug: string; basePath: string }) {
  return <DocsScopeView scope="team" space="" folderId={folderId} docSlug={docSlug} basePath={basePath} />;
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
  folderId,
  docSlug,
  basePath,
}: {
  scope: 'team' | 'private' | 'shared';
  space: string;
  /** When set, show only team docs placed in this kb folder. */
  folderId?: number;
  docSlug: string;
  basePath: string;
}) {
  const t = useT();
  const bump = useKnowledgeStore((s) => s.bump);
  // The sidebar tree writes too (rename, move, archive) and announces it by
  // bumping this counter — refetch so the header doesn't keep showing the title
  // the doc had before the rename.
  const kbVersion = useKnowledgeStore((s) => s.version);
  // A trailing `/edit` opens the editor straight away (sidebar "Edit" deeplink).
  const wantsEdit = docSlug.endsWith('/edit');
  const cleanSlug = wantsEdit ? docSlug.slice(0, -'/edit'.length) : docSlug;

  const [selectedDoc, setSelectedDoc] = useState<KnowledgeDoc | null>(null);
  // Archived docs are the only list this page still renders: they're off the
  // sidebar tree (D3) but must stay restorable.
  const [archivedDocs, setArchivedDocs] = useState<KnowledgeDoc[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [archivedLoading, setArchivedLoading] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editor, setEditor] = useState<EditorState>(emptyEditor(scope === 'team' ? 'team' : 'private'));
  // Signature of the state the editor opened with — the only way to tell an
  // actual edit from "opened it and looked around".
  const [editorBaseline, setEditorBaseline] = useState('');
  const [saving, setSaving] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<KnowledgeDoc | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // Guards the auto-open so cancelling the editor doesn't immediately re-open it.
  const autoEditedRef = useRef<number | null>(null);

  const isTeam = scope === 'team';
  const isShared = scope === 'shared';
  const labels = isTeam
    ? { empty: t('knowledge.noDocs'), emptyDesc: t('knowledge.emptyInternalDesc') }
    : isShared
      ? { empty: t('knowledge.noSharedDocs'), emptyDesc: t('knowledge.emptySharedDesc') }
      : { empty: t('knowledge.noPersonalDocs'), emptyDesc: t('knowledge.emptyPersonalDesc') };

  // Landing path for the current scope (Back target, post-archive redirect).
  const listBasePath =
    folderId !== undefined
      ? `${basePath}/folder/${folderId}`
      : isTeam
        ? space
          ? `${basePath}/internal/${encodeURIComponent(space)}`
          : `${basePath}/internal`
        : isShared
          ? `${basePath}/shared`
          : `${basePath}/personal`;

  const docPath = useCallback(
    (doc: KnowledgeDoc) =>
      folderId !== undefined
        ? `${basePath}/folder/${folderId}/${encodeURIComponent(doc.slug)}`
        : isTeam
          ? `${basePath}/internal/${encodeURIComponent(doc.space || 'general')}/${encodeURIComponent(doc.slug)}`
          : isShared
            ? `${basePath}/shared/${encodeURIComponent(doc.slug)}`
            : `${basePath}/personal/${encodeURIComponent(doc.slug)}`,
    [isTeam, isShared, folderId, basePath],
  );

  /** Archived docs for the landing's "Archived" view — fetched only when opened. */
  const loadArchived = useCallback(() => {
    setArchivedLoading(true);
    listKnowledgeDocs({ status: 'archived', visibility: scope })
      .then((all) => setArchivedDocs(isShared ? all : all.filter((d) => d.visibility === scope)))
      .catch(() => toast(t('knowledge.loadFailed'), 'error'))
      .finally(() => setArchivedLoading(false));
  }, [scope, isShared, t]);

  useEffect(() => {
    if (showArchived) loadArchived();
  }, [showArchived, loadArchived]);

  useEffect(() => {
    if (!cleanSlug) {
      setSelectedDoc(null);
      return;
    }
    getKnowledgeDoc(decodeSeg(cleanSlug))
      .then(setSelectedDoc)
      .catch(() => {
        toast(t('knowledge.docNotFound'), 'error');
        window.location.hash = listBasePath;
      });
  }, [cleanSlug, listBasePath, kbVersion, t]);

  // `<doc>/edit` deeplink → open the editor once the doc has loaded.
  useEffect(() => {
    if (!wantsEdit || !selectedDoc) return;
    if (autoEditedRef.current === selectedDoc.id) return;
    autoEditedRef.current = selectedDoc.id;
    openEditor(docToEditor(selectedDoc));
  }, [wantsEdit, selectedDoc]);

  // This component survives navigation between documents in the same scope, so
  // an open editor would otherwise stay open over the NEXT document — showing
  // the previous doc's draft at a URL that says something else. Leaving with
  // unsaved work is asked about by the router's guard before we ever get here.
  useEffect(() => {
    if (!wantsEdit) setEditorOpen(false);
  }, [cleanSlug, wantsEdit]);

  const openEditor = (state: EditorState) => {
    setEditor(state);
    setEditorBaseline(editorSignature(state));
    setEditorOpen(true);
  };
  const openCreate = () => openEditor(emptyEditor(isTeam ? 'team' : 'private'));
  const openEdit = (doc: KnowledgeDoc) => openEditor(docToEditor(doc));

  const handleSave = async () => {
    if (!editor.title.trim()) {
      toast(t('knowledge.titleRequired'), 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: editor.title.trim(),
        slug: editor.slug.trim() || slugify(editor.title),
        content_markdown: editor.value.markdown,
        content_json: editor.value.json,
        visibility: editor.visibility,
        status: editor.status,
        tags: parseTags(editor.tagsText),
        summary: editor.summary,
        change_reason: editor.id ? 'Updated from knowledge editor' : undefined,
        base_updated_at:
          editor.id && selectedDoc?.id === editor.id ? (selectedDoc?.updated_at ?? undefined) : undefined,
      };
      const result = editor.id ? await updateKnowledgeDoc(editor.id, payload) : await createKnowledgeDoc(payload);
      const saved = 'doc' in result ? result.doc : result;
      const conflict = 'doc' in result ? result.conflict : undefined;
      if (conflict) {
        toast(t('knowledge.conflictSaved'), 'warning');
      } else {
        toast(editor.id ? t('knowledge.docUpdated') : t('knowledge.docCreated'), 'success');
      }
      setEditorOpen(false);
      // Saved state is the new baseline: nothing unsaved is left to guard.
      setEditorBaseline(editorSignature(editor));
      setSelectedDoc(saved);
      bump();
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
      window.location.hash = listBasePath;
    } catch (err) {
      toast(err instanceof Error ? err.message : t('knowledge.archiveFailed'), 'error');
    }
  };

  const handleRestore = async (doc: KnowledgeDoc) => {
    try {
      const { doc: restored } = await updateKnowledgeDoc(doc.id, { status: 'published' });
      toast(t('knowledge.docRestored'), 'success');
      bump();
      if (selectedDoc?.id === doc.id) setSelectedDoc(restored);
      loadArchived();
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
        dirty={editorSignature(editor) !== editorBaseline}
        onChange={setEditor}
        onSave={handleSave}
        onCancel={() => {
          setEditorOpen(false);
          // Drop the `/edit` suffix, or the deeplink effect would re-open it.
          if (wantsEdit && selectedDoc) window.location.hash = docPath(selectedDoc);
        }}
      />
    );
  }

  // Detail view
  if (selectedDoc && cleanSlug) {
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
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-3 px-3 md:px-4 py-2 border-b border-edge bg-surface-raised flex-shrink-0">
          <Button variant="ghost" size="sm" onClick={() => (window.location.hash = listBasePath)}>
            ← {t('common.back')}
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 min-w-0">
              <h1 className="text-sm font-semibold text-fg truncate" title={selectedDoc.title}>
                {selectedDoc.title}
              </h1>
              {/* The `space` badge used to sit here; it read "general" on every
                  team doc once folders replaced spaces. Location is the sidebar
                  tree's job. */}
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
          {/* No "move to folder" control here: the sidebar tree owns moving (drag or
              its ⋯ menu), and it covers personal docs and nested folders too — this
              flat <Select> only ever listed root folders.

              Secondary actions are icon-only so the title keeps the width: Edit is
              the one that stays labelled, because it's the one readers reach for. */}
          <div className="order-3 sm:order-none ml-auto sm:ml-0 flex items-center gap-0.5 flex-shrink-0">
            <IconButton label={t('knowledge.jumpToComments')} onClick={scrollToKnowledgeComments}>
              <MessageSquare size={15} />
            </IconButton>
            <IconButton label={t('knowledge.versionHistory')} onClick={() => setHistoryOpen(true)}>
              <History size={15} />
            </IconButton>
            {canShare && (
              <IconButton label={t('knowledge.share')} onClick={() => setShareOpen(true)}>
                <Share2 size={15} />
              </IconButton>
            )}
            {archived
              ? canArchiveDoc && (
                  <IconButton label={t('common.restore')} onClick={() => handleRestore(selectedDoc)}>
                    <RotateCcw size={15} />
                  </IconButton>
                )
              : canArchiveDoc && (
                  <IconButton
                    label={t('common.archive')}
                    variant="destructive"
                    onClick={() => setArchiveTarget(selectedDoc)}
                  >
                    <Archive size={15} />
                  </IconButton>
                )}
          </div>
          {canEdit && (
            <Button size="sm" className="order-2 sm:order-none flex-shrink-0" onClick={() => openEdit(selectedDoc)}>
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

  // Landing — nothing selected. Documents are navigated from the sidebar tree, so
  // this is a prompt plus the archived shelf (the one list the tree doesn't hold).
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-3 md:px-4 py-2.5 border-b border-edge bg-surface-raised flex-shrink-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-fg">
            {isTeam ? t('knowledge.tabInternal') : isShared ? t('knowledge.tabShared') : t('knowledge.tabPersonal')}
          </span>
          <div className="flex-1" />
          <Button
            variant={showArchived ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setShowArchived((v) => !v)}
            aria-pressed={showArchived}
          >
            <Archive size={14} className="mr-1" /> {t('knowledge.showArchived')}
          </Button>
          {!isShared && (
            <Button size="sm" onClick={openCreate}>
              <Plus size={14} className="mr-1" /> {t('knowledge.newDocBtn')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 md:px-4 py-3">
        {!showArchived ? (
          <EmptyState icon={FileEdit} title={t('knowledge.pickFromSidebar')} description={labels.emptyDesc} />
        ) : archivedLoading ? (
          <LoadingSpinner />
        ) : archivedDocs.length === 0 ? (
          <EmptyState
            icon={Archive}
            title={t('knowledge.noArchivedDocs')}
            description={t('knowledge.noArchivedDesc')}
          />
        ) : (
          <div className="space-y-2">
            {archivedDocs.map((doc) => (
              <KbCard
                key={doc.id}
                title={doc.title}
                // Summary only — never the raw Markdown body (renders as noisy
                // `#`/`*` soup). Blank when a doc has no summary yet.
                summary={doc.summary || undefined}
                tags={safeParse<string[]>(doc.tags, [])}
                badge={
                  <span className="text-[10px] text-fg-faint">{doc.updated_at ? timeAgo(doc.updated_at) : '—'}</span>
                }
                action={
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

// ─── Folder Attachments View ────────────────────────────

/**
 * A kb folder's attachments. Its documents live in the sidebar tree, so this page
 * is only the drive side of the shared folder tree (upload / download / delete).
 * The folder's own visibility comes from the breadcrumb, so personal folders work
 * the same as team ones.
 */
function FolderAttachmentsView({ folderId }: { folderId: number }) {
  const t = useT();
  const [crumbs, setCrumbs] = useState<DriveFolder[] | null>(null);

  useEffect(() => {
    let alive = true;
    driveBreadcrumb(folderId)
      .then((c) => alive && setCrumbs(c))
      .catch(() => alive && setCrumbs([]));
    return () => {
      alive = false;
    };
  }, [folderId]);

  if (crumbs === null) return <LoadingSpinner />;
  const folder = crumbs[crumbs.length - 1];
  if (!folder) {
    return <EmptyState icon={FolderOpen} title={t('knowledge.docNotFound')} />;
  }
  const visibility = folder.visibility === 'private' ? 'private' : 'team';

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 md:px-4 py-2 border-b border-edge bg-surface-raised flex-shrink-0">
        <Paperclip size={14} className="text-fg-faint flex-shrink-0" />
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-fg truncate">{folder.name}</h1>
          <p className="text-[10px] text-fg-faint truncate">
            {t('knowledge.folderAttachments')} · {crumbs.map((c) => c.name).join(' / ')}
          </p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 md:px-4 py-3">
        <DriveBrowser owner={{ scope: 'kb', visibility }} initialFolderId={folderId} />
      </div>
    </div>
  );
}

// ─── New Doc View (redirect to editor) ──────────────────

function NewDocView({
  basePath,
  defaultVisibility,
  folderId,
}: {
  basePath: string;
  defaultVisibility: 'team' | 'private';
  /** kb folder the new doc lands in (from `#/knowledge/new/.../folder/<id>`). */
  folderId?: number;
}) {
  const t = useT();
  const bump = useKnowledgeStore((s) => s.bump);
  const [editor, setEditor] = useState<EditorState>(emptyEditor(defaultVisibility));
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState<{ id: number; slug: string; title: string }[]>([]);
  // An empty new doc is not "unsaved work" — the baseline is the blank form, so
  // the guard only arms once something has actually been typed or templated in.
  const [baseline] = useState(() => editorSignature(emptyEditor(defaultVisibility)));
  const [created, setCreated] = useState(false);

  useEffect(() => {
    listKnowledgeTemplates()
      .then(setTemplates)
      .catch(() => setTemplates([]));
  }, []);

  const applyTemplate = async (id: number) => {
    try {
      const doc = await getKnowledgeDocById(id);
      setEditor((e) => ({
        ...e,
        value: { markdown: doc.content_markdown || '', json: doc.content_json || '{}' },
        summary: doc.summary || '',
        tagsText: safeParse<string[]>(doc.tags, []).join(', '),
      }));
      toast(t('knowledge.fromTemplate'), 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : t('knowledge.loadFailed'), 'error');
    }
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
        slug: editor.slug.trim() || slugify(editor.title),
        content_markdown: editor.value.markdown,
        content_json: editor.value.json,
        visibility: editor.visibility,
        status: editor.status,
        tags: parseTags(editor.tagsText),
        summary: editor.summary,
        folder_id: folderId,
      };
      const saved = await createKnowledgeDoc(payload);
      toast(t('knowledge.docCreated'), 'success');
      setCreated(true);
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
    <div className="flex flex-col h-full min-h-0">
      {templates.length > 0 && !editor.value.markdown && (
        <div className="flex items-center gap-2 px-3 md:px-4 py-2 border-b border-edge text-sm flex-wrap">
          <span className="text-fg-faint">{t('knowledge.fromTemplate')}:</span>
          {templates.map((tpl) => (
            <Button key={tpl.id} size="sm" variant="secondary" onClick={() => applyTemplate(tpl.id)}>
              {tpl.title}
            </Button>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <EditorView
          editor={editor}
          saving={saving}
          dirty={!created && editorSignature(editor) !== baseline}
          onChange={setEditor}
          onSave={handleSave}
          onCancel={() => window.history.back()}
        />
      </div>
    </div>
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
 * (internal, personal) for a consistent look.
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

/**
 * Editing presence: while an existing doc's editor is open, beat every 30s and
 * return the OTHER current editors (the server excludes self). No-op for new docs.
 */
function useEditingPresence(docId?: number): KnowledgeEditorPresence[] {
  const [editors, setEditors] = useState<KnowledgeEditorPresence[]>([]);
  useEffect(() => {
    if (!docId) return;
    let alive = true;
    const beat = () =>
      pingEditingPresence(docId)
        .then((e) => alive && setEditors(e))
        .catch(() => {});
    beat();
    const iv = setInterval(beat, 30_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [docId]);
  return editors;
}

/** Full-page editor: top bar (Back/Cancel + Save top-right) over the editor fields. */
function EditorView({
  editor,
  saving,
  dirty,
  onChange,
  onSave,
  onCancel,
}: {
  editor: EditorState;
  saving: boolean;
  /** Unsaved edits since the editor opened — drives the badge and the leave guard. */
  dirty: boolean;
  onChange: (state: EditorState) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const otherEditors = useEditingPresence(editor.id);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Set once the user has answered "discard" here, so the router's guard doesn't
  // ask the same question again on the navigation that answer causes. It is
  // never reset: this editor instance has been told the edits are unwanted, and
  // it unmounts on the way out (a fresh one starts guarded again).
  const discarded = useRef(false);

  // Two exits to cover, and they need different mechanisms: leaving inside the
  // app (sidebar, nav, Back) goes through the router's guard; closing or
  // reloading the tab is the browser's own prompt.
  //
  // The router asks the guard from inside a `hashchange` listener, so it must
  // read REFS, not the render's props: a successful save navigates in the same
  // turn it stops being dirty, and a guard closed over a stale `true` would pop
  // the discard dialog on the way out of a save that worked.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const savingRef = useRef(saving);
  savingRef.current = saving;
  useEffect(() => {
    const release = registerNavigationGuard(() => dirtyRef.current && !savingRef.current && !discarded.current);
    return release;
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const leave = () => (dirty ? setConfirmDiscard(true) : onCancel());

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 md:px-4 py-2 border-b border-edge bg-surface-raised flex-shrink-0">
        <Button variant="ghost" size="sm" onClick={leave}>
          ← {t('common.back')}
        </Button>
        <span className="text-sm font-medium text-fg truncate">
          {editor.id ? t('knowledge.editDocTitle') : t('knowledge.newDocTitle')}
        </span>
        <div className="flex-1" />
        {dirty && (
          <span className="flex items-center gap-1.5 text-xs text-warning-fg" title={t('common.unsavedDesc')}>
            <span className="w-1.5 h-1.5 rounded-full bg-warning" />
            {t('common.unsavedChanges')}
          </span>
        )}
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving ? <Spinner className="mr-1" /> : <Save size={14} className="mr-1" />}
          {t('common.save')}
        </Button>
      </div>
      <ConfirmDialog
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          discarded.current = true;
          onCancel();
        }}
        title={t('common.unsavedTitle')}
        description={t('common.unsavedDesc')}
        confirmLabel={t('common.discardChanges')}
        confirmVariant="destructive"
      />
      {otherEditors.length > 0 && (
        <div className="flex items-center gap-1.5 px-3 md:px-4 py-1.5 border-b border-edge bg-warning-subtle text-warning-fg text-xs flex-shrink-0">
          <Eye size={12} />
          {otherEditors.length === 1
            ? t('knowledge.editingNow', { who: otherEditors[0].nickname })
            : t('knowledge.editingNowMulti', { who: otherEditors[0].nickname, count: otherEditors.length - 1 })}
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        <EditorInline editor={editor} onChange={onChange} />
      </div>
    </div>
  );
}

function EditorInline({ editor, onChange }: { editor: EditorState; onChange: (state: EditorState) => void }) {
  const t = useT();
  // Always collapsed on open: the advanced fields all auto-fill, and an expanded
  // block pushes the body — the thing you came to write — below the fold. Which
  // of them already carry a value is spelled out on the toggle instead, so
  // collapsing never hides content silently.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const filledAdvanced = [
    editor.slug && editor.slug !== slugify(editor.title) ? t('knowledge.fieldSlug') : '',
    editor.tagsText.trim() ? t('knowledge.fieldTags') : '',
    editor.summary.trim() ? t('knowledge.fieldSummary') : '',
  ].filter(Boolean);

  return (
    <div className="p-3 sm:p-4 space-y-3">
      {/* Essentials on one line: the title owns half, the two selects a quarter
          each. They stack below md, where a 25% select is unusable. */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <label className="space-y-1 md:col-span-2">
          <span className="text-xs font-medium text-fg-muted">{t('knowledge.fieldTitle')}</span>
          <Input
            value={editor.title}
            onChange={(e) => onChange({ ...editor, title: e.target.value, slug: nextSlug(editor, e.target.value) })}
            placeholder={t('knowledge.titlePlaceholder')}
          />
        </label>
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

      {/* Advanced (optional) — Slug/Tags/Summary all auto-fill when left blank. */}
      <div className="border-t border-edge pt-2">
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg"
          aria-expanded={showAdvanced}
        >
          {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {t('knowledge.advancedOptions')}
          {!showAdvanced && filledAdvanced.length > 0 && (
            <span className="font-normal text-fg-faint">· {filledAdvanced.join(', ')}</span>
          )}
        </button>
        {showAdvanced && (
          <div className="grid md:grid-cols-2 gap-3 mt-3">
            <p className="md:col-span-2 -mb-1 text-xs text-fg-faint">{t('knowledge.advancedHint')}</p>
            <label className="space-y-1">
              <span className="text-xs font-medium text-fg-muted">{t('knowledge.fieldSlug')}</span>
              <Input
                value={editor.slug}
                onChange={(e) => onChange({ ...editor, slug: slugify(e.target.value) })}
                placeholder={t('knowledge.slugPlaceholder')}
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
            <label className="space-y-1 md:col-span-2">
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
