/**
 * Knowledge nav panel — sidebar contextual panel for the Knowledge tab.
 * Three collapsible sections: Internal (by space), Personal (doc list), Shared with me.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { FolderOpen, Folder, Lock, ChevronDown, ChevronRight, Plus, Share2, Edit3, Check, X } from '../../../lib/icons';
import type { LucideIcon } from '../../../lib/icons';
import { Spinner, toast } from '../../../components/ui';
import { useKnowledgeStore } from '../../../stores';
import { useT } from '../../../lib/i18n';
import { listKnowledgeDocs, renameKnowledgeSpace } from '../../../lib/api/knowledge';
import { buildSpaceTree, normalizeSpacePath, isSpaceInSubtree, type SpaceNode } from '../../../lib/knowledge-spaces';
import type { KnowledgeDoc } from '@greenhouse/types/api';

const COLLAPSED_KEYS = {
  internal: 'kb-internal-collapsed',
  personal: 'kb-personal-collapsed',
  shared: 'kb-shared-collapsed',
} as const;

function getInitialCollapsed(key: string, activeSection: string, sectionKey: string): boolean {
  if (activeSection === sectionKey) return false;
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

interface KnowledgeNavPanelProps {
  activeModule: string;
  collapsed?: boolean;
}

type Section = 'internal' | 'personal' | 'shared';

function resolveSection(subPath: string): Section {
  if (subPath.startsWith('shared')) return 'shared';
  if (subPath.startsWith('personal')) return 'personal';
  return 'internal';
}

export function KnowledgeNavPanel({ activeModule, collapsed }: KnowledgeNavPanelProps) {
  const t = useT();
  const activeSection = resolveSection(activeModule);
  const docsVersion = useKnowledgeStore((s) => s.version);
  const bump = useKnowledgeStore((s) => s.bump);

  // Internal docs state (team visibility)
  const [internalDocs, setInternalDocs] = useState<KnowledgeDoc[]>([]);
  const [personalDocs, setPersonalDocs] = useState<KnowledgeDoc[]>([]);
  const [sharedDocs, setSharedDocs] = useState<KnowledgeDoc[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);

  // Collapse states
  const [internalCollapsed, setInternalCollapsed] = useState(() =>
    getInitialCollapsed(COLLAPSED_KEYS.internal, activeSection, 'internal'),
  );
  const [personalCollapsed, setPersonalCollapsed] = useState(() =>
    getInitialCollapsed(COLLAPSED_KEYS.personal, activeSection, 'personal'),
  );
  const [sharedCollapsed, setSharedCollapsed] = useState(() =>
    getInitialCollapsed(COLLAPSED_KEYS.shared, activeSection, 'shared'),
  );

  // Load docs for internal/personal sections
  useEffect(() => {
    let cancelled = false;
    setDocsLoading(true);
    listKnowledgeDocs({ status: 'published' })
      .then((docs) => {
        if (cancelled) return;
        setInternalDocs(docs.filter((d) => d.visibility === 'team'));
        // Own private docs vs docs shared with me — split by effective access role.
        setPersonalDocs(docs.filter((d) => d.visibility === 'private' && d.access === 'owner'));
        setSharedDocs(docs.filter((d) => d.visibility === 'private' && d.access !== 'owner'));
        setDocsLoading(false);
      })
      .catch(() => {
        if (!cancelled) setDocsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [docsVersion]);

  // Spaces derived from internal docs — a nested tree keyed by the `/`-delimited path.
  const spaceTree = useMemo(() => buildSpaceTree(internalDocs), [internalDocs]);

  // Tree UI state: which space subtrees are collapsed, and inline-rename buffer.
  const [collapsedSpaces, setCollapsedSpaces] = useState<Set<string>>(() => new Set());
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);

  const setCollapsed = useCallback((section: Section, value: boolean) => {
    const setters = {
      internal: setInternalCollapsed,
      personal: setPersonalCollapsed,
      shared: setSharedCollapsed,
    };
    setters[section](value);
    try {
      localStorage.setItem(COLLAPSED_KEYS[section], String(value));
    } catch {
      /* ignore */
    }
  }, []);

  const toggleCollapse = useCallback(
    (section: Section) => {
      const current = {
        internal: internalCollapsed,
        personal: personalCollapsed,
        shared: sharedCollapsed,
      }[section];
      setCollapsed(section, !current);
    },
    [internalCollapsed, personalCollapsed, sharedCollapsed, setCollapsed],
  );

  const toggleSpaceCollapsed = useCallback((path: string) => {
    setCollapsedSpaces((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const startRename = useCallback((path: string) => {
    setRenamingPath(path);
    setRenameValue(path);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingPath(null);
    setRenameValue('');
  }, []);

  const submitRename = useCallback(async () => {
    if (renamingPath === null) return;
    const from = renamingPath;
    const to = normalizeSpacePath(renameValue);
    if (!renameValue.trim() || to === from) {
      cancelRename();
      return;
    }
    setRenameSaving(true);
    try {
      const count = await renameKnowledgeSpace(from, to);
      toast(t('knowledge.spaceRenamed', { count }), 'success');
      // If the current view is inside the renamed subtree, follow the move so the
      // main pane doesn't get stranded on a now-empty old-space listing.
      const prefix = '#/knowledge/internal/';
      if (window.location.hash.startsWith(prefix)) {
        const rest = window.location.hash.slice(prefix.length);
        const slash = rest.indexOf('/');
        const token = slash === -1 ? rest : rest.slice(0, slash);
        const tail = slash === -1 ? '' : rest.slice(slash);
        let decoded = token;
        try {
          decoded = decodeURIComponent(token);
        } catch {
          /* malformed — compare the raw token */
        }
        const cur = normalizeSpacePath(decoded);
        if (isSpaceInSubtree(cur, from)) {
          const moved = cur === from ? to : to + cur.slice(from.length);
          window.location.hash = prefix + encodeURIComponent(moved) + tail;
        }
      }
      cancelRename();
      bump();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('knowledge.renameSpaceFailed'), 'error');
    } finally {
      setRenameSaving(false);
    }
  }, [renamingPath, renameValue, cancelRename, bump, t]);

  if (collapsed) return null;

  const navigate = (path: string) => {
    window.location.hash = path.replace(/^#/, '');
  };

  // Section title click — navigate to the scope landing page and ensure it's expanded.
  const openSection = (section: Section, path: string) => {
    navigate(path);
    setCollapsed(section, false);
  };

  const isActive = (path: string) => {
    const current = window.location.hash.replace(/^#\/?/, '');
    const target = path.replace(/^#\/?/, '');
    return current === target || current.startsWith(target + '/');
  };

  // Recursive tree row. A plain render fn (not a component) so the inline-rename
  // <input> keeps focus across parent re-renders. Indentation scales with depth;
  // the badge shows the whole-subtree doc count.
  const renderSpaceNode = (node: SpaceNode, depth: number): React.ReactNode => {
    const hasChildren = node.children.length > 0;
    const isNodeCollapsed = collapsedSpaces.has(node.path);
    const routePath = `#/knowledge/internal/${encodeURIComponent(node.path)}`;
    const active = isActive(routePath);
    const renaming = renamingPath === node.path;
    const indent = { paddingLeft: `${depth * 14 + 8}px` };

    return (
      <div key={node.path}>
        {renaming ? (
          <div className="flex items-center gap-1 py-0.5 pr-1" style={indent}>
            <input
              autoFocus
              value={renameValue}
              disabled={renameSaving}
              onChange={(e) => setRenameValue(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              className="flex-1 min-w-0 bg-surface-sunken border border-primary rounded px-2 py-1 text-xs text-fg focus:outline-none"
            />
            {/* onMouseDown preventDefault keeps the input from blurring before the click fires. */}
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void submitRename()}
              disabled={renameSaving}
              title={t('common.save')}
              className="flex-shrink-0 text-fg-faint hover:text-primary-fg rounded p-0.5 disabled:opacity-50"
            >
              <Check size={13} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={cancelRename}
              disabled={renameSaving}
              title={t('common.cancel')}
              className="flex-shrink-0 text-fg-faint hover:text-fg rounded p-0.5 disabled:opacity-50"
            >
              <X size={13} />
            </button>
          </div>
        ) : (
          <div
            className={`group w-full flex items-center gap-1.5 pr-2 py-1.5 rounded-md text-xs transition-colors ${
              active
                ? 'bg-primary-subtle text-primary-fg-strong font-medium'
                : 'text-fg-secondary hover:text-fg hover:bg-surface-sunken'
            }`}
            style={indent}
          >
            {hasChildren ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSpaceCollapsed(node.path);
                }}
                title={isNodeCollapsed ? t('common.expand') : t('common.collapse')}
                className="flex-shrink-0 text-fg-faint hover:text-fg rounded"
              >
                <ChevronRight
                  size={12}
                  className={`transition-transform duration-200 ${isNodeCollapsed ? '' : 'rotate-90'}`}
                />
              </button>
            ) : (
              <span className="w-3 flex-shrink-0" />
            )}
            <button
              type="button"
              onClick={() => navigate(routePath)}
              className="flex items-center gap-2 flex-1 min-w-0 text-left"
            >
              {hasChildren ? (
                <Folder size={14} className={active ? 'text-primary-fg' : 'text-fg-faint'} />
              ) : (
                <FolderOpen size={14} className={active ? 'text-primary-fg' : 'text-fg-faint'} />
              )}
              <span className="flex-1 truncate">{node.name}</span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                startRename(node.path);
              }}
              title={t('knowledge.renameSpace')}
              className="opacity-0 group-hover:opacity-100 touch-visible flex-shrink-0 text-fg-faint hover:text-fg rounded p-0.5 transition-opacity"
            >
              <Edit3 size={12} />
            </button>
            <span className="text-[10px] text-fg-faint flex-shrink-0">{node.total}</span>
          </div>
        )}
        {hasChildren && !isNodeCollapsed && node.children.map((child) => renderSpaceNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <nav className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {/* ── Internal Knowledge Base ── */}
        <SectionHeader
          icon={FolderOpen}
          label={t('knowledge.internalKb')}
          count={internalDocs.length}
          active={activeSection === 'internal'}
          collapsed={internalCollapsed}
          onNavigate={() => openSection('internal', '#/knowledge/internal')}
          onToggle={() => toggleCollapse('internal')}
          onAdd={() => navigate('#/knowledge/new')}
          className="mt-1"
        />

        {!internalCollapsed && (
          <div className="space-y-0.5">
            {docsLoading ? (
              <div className="flex justify-center py-2">
                <Spinner className="h-4 w-4" />
              </div>
            ) : spaceTree.length === 0 ? (
              <div className="px-3 py-1.5 text-[11px] text-fg-faint">{t('knowledge.noDocs')}</div>
            ) : (
              spaceTree.map((node) => renderSpaceNode(node, 0))
            )}
          </div>
        )}

        {/* Separator */}
        <div className="mx-1 my-1.5 border-t border-edge" />

        {/* ── Personal Knowledge Base ── */}
        <SectionHeader
          icon={Lock}
          label={t('knowledge.personalKb')}
          count={personalDocs.length}
          active={activeSection === 'personal'}
          collapsed={personalCollapsed}
          onNavigate={() => openSection('personal', '#/knowledge/personal')}
          onToggle={() => toggleCollapse('personal')}
          onAdd={() => navigate('#/knowledge/new/personal')}
        />

        {!personalCollapsed && (
          <div className="space-y-0.5 pl-2">
            {docsLoading ? (
              <div className="flex justify-center py-2">
                <Spinner className="h-4 w-4" />
              </div>
            ) : personalDocs.length === 0 ? (
              <div className="px-3 py-1.5 text-[11px] text-fg-faint">{t('knowledge.noPersonalDocs')}</div>
            ) : (
              personalDocs.map((doc) => (
                <button
                  key={doc.id}
                  onClick={() => navigate(`#/knowledge/personal/${encodeURIComponent(doc.slug)}`)}
                  className={`w-full text-left px-3 py-1.5 rounded-md text-xs transition-colors flex items-center gap-2 ${
                    isActive(`#/knowledge/personal/${encodeURIComponent(doc.slug)}`)
                      ? 'bg-primary-subtle text-primary-fg-strong font-medium'
                      : 'text-fg-secondary hover:text-fg hover:bg-surface-sunken'
                  }`}
                >
                  <span className="truncate flex-1" title={doc.title}>
                    {doc.title}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {/* Separator */}
        <div className="mx-1 my-1.5 border-t border-edge" />

        {/* ── Shared with me ── */}
        <SectionHeader
          icon={Share2}
          label={t('knowledge.sharedWithMe')}
          count={sharedDocs.length}
          active={activeSection === 'shared'}
          collapsed={sharedCollapsed}
          onNavigate={() => openSection('shared', '#/knowledge/shared')}
          onToggle={() => toggleCollapse('shared')}
        />

        {!sharedCollapsed && (
          <div className="space-y-0.5 pl-2">
            {docsLoading ? (
              <div className="flex justify-center py-2">
                <Spinner className="h-4 w-4" />
              </div>
            ) : sharedDocs.length === 0 ? (
              <div className="px-3 py-1.5 text-[11px] text-fg-faint">{t('knowledge.noSharedDocs')}</div>
            ) : (
              sharedDocs.map((doc) => (
                <button
                  key={doc.id}
                  onClick={() => navigate(`#/knowledge/shared/${encodeURIComponent(doc.slug)}`)}
                  className={`w-full text-left px-3 py-1.5 rounded-md text-xs transition-colors flex items-center gap-2 ${
                    isActive(`#/knowledge/shared/${encodeURIComponent(doc.slug)}`)
                      ? 'bg-primary-subtle text-primary-fg-strong font-medium'
                      : 'text-fg-secondary hover:text-fg hover:bg-surface-sunken'
                  }`}
                >
                  <span className="truncate flex-1" title={doc.title}>
                    {doc.title}
                  </span>
                  {doc.access === 'editor' && (
                    <span className="text-[9px] text-fg-faint flex-shrink-0">{t('knowledge.editable')}</span>
                  )}
                </button>
              ))
            )}
          </div>
        )}
      </nav>
    </div>
  );
}

function SectionHeader({
  icon: Icon,
  label,
  count,
  active,
  collapsed,
  onNavigate,
  onToggle,
  onAdd,
  className = '',
}: {
  icon: LucideIcon;
  label: string;
  count?: number;
  active: boolean;
  collapsed: boolean;
  onNavigate: () => void;
  onToggle: () => void;
  onAdd?: () => void;
  className?: string;
}) {
  const t = useT();
  return (
    <div
      className={`group w-full flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-md text-xs transition-colors ${
        active
          ? 'bg-primary-subtle text-primary-fg-strong font-medium'
          : 'text-fg-secondary hover:text-fg hover:bg-surface-sunken'
      } ${className}`}
    >
      <button type="button" onClick={onNavigate} className="flex items-center gap-2.5 flex-1 min-w-0 text-left">
        <Icon size={14} className={active ? 'text-primary-fg' : 'text-fg-faint'} />
        <span className="flex-1 truncate font-medium">{label}</span>
      </button>
      {onAdd && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          title={t('knowledge.newDoc')}
          className="opacity-0 group-hover:opacity-100 touch-visible flex-shrink-0 text-fg-faint hover:text-fg rounded p-0.5 transition-opacity"
        >
          <Plus size={13} />
        </button>
      )}
      {count !== undefined && <span className="text-[10px] text-fg-faint flex-shrink-0">{count}</span>}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        title={collapsed ? t('common.expand') : t('common.collapse')}
        className="flex-shrink-0 text-fg-faint hover:text-fg rounded p-0.5"
      >
        <ChevronDown size={12} className={`transition-transform duration-200 ${collapsed ? '-rotate-90' : ''}`} />
      </button>
    </div>
  );
}
