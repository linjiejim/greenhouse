/**
 * Knowledge nav panel — sidebar contextual panel for the Knowledge tab.
 * Three collapsible sections: Internal (by space), Personal (doc list), Shared with me.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { FolderOpen, Lock, ChevronDown, Plus, Share2 } from '../../../lib/icons';
import type { LucideIcon } from '../../../lib/icons';
import { Spinner } from '../../../components/ui';
import { useKnowledgeStore } from '../../../stores';
import { useT } from '../../../lib/i18n';
import { listKnowledgeDocs } from '../../../lib/api/knowledge';
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

  // Spaces derived from internal docs
  const spaces = useMemo(() => {
    const map = new Map<string, number>();
    for (const doc of internalDocs) {
      const space = doc.space || 'general';
      map.set(space, (map.get(space) || 0) + 1);
    }
    return Array.from(map.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [internalDocs]);

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
          <div className="space-y-0.5 pl-2">
            {docsLoading ? (
              <div className="flex justify-center py-2">
                <Spinner className="h-4 w-4" />
              </div>
            ) : spaces.length === 0 ? (
              <div className="px-3 py-1.5 text-[11px] text-fg-faint">{t('knowledge.noDocs')}</div>
            ) : (
              spaces.map((sp) => (
                <NavItem
                  key={sp.name}
                  icon={FolderOpen}
                  label={sp.name}
                  badge={sp.count}
                  active={isActive(`#/knowledge/internal/${sp.name}`)}
                  onClick={() => navigate(`#/knowledge/internal/${sp.name}`)}
                />
              ))
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

function NavItem({
  icon: Icon,
  label,
  badge,
  active,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  badge?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 rounded-md text-xs transition-colors ${
        active
          ? 'bg-primary-subtle text-primary-fg-strong font-medium'
          : 'text-fg-secondary hover:text-fg hover:bg-surface-sunken'
      }`}
    >
      <Icon size={14} className={active ? 'text-primary-fg' : 'text-fg-faint'} />
      <span className="flex-1 text-left truncate">{label}</span>
      {badge !== undefined && <span className="text-[10px] text-fg-faint flex-shrink-0">{badge}</span>}
    </button>
  );
}
