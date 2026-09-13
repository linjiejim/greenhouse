/**
 * Knowledge nav panel — sidebar contextual panel for the Knowledge tab.
 *
 * Layout mirrors the Chat history panel: a search + quick-actions row on top,
 * a horizontal scope-tab pill bar (All / Public / Internal / Personal / Shared)
 * below it, then the active tab's content filling the panel. Typing in the
 * search box switches the panel to unified search results, scoped to the active
 * tab (All searches every scope at once and groups the hits).
 *
 * The internal/personal tabs render ONE tree of folders *and* documents — the
 * panel is the knowledge navigator, so the main area only ever shows a detail
 * (no parallel document list). Rows support drag-to-move and a right-click /
 * `⋯` menu (same items either way); see docs/specs/20260725-knowledge-tree-navigator.md.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Download,
  Folder,
  FolderOpen,
  FolderPlus,
  ChevronDown,
  Edit3,
  Link,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Share2,
  FileText,
  Trash2,
} from '../../../lib/icons';
import { Spinner, toast, FilterPills, Dialog, Input, Button, ConfirmDialog } from '../../../components/ui';
import { SidebarToolbar } from '../sidebar-toolbar';
import { useAuthStore, useKnowledgeStore } from '../../../stores';
import { useT } from '../../../lib/i18n';
import { toSearchSummary } from '../../../lib/search-summary';
import {
  listAllKnowledgeDocs,
  updateKnowledgeDoc,
  archiveKnowledgeDoc,
  reorderKnowledgeTree,
  searchKnowledge,
} from '../../../lib/api/knowledge';
import { downloadAuthenticatedFile } from '../../../lib/file-download';
import {
  listDriveFolders,
  createDriveFolder,
  updateDriveFolder,
  deleteDriveFolder,
  type DriveFolder,
} from '../../../lib/api/drive';
import { ContextMenu, useContextMenu, type ContextMenuItem } from '../context-menu';
import { KnowledgeShareDialog } from '../../knowledge';
import {
  dropLegacyKey,
  loadExpanded,
  migrateLegacyExpanded,
  saveExpanded,
  type TreeScope,
} from './knowledge-tree-expansion';
import { computeOrder, isSameOrder, useTreeDrag, NO_DRAG_ATTR, type DropEdge } from './use-tree-drag';
import type { KnowledgeDoc, KnowledgeSearchHit } from '@greenhouse/types/api';

// The active scope tab persists across reloads (single key — replaces the four
// per-section collapse keys the stacked layout used; the tree's own expansion
// keys live in knowledge-tree-expansion.ts).
const TAB_KEY = 'kb-active-tab';

type Tab = 'all' | 'internal' | 'personal' | 'shared';

/**
 * Map the current knowledge sub-route to the tab that should be highlighted, so
 * a deeplink into a doc opens the right tab. Returns null when the route carries
 * no strong scope signal (`new`, empty) — the stored tab is kept, honouring the
 * All default.
 */
function resolveTab(subPath: string): Tab | null {
  const seg0 = subPath.split('/').filter(Boolean)[0] || '';
  if (seg0 === 'internal' || seg0 === 'folder') return 'internal';
  if (seg0 === 'personal') return 'personal';
  if (seg0 === 'shared') return 'shared';
  return null;
}

function loadInitialTab(): Tab {
  try {
    const raw = localStorage.getItem(TAB_KEY);
    if (raw === 'all' || raw === 'internal' || raw === 'personal' || raw === 'shared') return raw;
  } catch {
    /* ignore */
  }
  return 'all';
}

/** Slug of the doc the route currently points at (ignores a trailing `/edit`). */
function routeDocSlug(subPath: string): string | null {
  const segs = subPath.split('/').filter(Boolean);
  const seg0 = segs[0];
  const raw =
    seg0 === 'internal' || seg0 === 'folder' ? segs[2] : seg0 === 'personal' || seg0 === 'shared' ? segs[1] : undefined;
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

interface KnowledgeNavPanelProps {
  activeModule?: string;
  collapsed?: boolean;
  /** Called after any navigation — the mobile drawer uses it to close itself. */
  onNavigate?: () => void;
}

// ─── Unified search result model ─────────────────────────

type ResultScope = 'team' | 'personal' | 'shared';
interface ResultItem {
  key: string;
  title: string;
  snippet: string;
  hash: string;
  note?: string;
}
interface ResultGroup {
  scope: ResultScope;
  items: ResultItem[];
}

/** Canonical deeplink used by "copy link" (id authoritative, slug decorative). */
function docDeeplink(doc: KnowledgeDoc): string {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#/knowledge/doc/${doc.id}-${encodeURIComponent(doc.slug)}`;
}

/** Effective role on a doc, with the same fallbacks the detail page uses. */
function docAccess(doc: KnowledgeDoc): 'owner' | 'editor' | 'reader' {
  return doc.access ?? (doc.visibility === 'team' ? 'editor' : 'owner');
}

/** `#/knowledge/new[/personal][/folder/<id>]` — the editor lands the doc in `folderId`. */
function newDocPath(scope: TreeScope, folderId?: number | null): string {
  return `#/knowledge/new${scope === 'private' ? '/personal' : ''}${folderId != null ? `/folder/${folderId}` : ''}`;
}

function scopeLandingPath(scope: TreeScope): string {
  return scope === 'private' ? '#/knowledge/personal' : '#/knowledge/internal';
}

export function KnowledgeNavPanel({ activeModule = '', collapsed, onNavigate }: KnowledgeNavPanelProps) {
  const t = useT();
  const { currentUser } = useAuthStore();
  const exportingRef = useRef(false);
  const docsVersion = useKnowledgeStore((s) => s.version);
  const bump = useKnowledgeStore((s) => s.bump);

  const [activeTab, setActiveTab] = useState<Tab>(loadInitialTab);
  const [searchQuery, setSearchQuery] = useState('');

  // Docs split by effective access role (team / own private / shared-with-me).
  const [internalDocs, setInternalDocs] = useState<KnowledgeDoc[]>([]);
  const [personalDocs, setPersonalDocs] = useState<KnowledgeDoc[]>([]);
  const [sharedDocs, setSharedDocs] = useState<KnowledgeDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);

  // kb folders (directory tree) — the whole scope in one request (`'all'`), so
  // the nested tree renders without per-level fetches.
  const [kbFolders, setKbFolders] = useState<DriveFolder[]>([]);
  const [personalFolders, setPersonalFolders] = useState<DriveFolder[]>([]);

  // Unified search state.
  const [searchGroups, setSearchGroups] = useState<ResultGroup[] | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);

  // Row actions: one menu definition, two triggers (right-click and the ⋯ button).
  const { menu, openMenu, closeMenu } = useContextMenu();
  const [namePrompt, setNamePrompt] = useState<NamePromptState | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTargetState | null>(null);
  const [shareDoc, setShareDoc] = useState<KnowledgeDoc | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<KnowledgeDoc | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<DriveFolder | null>(null);
  // A folder created inside a collapsed parent would land out of sight — ask the
  // tree to reveal the parent once, then forget it (so the user can collapse it
  // again). Cleared by the tree through `onRevealed`.
  const [revealFolder, setRevealFolder] = useState<{ scope: TreeScope; id: number } | null>(null);
  const clearReveal = useCallback(() => setRevealFolder(null), []);

  // Persist the active tab; keep it in sync with the route when the route
  // encodes a scope (deeplinks), without clobbering a manual pill click.
  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, activeTab);
    } catch {
      /* ignore */
    }
  }, [activeTab]);
  const routeTab = resolveTab(activeModule);
  useEffect(() => {
    if (routeTab) setActiveTab(routeTab);
  }, [routeTab]);

  useEffect(() => {
    let cancelled = false;
    listDriveFolders({ scope: 'kb', visibility: 'team' }, 'all')
      .then((f) => !cancelled && setKbFolders(f))
      .catch(() => !cancelled && setKbFolders([]));
    listDriveFolders({ scope: 'kb', visibility: 'private' }, 'all')
      .then((f) => !cancelled && setPersonalFolders(f))
      .catch(() => !cancelled && setPersonalFolders([]));
    return () => {
      cancelled = true;
    };
  }, [docsVersion]);

  // Three scoped, fully-paged calls rather than one unscoped call: the list
  // endpoint caps each visibility branch at 100 rows and applies `offset` per
  // branch, so the old single unlimited call silently dropped every team doc
  // past the 50th — a tree that hides documents is worse than a slow one.
  useEffect(() => {
    let cancelled = false;
    setDocsLoading(true);
    Promise.all([
      listAllKnowledgeDocs({ status: 'published', visibility: 'team' }),
      listAllKnowledgeDocs({ status: 'published', visibility: 'private' }),
      listAllKnowledgeDocs({ status: 'published', visibility: 'shared' }),
    ])
      .then(([team, mine, shared]) => {
        if (cancelled) return;
        setInternalDocs(team);
        setPersonalDocs(mine.filter((d) => d.access === 'owner'));
        setSharedDocs(shared.filter((d) => d.access !== 'owner'));
        setDocsLoading(false);
      })
      .catch(() => {
        if (!cancelled) setDocsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [docsVersion]);

  const navigate = useCallback(
    (path: string) => {
      window.location.hash = path.replace(/^#/, '');
      onNavigate?.();
    },
    [onNavigate],
  );

  const isActive = useCallback((path: string) => {
    const current = window.location.hash.replace(/^#\/?/, '');
    const target = path.replace(/^#\/?/, '');
    return current === target || current.startsWith(target + '/');
  }, []);

  // ── Scope paths (used by tree rows + the All overview) ──
  const internalDocPath = useCallback(
    (doc: KnowledgeDoc) =>
      `#/knowledge/internal/${encodeURIComponent(doc.space || 'general')}/${encodeURIComponent(doc.slug)}`,
    [],
  );
  const personalDocPath = useCallback(
    (doc: KnowledgeDoc) => `#/knowledge/personal/${encodeURIComponent(doc.slug)}`,
    [],
  );
  const sharedDocPath = useCallback((doc: KnowledgeDoc) => `#/knowledge/shared/${encodeURIComponent(doc.slug)}`, []);
  const docPathFor = useCallback(
    (doc: KnowledgeDoc) =>
      doc.visibility === 'team'
        ? internalDocPath(doc)
        : docAccess(doc) === 'owner'
          ? personalDocPath(doc)
          : sharedDocPath(doc),
    [internalDocPath, personalDocPath, sharedDocPath],
  );
  // ── Mutations (all refresh the tree through the shared store version) ──

  /** Move a doc into a kb folder (null = root). */
  const moveDocToFolder = useCallback(
    async (docId: number, folderId: number | null) => {
      try {
        await updateKnowledgeDoc(docId, { folder_id: folderId });
        bump();
      } catch (err) {
        toast(err instanceof Error ? err.message : t('knowledge.moveFailed'), 'error');
      }
    },
    [bump, t],
  );

  /** Re-parent a folder (null = root). Cycles are rejected server-side too. */
  const moveFolder = useCallback(
    async (folderId: number, parentId: number | null) => {
      try {
        await updateDriveFolder(folderId, { parent_id: parentId });
        bump();
      } catch (err) {
        toast(err instanceof Error ? err.message : t('knowledge.moveFailed'), 'error');
      }
    },
    [bump, t],
  );

  /**
   * Persist a manual sibling order. Placement (which folder) already happened
   * through the move endpoints above; this only writes the order, so a failure
   * here leaves the node in the right folder with its default position — the
   * refetch shows the truth either way.
   */
  const reorderSiblings = useCallback(
    async (kind: 'doc' | 'folder', parentId: number | null, orderedIds: number[]) => {
      try {
        await reorderKnowledgeTree(kind, parentId, orderedIds);
      } catch (err) {
        toast(err instanceof Error ? err.message : t('knowledge.reorderFailed'), 'error');
      } finally {
        bump();
      }
    },
    [bump, t],
  );

  /**
   * Download a Markdown zip: the whole team library, one folder's subtree, or a
   * single doc. Packing runs server-side (one request, self-contained archive);
   * the toast is there because the wait is real once images are involved.
   */
  const exportLibrary = useCallback(
    async (target?: { folderId?: number; docId?: number; name?: string }) => {
      if (exportingRef.current) return;
      exportingRef.current = true;
      toast(t('knowledge.exportRunning'), 'info');
      try {
        const query = target?.folderId
          ? `?folder_id=${target.folderId}`
          : target?.docId
            ? `?doc_id=${target.docId}`
            : '';
        const stamp = new Date().toISOString().slice(0, 10);
        const base = target?.name ? target.name.replace(/[/\\:*?"<>|]/g, '-').slice(0, 60) : 'knowledge';
        await downloadAuthenticatedFile(`/api/knowledge/export${query}`, `greenhouse-${base}-${stamp}.zip`);
        toast(t('knowledge.exportDone'), 'success');
      } catch (err) {
        toast(err instanceof Error ? err.message : t('knowledge.exportFailed'), 'error');
      } finally {
        exportingRef.current = false;
      }
    },
    [t],
  );

  /** Move one node up/down among its siblings — the keyboard/touch path to ordering. */
  const nudge = useCallback(
    (kind: 'doc' | 'folder', parentId: number | null, siblingIds: number[], id: number, delta: -1 | 1) => {
      const from = siblingIds.indexOf(id);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= siblingIds.length) return;
      const ids = [...siblingIds];
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      void reorderSiblings(kind, parentId, ids);
    },
    [reorderSiblings],
  );

  const submitNamePrompt = useCallback(
    async (value: string) => {
      if (!namePrompt) return;
      const name = value.trim();
      if (!name) return;
      try {
        if (namePrompt.mode === 'create') {
          await createDriveFolder({ scope: 'kb', visibility: namePrompt.scope }, namePrompt.parentId, name);
          toast(t('knowledge.folderCreated'), 'success');
          // Root-level folders are always visible; a subfolder needs its parent open.
          if (namePrompt.parentId != null) setRevealFolder({ scope: namePrompt.scope, id: namePrompt.parentId });
        } else if (namePrompt.mode === 'rename') {
          await updateDriveFolder(namePrompt.folderId, { name });
          toast(t('knowledge.folderRenamed'), 'success');
        } else {
          // Title only — sending a slug here would repoint every existing link
          // to the doc (copied URLs, `[[refs]]`, the export manifest).
          await updateKnowledgeDoc(namePrompt.docId, { title: name });
          toast(t('knowledge.docRenamed'), 'success');
        }
        bump();
      } catch (err) {
        toast(err instanceof Error ? err.message : t('common.saveFailed'), 'error');
      } finally {
        setNamePrompt(null);
      }
    },
    [namePrompt, bump, t],
  );

  const confirmDeleteFolder = useCallback(async () => {
    if (!deleteFolderTarget) return;
    try {
      await deleteDriveFolder(deleteFolderTarget.id);
      toast(t('knowledge.folderDeleted'), 'success');
      bump();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      toast(msg === 'not_empty' ? t('knowledge.deleteFolderNotEmpty') : msg || t('common.deleteFailed'), 'error');
    } finally {
      setDeleteFolderTarget(null);
    }
  }, [deleteFolderTarget, bump, t]);

  const confirmArchiveDoc = useCallback(async () => {
    if (!archiveTarget) return;
    const wasActive = isActive(docPathFor(archiveTarget));
    try {
      await archiveKnowledgeDoc(archiveTarget.id);
      toast(t('knowledge.docArchived'), 'success');
      bump();
      if (wasActive) navigate(scopeLandingPath(archiveTarget.visibility === 'team' ? 'team' : 'private'));
    } catch (err) {
      toast(err instanceof Error ? err.message : t('knowledge.archiveFailed'), 'error');
    } finally {
      setArchiveTarget(null);
    }
  }, [archiveTarget, bump, isActive, docPathFor, navigate, t]);

  const copyDocLink = useCallback(
    (doc: KnowledgeDoc) => {
      navigator.clipboard
        ?.writeText(docDeeplink(doc))
        .then(() => toast(t('knowledge.linkCopied'), 'success'))
        .catch(() => toast(t('common.failed'), 'error'));
    },
    [t],
  );

  // ── Row menus (right-click and ⋯ share one definition) ──

  /**
   * Up/down items for a row. Dragging is the primary gesture and works on touch
   * too (long-press), but it is still unreachable by keyboard and awkward on a
   * long list, so ordering also exists as plain menu commands.
   */
  const nudgeItems = useCallback(
    (kind: 'doc' | 'folder', parentId: number | null, siblingIds: number[], id: number): ContextMenuItem[] => {
      const at = siblingIds.indexOf(id);
      const items: ContextMenuItem[] = [];
      if (at > 0) {
        items.push({
          label: t('knowledge.moveUp'),
          icon: ArrowUp,
          onClick: () => nudge(kind, parentId, siblingIds, id, -1),
        });
      }
      if (at >= 0 && at < siblingIds.length - 1) {
        items.push({
          label: t('knowledge.moveDown'),
          icon: ArrowDown,
          onClick: () => nudge(kind, parentId, siblingIds, id, 1),
        });
      }
      return items;
    },
    [nudge, t],
  );

  const folderMenuItems = useCallback(
    (folder: DriveFolder, scope: TreeScope): ContextMenuItem[] => [
      { label: t('knowledge.newDoc'), icon: FileText, onClick: () => navigate(newDocPath(scope, folder.id)) },
      {
        label: t('knowledge.newSubfolder'),
        icon: FolderPlus,
        onClick: () => setNamePrompt({ mode: 'create', scope, parentId: folder.id, initial: '' }),
      },
      {
        label: t('common.rename'),
        icon: Pencil,
        onClick: () => setNamePrompt({ mode: 'rename', scope, folderId: folder.id, initial: folder.name }),
      },
      {
        label: t('knowledge.moveTo'),
        icon: FolderOpen,
        onClick: () => setMoveTarget({ kind: 'folder', scope, id: folder.id, name: folder.name }),
      },
      ...nudgeItems(
        'folder',
        folder.parent_id ?? null,
        (scope === 'team' ? kbFolders : personalFolders)
          .filter((f) => (f.parent_id ?? null) === (folder.parent_id ?? null))
          .sort(byFolderOrder)
          .map((f) => f.id),
        folder.id,
      ),
      // Scoped export keeps the same super-only boundary as the whole-library
      // one; it exists so an admin can grab one column instead of everything.
      ...(currentUser?.role === 'super' && scope === 'team'
        ? [
            {
              label: t('knowledge.exportFolder'),
              icon: Download,
              onClick: () => void exportLibrary({ folderId: folder.id, name: folder.name }),
            },
          ]
        : []),
      {
        label: t('knowledge.openAttachments'),
        icon: Paperclip,
        onClick: () => navigate(`#/knowledge/folder/${folder.id}`),
      },
      { label: t('common.delete'), icon: Trash2, danger: true, onClick: () => setDeleteFolderTarget(folder) },
    ],
    [currentUser?.role, exportLibrary, kbFolders, navigate, nudgeItems, personalFolders, t],
  );

  const docMenuItems = useCallback(
    (doc: KnowledgeDoc, scope: TreeScope): ContextMenuItem[] => {
      const access = docAccess(doc);
      const canEdit = access === 'owner' || access === 'editor';
      const path = docPathFor(doc);
      const items: ContextMenuItem[] = [{ label: t('common.open'), icon: FileText, onClick: () => navigate(path) }];
      if (canEdit) {
        items.push({ label: t('common.edit'), icon: Edit3, onClick: () => navigate(`${path}/edit`) });
        items.push({
          label: t('common.rename'),
          icon: Pencil,
          onClick: () => setNamePrompt({ mode: 'rename-doc', docId: doc.id, initial: doc.title }),
        });
        items.push({
          label: t('knowledge.moveTo'),
          icon: FolderOpen,
          onClick: () => setMoveTarget({ kind: 'doc', scope, id: doc.id, name: doc.title }),
        });
        items.push(
          ...nudgeItems(
            'doc',
            doc.folder_id ?? null,
            (scope === 'team' ? internalDocs : personalDocs)
              .filter((d) => (d.folder_id ?? null) === (doc.folder_id ?? null))
              .sort(byDocOrder)
              .map((d) => d.id),
            doc.id,
          ),
        );
      }
      if (access === 'owner' && doc.visibility === 'private') {
        items.push({ label: t('knowledge.share'), icon: Share2, onClick: () => setShareDoc(doc) });
      }
      items.push({ label: t('knowledge.copyLink'), icon: Link, onClick: () => copyDocLink(doc) });
      if (currentUser?.role === 'super' && doc.visibility === 'team') {
        items.push({
          label: t('knowledge.exportDoc'),
          icon: Download,
          onClick: () => void exportLibrary({ docId: doc.id, name: doc.title }),
        });
      }
      if (doc.visibility === 'team' || access === 'owner') {
        items.push({ label: t('common.archive'), icon: Archive, danger: true, onClick: () => setArchiveTarget(doc) });
      }
      return items;
    },
    [copyDocLink, currentUser?.role, docPathFor, exportLibrary, internalDocs, navigate, nudgeItems, personalDocs, t],
  );

  // ── Unified search ──
  const scopeLabel = useCallback(
    (s: ResultScope): string =>
      ({
        team: t('knowledge.tabInternal'),
        personal: t('knowledge.tabPersonal'),
        shared: t('knowledge.tabShared'),
      })[s],
    [t],
  );

  const runSearch = useCallback(
    async (query: string, tab: Tab): Promise<ResultGroup[]> => {
      const kbItems = (hits: KnowledgeSearchHit[]): ResultItem[] =>
        hits.map((h) => ({
          key: `kb-${h.id}`,
          title: h.title,
          snippet: toSearchSummary(h.summary),
          // Stable deeplink — id authoritative, resolves to the scope-specific route.
          hash: `#/knowledge/doc/${h.id}-${encodeURIComponent(h.slug)}`,
          note: h.access === 'reader' ? t('knowledge.readOnly') : undefined,
        }));
      if (tab === 'internal')
        return [{ scope: 'team', items: kbItems((await searchKnowledge(query, 'team')).results) }];
      if (tab === 'personal')
        return [{ scope: 'personal', items: kbItems((await searchKnowledge(query, 'personal')).results) }];
      if (tab === 'shared')
        return [{ scope: 'shared', items: kbItems((await searchKnowledge(query, 'shared')).results) }];

      // All — every scope at once.
      const kb = (await searchKnowledge(query, 'all')).results;
      const groups: ResultGroup[] = [];
      const team = kb.filter((h) => h.scope === 'team');
      const personal = kb.filter((h) => h.scope === 'personal');
      const shared = kb.filter((h) => h.scope === 'shared');
      if (team.length) groups.push({ scope: 'team', items: kbItems(team) });
      if (personal.length) groups.push({ scope: 'personal', items: kbItems(personal) });
      if (shared.length) groups.push({ scope: 'shared', items: kbItems(shared) });
      return groups;
    },
    [t],
  );

  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) {
      setSearchGroups(null);
      setSearchLoading(false);
      return;
    }
    setSearchLoading(true);
    let cancelled = false;
    const handle = setTimeout(() => {
      runSearch(query, activeTab)
        .then((g) => !cancelled && setSearchGroups(g))
        .catch(() => !cancelled && setSearchGroups([]))
        .finally(() => !cancelled && setSearchLoading(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [searchQuery, activeTab, runSearch]);

  const activeSlug = routeDocSlug(activeModule);

  if (collapsed) return null;

  const tabItems = [
    { key: 'all', label: t('knowledge.tabAll') },
    { key: 'internal', label: t('knowledge.tabInternal'), count: internalDocs.length || undefined },
    { key: 'personal', label: t('knowledge.tabPersonal'), count: personalDocs.length || undefined },
    { key: 'shared', label: t('knowledge.tabShared'), count: sharedDocs.length || undefined },
  ];

  const loadingBlock = (
    <div className="flex justify-center py-3">
      <Spinner className="h-4 w-4" />
    </div>
  );
  const emptyBlock = (text: string) => <div className="px-3 py-2 text-[11px] text-fg-faint">{text}</div>;

  // ── All overview: recently edited only (scope pills are the sole navigation) ──
  const renderAll = () => {
    const recent = [
      ...internalDocs.map((doc) => ({ doc, hash: internalDocPath(doc) })),
      ...personalDocs.map((doc) => ({ doc, hash: personalDocPath(doc) })),
      ...sharedDocs.map((doc) => ({ doc, hash: sharedDocPath(doc) })),
    ]
      .filter((x) => x.doc.updated_at)
      .sort((a, b) => new Date(b.doc.updated_at!).getTime() - new Date(a.doc.updated_at!).getTime())
      .slice(0, 6);

    return (
      <div className="pt-1">
        {docsLoading ? (
          loadingBlock
        ) : recent.length > 0 ? (
          <div>
            <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
              {t('knowledge.recentlyEdited')}
            </div>
            <div className="space-y-0.5">
              {recent.map(({ doc, hash }) => (
                <DocRow key={doc.id} title={doc.title} active={isActive(hash)} onClick={() => navigate(hash)} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const renderTree = (scope: TreeScope) => {
    const folders = scope === 'team' ? kbFolders : personalFolders;
    const docs = scope === 'team' ? internalDocs : personalDocs;
    if (docsLoading) return loadingBlock;
    if (folders.length === 0 && docs.length === 0)
      return emptyBlock(scope === 'team' ? t('knowledge.noDocs') : t('knowledge.noPersonalDocs'));
    return (
      <KnowledgeTree
        scope={scope}
        folders={folders}
        docs={docs}
        activeSlug={activeSlug}
        revealFolderId={revealFolder && revealFolder.scope === scope ? revealFolder.id : null}
        onRevealed={clearReveal}
        onOpenDoc={(doc) => navigate(docPathFor(doc))}
        onDocMenu={(e, doc) => openMenu(e, docMenuItems(doc, scope))}
        onFolderMenu={(e, folder) => openMenu(e, folderMenuItems(folder, scope))}
        onMoveDoc={moveDocToFolder}
        onMoveFolder={moveFolder}
        onReorder={reorderSiblings}
      />
    );
  };

  const renderShared = () => {
    if (docsLoading) return loadingBlock;
    if (sharedDocs.length === 0) return emptyBlock(t('knowledge.noSharedDocs'));
    return (
      <div className="space-y-0.5 pt-1">
        {sharedDocs.map((doc) => (
          <DocRow
            key={doc.id}
            title={doc.title}
            note={docAccess(doc) === 'editor' ? t('knowledge.editable') : undefined}
            active={isActive(sharedDocPath(doc))}
            onClick={() => navigate(sharedDocPath(doc))}
          />
        ))}
      </div>
    );
  };

  const renderTab = () => {
    switch (activeTab) {
      case 'all':
        return renderAll();
      case 'internal':
        return renderTree('team');
      case 'personal':
        return renderTree('private');
      case 'shared':
        return renderShared();
    }
  };

  const renderSearch = () => {
    if (searchLoading) {
      return (
        <div className="flex items-center gap-2 justify-center py-4 text-[11px] text-fg-faint">
          <Spinner className="h-4 w-4" /> {t('knowledge.searching')}
        </div>
      );
    }
    const groups = (searchGroups ?? []).filter((g) => g.items.length > 0);
    if (groups.length === 0) return emptyBlock(t('knowledge.noResults'));
    return (
      <div className="pt-1 space-y-2">
        {groups.map((group) => (
          <div key={group.scope}>
            <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
              {scopeLabel(group.scope)}
            </div>
            <div className="divide-y divide-edge/50">
              {group.items.map((item) => (
                <button
                  key={item.key}
                  onClick={() => navigate(item.hash)}
                  className="w-full text-left px-2.5 py-2 hover:bg-surface-sunken transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-fg-secondary truncate flex-1" title={item.title}>
                      {item.title}
                    </span>
                    {item.note && <span className="text-[9px] text-fg-faint flex-shrink-0">{item.note}</span>}
                  </div>
                  {item.snippet && <p className="text-[10px] text-fg-faint line-clamp-2 mt-0.5">{item.snippet}</p>}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const treeScope: TreeScope | null = activeTab === 'internal' ? 'team' : activeTab === 'personal' ? 'private' : null;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Search + quick actions */}
      <div className="px-2.5 py-2 flex-shrink-0 space-y-2">
        <SidebarToolbar
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={t('knowledge.searchAllPlaceholder')}
          actions={[
            {
              label: t('knowledge.newDoc'),
              icon: Plus,
              onClick: () => navigate(newDocPath(treeScope ?? 'team')),
            },
            ...(treeScope
              ? [
                  {
                    label: t('knowledge.newFolder'),
                    icon: FolderPlus,
                    onClick: () =>
                      setNamePrompt({ mode: 'create' as const, scope: treeScope, parentId: null, initial: '' }),
                  },
                ]
              : []),
            // Bulk-downloading the team library is an admin act, not a per-user
            // convenience — the endpoint is super-only and so is this entry.
            ...(currentUser?.role === 'super'
              ? [{ label: t('knowledge.exportAll'), icon: Download, onClick: () => void exportLibrary() }]
              : []),
          ]}
        />
        <FilterPills
          items={tabItems}
          activeKey={activeTab}
          onChange={(k) => setActiveTab((k as Tab) ?? 'all')}
          variant="segment"
          fill
        />
      </div>

      {/* Active tab content — or unified search results while searching */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">{searchQuery.trim() ? renderSearch() : renderTab()}</div>

      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
      {namePrompt && (
        <NamePromptDialog
          title={
            namePrompt.mode === 'rename-doc'
              ? t('knowledge.renameDoc')
              : namePrompt.mode === 'rename'
                ? t('knowledge.renameFolder')
                : namePrompt.parentId != null
                  ? t('knowledge.newSubfolder')
                  : t('knowledge.newFolder')
          }
          label={namePrompt.mode === 'rename-doc' ? t('knowledge.fieldTitle') : t('knowledge.folderName')}
          initial={namePrompt.initial}
          onSubmit={submitNamePrompt}
          onClose={() => setNamePrompt(null)}
        />
      )}
      {moveTarget && (
        <FolderPickerDialog
          title={t('knowledge.moveTo')}
          subject={moveTarget.name}
          folders={moveTarget.scope === 'team' ? kbFolders : personalFolders}
          excludeFolderId={moveTarget.kind === 'folder' ? moveTarget.id : undefined}
          onPick={(folderId) => {
            if (moveTarget.kind === 'doc') moveDocToFolder(moveTarget.id, folderId);
            else moveFolder(moveTarget.id, folderId);
            setMoveTarget(null);
          }}
          onClose={() => setMoveTarget(null)}
        />
      )}
      {shareDoc && (
        <KnowledgeShareDialog open onClose={() => setShareDoc(null)} docId={shareDoc.id} docTitle={shareDoc.title} />
      )}
      <ConfirmDialog
        open={!!archiveTarget}
        onClose={() => setArchiveTarget(null)}
        onConfirm={confirmArchiveDoc}
        title={t('knowledge.archiveConfirmTitle')}
        description={
          archiveTarget
            ? archiveTarget.visibility === 'team'
              ? t('knowledge.archiveConfirmTeam', { name: archiveTarget.title })
              : t('knowledge.archiveConfirmSimple', { name: archiveTarget.title })
            : undefined
        }
        confirmLabel={t('common.archive')}
        confirmVariant="destructive"
      />
      <ConfirmDialog
        open={!!deleteFolderTarget}
        onClose={() => setDeleteFolderTarget(null)}
        onConfirm={confirmDeleteFolder}
        title={t('knowledge.deleteFolderTitle')}
        description={
          deleteFolderTarget
            ? `${t('knowledge.deleteFolderDesc', { name: deleteFolderTarget.name })} ${t('knowledge.deleteFolderNotEmpty')}`
            : undefined
        }
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />
    </div>
  );
}

// ─── Dialog state ────────────────────────────────────────

type NamePromptState =
  | { mode: 'create'; scope: TreeScope; parentId: number | null; initial: string }
  | { mode: 'rename'; scope: TreeScope; folderId: number; initial: string }
  /** Doc rename = title only. The slug stays put; it is the doc's link identity. */
  | { mode: 'rename-doc'; docId: number; initial: string };

interface MoveTargetState {
  kind: 'doc' | 'folder';
  scope: TreeScope;
  id: number;
  name: string;
}

/** Single-field prompt (new folder / rename) — Enter submits. */
function NamePromptDialog({
  title,
  label,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  return (
    <Dialog open onClose={onClose} title={title} size="sm">
      <div className="space-y-3">
        <label className="space-y-1 block">
          <span className="text-xs font-medium text-fg-muted">{label}</span>
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value.trim()) onSubmit(value);
            }}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" disabled={!value.trim()} onClick={() => onSubmit(value)}>
            {t('common.confirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Destination picker for "move to…". Folders render as an indented tree; the
 * moved folder and its own descendants are omitted (moving into them would
 * detach the subtree — the server rejects it too).
 */
function FolderPickerDialog({
  title,
  subject,
  folders,
  excludeFolderId,
  onPick,
  onClose,
}: {
  title: string;
  subject: string;
  folders: DriveFolder[];
  excludeFolderId?: number;
  onPick: (folderId: number | null) => void;
  onClose: () => void;
}) {
  const t = useT();
  const blocked = useMemo(
    () => (excludeFolderId != null ? subtreeIds(folders, excludeFolderId) : new Set<number>()),
    [folders, excludeFolderId],
  );

  const rows: React.ReactNode[] = [];
  const walk = (parentId: number | null, depth: number) => {
    if (depth > 8) return;
    for (const f of folders.filter((x) => (x.parent_id ?? null) === parentId).sort(byFolderOrder)) {
      if (blocked.has(f.id)) continue;
      rows.push(
        <button
          key={f.id}
          onClick={() => onPick(f.id)}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-fg-secondary hover:text-fg hover:bg-surface-sunken transition-colors"
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <Folder size={13} className="text-fg-faint flex-shrink-0" />
          <span className="truncate">{f.name}</span>
        </button>,
      );
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);

  return (
    <Dialog open onClose={onClose} title={title} size="sm">
      <p className="text-xs text-fg-faint mb-2 truncate" title={subject}>
        {subject}
      </p>
      <div className="max-h-72 overflow-y-auto space-y-0.5">
        <button
          onClick={() => onPick(null)}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-fg-secondary hover:text-fg hover:bg-surface-sunken transition-colors"
        >
          <FolderOpen size={13} className="text-fg-faint flex-shrink-0" />
          <span className="truncate">{t('knowledge.rootFolder')}</span>
        </button>
        {rows}
      </div>
    </Dialog>
  );
}

// ─── Doc row (All overview + shared list + search) ───────

function DocRow({
  title,
  note,
  active,
  onClick,
}: {
  title: string;
  note?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 rounded-md text-xs transition-colors flex items-center gap-2 ${
        active
          ? 'bg-primary-subtle text-primary-fg-strong font-medium'
          : 'text-fg-secondary hover:text-fg hover:bg-surface-sunken'
      }`}
    >
      <FileText size={13} className={`flex-shrink-0 ${active ? 'text-primary-fg' : 'text-fg-faint'}`} />
      <span className="truncate flex-1" title={title}>
        {title}
      </span>
      {note && <span className="text-[9px] text-fg-faint flex-shrink-0">{note}</span>}
    </button>
  );
}

// ─── Knowledge tree (folders + documents) ────────────────

/**
 * Manual order first, then name. `sort_order` 0 means "never dragged", and those
 * sort AFTER the manually ordered ones rather than before: a freshly created or
 * just-moved-in document belongs at the bottom of its folder, not jumped to the
 * top of a list somebody arranged by hand. A folder nobody has ordered is all
 * zeroes, i.e. plain alphabetical — exactly what it was before ordering existed.
 */
const orderKey = (n: number) => (n > 0 ? n : Number.MAX_SAFE_INTEGER);
const byFolderOrder = (a: DriveFolder, b: DriveFolder) =>
  orderKey(a.sort_order) - orderKey(b.sort_order) || a.name.localeCompare(b.name);
const byDocOrder = (a: KnowledgeDoc, b: KnowledgeDoc) =>
  orderKey(a.sort_order) - orderKey(b.sort_order) || a.title.localeCompare(b.title);

/** A folder plus every folder beneath it (drag/move guard). */
function subtreeIds(folders: DriveFolder[], rootId: number): Set<number> {
  const ids = new Set<number>([rootId]);
  // Bounded sweep: each pass can only add descendants, so depth-many passes suffice.
  for (let i = 0; i < 64; i++) {
    const before = ids.size;
    for (const f of folders) if (f.parent_id != null && ids.has(f.parent_id)) ids.add(f.id);
    if (ids.size === before) break;
  }
  return ids;
}

/** Ancestor folder ids of `folderId`, nearest first. */
function ancestorIds(folders: DriveFolder[], folderId: number): number[] {
  const chain: number[] = [];
  let cursor: number | null = folderId;
  for (let i = 0; cursor != null && i < 64; i++) {
    chain.push(cursor);
    cursor = folders.find((f) => f.id === cursor)?.parent_id ?? null;
  }
  return chain;
}

/** Collapsed folders open after hovering this long mid-drag (file-manager habit). */
const HOVER_EXPAND_MS = 700;

const sameEdge = (a: DropEdge | null, b: DropEdge) =>
  !!a && a.parentId === b.parentId && a.group === b.group && a.index === b.index;

/**
 * Expansion state tagged with the scope it was loaded for: the tab can switch
 * between a load and the write that follows it, and the ids must never land
 * under the other scope's key. `ids === null` = migration pending (see
 * knowledge-tree-expansion.ts) — the tree renders fully expanded meanwhile,
 * matching the old default, and nothing is persisted until it resolves.
 */
type TreeExpansion = { scope: TreeScope; ids: Set<number> | null };

/**
 * Nested kb tree: folders AND the documents inside them, so the sidebar is the
 * only navigator needed. Folders arrive flat (one `parent_id=all` request) and
 * are linked here.
 *
 * Folders default to collapsed and persist their EXPANDED ids (see
 * knowledge-tree-expansion.ts), so a deep tree can't stretch the sidebar into a
 * long scroll on first visit. Anything created inside a collapsed folder has to
 * be revealed explicitly — that is what `revealFolderId` is for. Depth is capped
 * while rendering: a corrupted parent chain (a cycle) would otherwise recurse
 * forever and take the sidebar down with it.
 *
 * Exported for the sibling render test; the barrel deliberately doesn't re-export
 * it — `KnowledgeNavPanel` is the only production caller.
 */
export function KnowledgeTree({
  scope,
  folders,
  docs,
  activeSlug,
  revealFolderId,
  onRevealed,
  onOpenDoc,
  onDocMenu,
  onFolderMenu,
  onMoveDoc,
  onMoveFolder,
  onReorder,
}: {
  scope: TreeScope;
  folders: DriveFolder[];
  docs: KnowledgeDoc[];
  activeSlug: string | null;
  /** Folder to expand down to once (a freshly created subfolder's parent). */
  revealFolderId: number | null;
  onRevealed: () => void;
  onOpenDoc: (doc: KnowledgeDoc) => void;
  onDocMenu: (e: React.MouseEvent, doc: KnowledgeDoc) => void;
  onFolderMenu: (e: React.MouseEvent, folder: DriveFolder) => void;
  onMoveDoc: (docId: number, folderId: number | null) => void;
  onMoveFolder: (folderId: number, parentId: number | null) => void;
  onReorder: (kind: 'doc' | 'folder', parentId: number | null, orderedIds: number[]) => void;
}) {
  const t = useT();
  const [expansion, setExpansion] = useState<TreeExpansion>(() => ({ scope, ids: loadExpanded(scope) }));
  const hoverExpandRef = useRef<{ id: number; timer: number } | null>(null);

  useEffect(() => {
    setExpansion((prev) => (prev.scope === scope ? prev : { scope, ids: loadExpanded(scope) }));
  }, [scope]);

  // Migration off the legacy "collapsed ids" key needs every folder id, and those
  // arrive asynchronously — so it waits, and until it lands nothing is written
  // (an early write would create the new key and erase the migration signal).
  useEffect(() => {
    if (expansion.ids !== null || expansion.scope !== scope || folders.length === 0) return;
    setExpansion({
      scope,
      ids: migrateLegacyExpanded(
        scope,
        folders.map((f) => f.id),
      ),
    });
    dropLegacyKey(scope);
  }, [expansion, folders, scope]);

  // Mirrors the committed expansion so `revealChain` can read it without going
  // through a state updater (see there). Updated in the same effect that saves,
  // so the ref and localStorage never disagree.
  const expansionRef = useRef(expansion);
  useEffect(() => {
    expansionRef.current = expansion;
    if (expansion.ids) saveExpanded(expansion.scope, expansion.ids);
  }, [expansion]);

  // On the one render between a tab switch and the effect above, read the new
  // scope's set directly — exactly what is about to be committed, so switching
  // tabs never flashes the wrong tree.
  const expandedIds = expansion.scope === scope ? expansion.ids : loadExpanded(scope);
  const isExpanded = (id: number) => expandedIds === null || expandedIds.has(id);

  const activeDoc = activeSlug ? docs.find((d) => d.slug === activeSlug) : undefined;
  const activeFolderId = activeDoc?.folder_id ?? null;

  /**
   * Expand a folder and everything above it (no-op when already open, so the
   * effects driving it can't loop).
   *
   * Computes and persists synchronously instead of going through a
   * `setExpansion` updater: the panel swaps this tree for a spinner while it
   * refetches after a folder is created (`renderTree` returns `loadingBlock` on
   * `docsLoading`), and that unmount lands in the same commit as the reveal. A
   * queued updater is never even invoked once the component is gone, so both the
   * state and the save effect would be lost and the new subfolder would come
   * back hidden. Writing here means the remounted tree reads the revealed set
   * back out of storage.
   */
  const revealChain = useCallback(
    (folderId: number) => {
      const prev = expansionRef.current;
      // Pending migration already renders fully expanded — leave it to migrate.
      // The `migrated` dependency below re-runs this once the set materialises.
      if (prev.ids === null || prev.scope !== scope) return;
      const next = new Set(prev.ids);
      let changed = false;
      for (const id of ancestorIds(folders, folderId))
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      if (!changed) return;
      saveExpanded(scope, next);
      // Keep the ref ahead of the commit so two reveals in one commit compose.
      expansionRef.current = { scope, ids: next };
      setExpansion({ scope, ids: next });
    },
    [folders, scope],
  );

  // Opening a doc reveals it. `migrated` is a dependency because a reveal that
  // arrives while the legacy set is still resolving is deliberately dropped by
  // revealChain — without re-running here, deep-linking into a folder the user
  // had collapsed pre-flip would leave that doc hidden for good.
  const migrated = expansion.ids !== null;
  useEffect(() => {
    if (activeFolderId == null) return;
    revealChain(activeFolderId);
  }, [activeFolderId, revealChain, migrated]);

  // Same treatment for a just-created subfolder, consumed once so a later
  // collapse of that parent isn't undone.
  useEffect(() => {
    if (revealFolderId == null) return;
    revealChain(revealFolderId);
    onRevealed();
  }, [revealFolderId, revealChain, onRevealed]);

  const toggle = (id: number) => {
    // A pending migration renders fully expanded, so the first click has to
    // collapse: materialise the legacy set first, which also completes the
    // migration (its ids are folded in below, the key has nothing left to say).
    if (expandedIds === null) dropLegacyKey(scope);
    const next = new Set(
      expandedIds ??
        migrateLegacyExpanded(
          scope,
          folders.map((f) => f.id),
        ),
    );
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpansion({ scope, ids: next });
  };

  /** Open a collapsed folder the pointer lingers on, so deep drops are reachable. */
  const scheduleHoverExpand = useCallback(
    (folderId: number) => {
      if (expansionRef.current.ids?.has(folderId)) return;
      if (hoverExpandRef.current?.id === folderId) return;
      if (hoverExpandRef.current) window.clearTimeout(hoverExpandRef.current.timer);
      const timer = window.setTimeout(() => {
        hoverExpandRef.current = null;
        setExpansion((prev) => {
          if (prev.scope !== scope || prev.ids === null) return prev;
          const next = new Set(prev.ids);
          next.add(folderId);
          return { scope, ids: next };
        });
      }, HOVER_EXPAND_MS);
      hoverExpandRef.current = { id: folderId, timer };
    },
    [scope],
  );

  const drag = useTreeDrag({
    canDropInto: (dragged, folderId) =>
      dragged.kind !== 'folder' || folderId == null || !subtreeIds(folders, dragged.id).has(folderId),

    /** Dropping something back where it already lives is a no-op, not a write. */
    onDropInto: (dragged, folderId) => {
      if (dragged.kind === 'doc') {
        const current = docs.find((d) => d.id === dragged.id)?.folder_id ?? null;
        if (current !== folderId) onMoveDoc(dragged.id, folderId);
        return;
      }
      const current = folders.find((f) => f.id === dragged.id)?.parent_id ?? null;
      if (current !== folderId) onMoveFolder(dragged.id, folderId);
    },

    /**
     * Commit a drop-between: renumber that parent's group with the dragged node
     * at that index. A drop landing in the other group is normalized rather than
     * refused — folders always render above documents, so "a doc between two
     * folders" can only mean the top of the documents.
     */
    onDropEdge: (dragged, edge) => {
      if (dragged.kind === 'folder' && edge.parentId != null && subtreeIds(folders, dragged.id).has(edge.parentId)) {
        return;
      }
      const siblings =
        dragged.kind === 'folder'
          ? folders.filter((f) => (f.parent_id ?? null) === edge.parentId).sort(byFolderOrder)
          : docs.filter((d) => (d.folder_id ?? null) === edge.parentId).sort(byDocOrder);
      const currentParent =
        dragged.kind === 'folder'
          ? (folders.find((f) => f.id === dragged.id)?.parent_id ?? null)
          : (docs.find((d) => d.id === dragged.id)?.folder_id ?? null);

      const index = edge.group === dragged.kind ? edge.index : dragged.kind === 'folder' ? siblings.length : 0;
      const currentIds = siblings.map((sibling) => sibling.id);
      const nextIds = computeOrder(currentIds, dragged.id, index);

      const moved = currentParent !== edge.parentId;
      if (!moved && isSameOrder(currentIds, nextIds)) return; // nothing changed
      if (moved) {
        if (dragged.kind === 'doc') onMoveDoc(dragged.id, edge.parentId);
        else onMoveFolder(dragged.id, edge.parentId);
      }
      onReorder(dragged.kind, edge.parentId, nextIds);
    },

    onHoverFolder: scheduleHoverExpand,
    onDragEnd: () => {
      if (hoverExpandRef.current) {
        window.clearTimeout(hoverExpandRef.current.timer);
        hoverExpandRef.current = null;
      }
    },
  });

  const dragging = drag.dragging;
  const dropEdge = drag.drop?.type === 'edge' ? drag.drop.edge : null;
  const dropFolderId = drag.drop?.type === 'into' ? drag.drop.folderId : undefined;

  const DropLine = ({ depth }: { depth: number }) => (
    <div className="h-0 -my-px" style={{ paddingLeft: depth * 12 }} aria-hidden>
      <div className="border-t-2 border-primary-500 rounded-full" />
    </div>
  );

  const renderDoc = (doc: KnowledgeDoc, depth: number, edge: DropEdge) => {
    const active = activeDoc?.id === doc.id;
    return (
      <div
        key={`doc-${doc.id}`}
        className="flex items-center group/row"
        style={{ paddingLeft: 16 + depth * 12 }}
        {...drag.rowProps({ kind: 'doc', id: doc.id, parentId: edge.parentId, index: edge.index })}
      >
        <button
          onClick={() => {
            // The click that ends a drag must not also open the document.
            if (drag.didDrag()) return;
            onOpenDoc(doc);
          }}
          onContextMenu={(e) => onDocMenu(e, doc)}
          className={`flex-1 min-w-0 cursor-grab text-left pl-2 pr-1 py-1.5 rounded-md text-xs transition-colors flex items-center gap-2 active:cursor-grabbing ${
            active
              ? 'bg-primary-subtle text-primary-fg-strong font-medium'
              : 'text-fg-secondary hover:text-fg hover:bg-surface-sunken'
          }`}
        >
          <FileText size={13} className={`flex-shrink-0 ${active ? 'text-primary-fg' : 'text-fg-faint'}`} />
          <span className="truncate flex-1" title={doc.title}>
            {doc.title}
          </span>
        </button>
        <RowMenuButton label={t('common.more')} onOpen={(e) => onDocMenu(e, doc)} />
      </div>
    );
  };

  const renderLevel = (parentId: number | null, depth: number): React.ReactNode => {
    if (depth > 8) return null;
    const childFolders = folders.filter((f) => (f.parent_id ?? null) === parentId).sort(byFolderOrder);
    const childDocs = docs.filter((d) => (d.folder_id ?? null) === parentId).sort(byDocOrder);
    const line = (group: 'doc' | 'folder', index: number, lineDepth: number) =>
      sameEdge(dropEdge, { parentId, group, index }) ? <DropLine depth={lineDepth} /> : null;
    return (
      <>
        {childFolders.map((f, i) => {
          const hasChildren =
            folders.some((c) => (c.parent_id ?? null) === f.id) || docs.some((d) => d.folder_id === f.id);
          const open = isExpanded(f.id);
          const isDropTarget = dropFolderId === f.id;
          // Dimmed while dragging a folder over its own subtree: an impossible target.
          const isBlocked = dragging?.kind === 'folder' && subtreeIds(folders, dragging.id).has(f.id);
          return (
            <React.Fragment key={`folder-${f.id}`}>
              {line('folder', i, depth)}
              <div
                className={`flex cursor-grab items-center group/row rounded-md active:cursor-grabbing ${
                  isDropTarget ? 'ring-1 ring-primary-500 bg-primary-subtle/40' : ''
                } ${isBlocked ? 'opacity-40' : ''}`}
                style={{ paddingLeft: depth * 12 }}
                onContextMenu={(e) => onFolderMenu(e, f)}
                {...drag.rowProps({ kind: 'folder', id: f.id, parentId, index: i }, { into: f.id })}
              >
                {hasChildren ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (drag.didDrag()) return;
                      toggle(f.id);
                    }}
                    title={open ? t('common.collapse') : t('common.expand')}
                    className="flex-shrink-0 text-fg-faint hover:text-fg rounded p-0.5"
                  >
                    <ChevronDown
                      size={12}
                      className={`transition-transform duration-200 ${open ? '' : '-rotate-90'}`}
                    />
                  </button>
                ) : (
                  <span className="w-4 flex-shrink-0" />
                )}
                <button
                  onClick={() => {
                    if (drag.didDrag()) return;
                    toggle(f.id);
                  }}
                  className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-fg-secondary hover:text-fg hover:bg-surface-sunken transition-colors"
                >
                  {open ? (
                    <FolderOpen size={14} className="text-fg-faint flex-shrink-0" />
                  ) : (
                    <Folder size={14} className="text-fg-faint flex-shrink-0" />
                  )}
                  <span className="flex-1 text-left truncate" title={f.name}>
                    {f.name}
                  </span>
                  <span className="text-[10px] text-fg-faint flex-shrink-0 group-hover/row:invisible">
                    {docs.filter((d) => d.folder_id === f.id).length || ''}
                  </span>
                </button>
                <RowMenuButton label={t('common.more')} onOpen={(e) => onFolderMenu(e, f)} />
              </div>
              {hasChildren && open && renderLevel(f.id, depth + 1)}
            </React.Fragment>
          );
        })}
        {line('folder', childFolders.length, depth)}
        {childDocs.map((d, i) => (
          <React.Fragment key={`doc-row-${d.id}`}>
            {line('doc', i, depth)}
            {renderDoc(d, depth, { parentId, group: 'doc', index: i })}
          </React.Fragment>
        ))}
        {line('doc', childDocs.length, depth)}
      </>
    );
  };

  return (
    <div className="space-y-0.5 pt-1">
      {/*
        No "drop here for the root" bar: inserting one the moment a drag starts
        shifts the whole tree down by its height, and the row the user was aiming
        at slides out from under the pointer. It was redundant anyway — dropping
        on the edge of any root-level row already means "root, at this position",
        and the ⋯ menu's "Move to…" has an explicit root entry.
      */}
      {renderLevel(null, 0)}
    </div>
  );
}

/** Hover-revealed `⋯` that opens the same menu as right-click. */
function RowMenuButton({ label, onOpen }: { label: string; onOpen: (e: React.MouseEvent) => void }) {
  return (
    <button
      type="button"
      title={label}
      onClick={onOpen}
      {...{ [NO_DRAG_ATTR]: '' }}
      className="flex-shrink-0 p-1 mr-0.5 rounded text-fg-faint opacity-0 group-hover/row:opacity-100 focus:opacity-100 hover:text-fg hover:bg-surface-muted transition-opacity"
    >
      <MoreHorizontal size={13} />
    </button>
  );
}
