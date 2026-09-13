/**
 * SkillHubList — grouped, searchable skill list shared by the desktop sidebar
 * rail (SkillHubNavPanel) and the mobile SkillHub page. Selection is URL-driven
 * (`#/skillhub/<name>`), so items are plain hash anchors and `selectedName`
 * (from the route subPath) drives the active highlight.
 *
 * Rows carry a quick-download button and, when the scanner has flagged a skill,
 * a status tag. Supers additionally get a "Needs review" group hoisted to the
 * top — the review queue, derived client-side from the catalog everyone already
 * loads (no extra endpoint).
 */

import React, { useMemo, useState } from 'react';
import { IconButton, SearchInput, Spinner, Tag, Toggle } from '../ui';
import { Download, Package } from '../../lib/icons';
import { useAuthStore } from '../../stores';
import { filterSkills, groupSkills, needsReview } from './grouping';
import { SkillDownloadConfirm, type SkillDownloadTarget } from './skill-download-confirm';
import { useSkills } from './use-skills';
import type { SkillSummary } from '../../lib/api/skills';
import { useT } from '../../lib/i18n';

function ScanTag({ skill }: { skill: SkillSummary }) {
  const t = useT();
  if (skill.scan_status === 'blocked') return <Tag tone="danger">{t('skillHub.scanBlocked')}</Tag>;
  if (skill.scan_status === 'suspicious') return <Tag tone="warning">{t('skillHub.scanSuspicious')}</Tag>;
  return null;
}

function SkillRow({ skill, active, dimmed }: { skill: SkillSummary; active: boolean; dimmed?: boolean }) {
  const t = useT();
  const [downloadTarget, setDownloadTarget] = useState<SkillDownloadTarget | null>(null);
  const flagged = needsReview(skill);

  const download = async (e: React.MouseEvent) => {
    // The row is an anchor — don't navigate when the icon is what was pressed.
    e.preventDefault();
    e.stopPropagation();
    setDownloadTarget({ name: skill.name, displayName: skill.display_name, version: skill.latest_version });
  };

  return (
    <>
      <a
        href={`#/skillhub/${skill.name}`}
        className={`group flex w-full min-w-0 items-center gap-1.5 px-2 py-1 rounded-md overflow-hidden text-xs transition-colors ${
          active
            ? 'bg-primary-subtle text-primary-fg-strong font-medium'
            : 'text-fg-secondary hover:text-fg hover:bg-surface-sunken'
        } ${dimmed ? 'opacity-60' : ''}`}
        title={`${skill.display_name} · ${skill.name}`}
      >
        <Package size={14} className={`flex-shrink-0 ${active ? 'text-primary-fg' : 'text-fg-faint'}`} />
        <span className="min-w-0 flex-1 text-left truncate">{skill.display_name}</span>
        <ScanTag skill={skill} />
        {/* touch-visible: hover is not an input method on touch devices. */}
        <span className="flex-shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 touch-visible">
          <IconButton
            label={flagged ? t('skillHub.downloadPendingReview') : t('skillHub.downloadSkill', { name: skill.name })}
            onClick={(e) => void download(e)}
            size="compact"
          >
            <Download size={12} />
          </IconButton>
        </span>
        <span className="sidebar-secondary-meta text-[10px] text-fg-faint flex-shrink-0">{skill.download_count}</span>
      </a>
      <SkillDownloadConfirm target={downloadTarget} onClose={() => setDownloadTarget(null)} />
    </>
  );
}

function GroupHeader({ label }: { label: string }) {
  return (
    <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium text-fg-muted uppercase tracking-wide">{label}</div>
  );
}

export function SkillHubList({ selectedName }: { selectedName?: string }) {
  const t = useT();
  const { currentUser } = useAuthStore();
  const isSuper = currentUser?.role === 'super';
  const { skills, loading, error } = useSkills();
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  const { activeGroups, archived, archivedTotal } = useMemo(() => {
    const list = skills ?? [];
    const all = filterSkills(list, query);
    const active = all.filter((s) => s.status === 'active');
    return {
      activeGroups: groupSkills(active, currentUser?.id, isSuper),
      archived: all.filter((s) => s.status === 'archived'),
      archivedTotal: list.filter((s) => s.status === 'archived').length,
    };
  }, [skills, query, currentUser?.id, isSuper]);

  const hasAny = activeGroups.length > 0 || (showArchived && archived.length > 0);

  return (
    <div className="flex min-w-0 flex-1 flex-col min-h-0 overflow-hidden">
      <div className="px-2 py-1.5 flex-shrink-0">
        <SearchInput value={query} onChange={setQuery} size="sm" placeholder={t('skillHub.search')} />
      </div>

      <nav className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-1.5 pb-1.5">
        {loading && (
          <div className="p-3">
            <Spinner />
          </div>
        )}
        {error && <div className="px-3 py-2 text-xs text-danger">{error}</div>}
        {!loading && !error && !hasAny && (
          <div className="px-3 py-6 text-xs text-fg-faint text-center">
            {query ? t('skillHub.noSearchResults') : t('skillHub.noPublished')}
          </div>
        )}

        {activeGroups.map((group) => (
          <div key={group.key}>
            <GroupHeader label={t(`skillHub.group.${group.key}`)} />
            <div>
              {group.skills.map((s) => (
                <SkillRow key={s.name} skill={s} active={s.name === selectedName} />
              ))}
            </div>
          </div>
        ))}

        {showArchived && archived.length > 0 && (
          <div>
            <GroupHeader label={t('common.archived')} />
            <div>
              {archived.map((s) => (
                <SkillRow key={s.name} skill={s} active={s.name === selectedName} dimmed />
              ))}
            </div>
          </div>
        )}
      </nav>

      {archivedTotal > 0 && (
        <div className="px-3 py-2 border-t border-edge flex items-center justify-between gap-2 flex-shrink-0">
          <span className="text-[11px] text-fg-muted">{t('skillHub.showArchived')}</span>
          <Toggle checked={showArchived} onChange={setShowArchived} size="sm" />
        </div>
      )}
    </div>
  );
}
