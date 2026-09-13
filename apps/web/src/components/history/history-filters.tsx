/**
 * History filter bar — follows the repo's list filter-bar convention:
 * a primary row that always fits, with the low-frequency filters folded away.
 *
 * The two axes that decide *which* conversations exist for you — status and
 * ownership — stay in the primary row. Everything behind "More" is a refinement
 * within that set, and is grouped by what it refines: how the conversation is
 * filed (Organize) vs what someone thought of it (Review). A flat run of four
 * Selects and a star widget gave no clue which was which.
 */

import React from 'react';
import { FilterPills, SearchInput, Select, StarRating } from '../ui';
import { Filter, RotateCcw, Tag } from '../../lib/icons';
import { TagFilter } from '../session-tags';
import type { SessionGroup, SessionTag } from '@greenhouse/types/api';
import type { Profile } from '../../lib/api';
import {
  DEFAULT_HISTORY_FILTERS,
  countHiddenFilters,
  type FeedbackFilter,
  type HistoryFilters,
  type OwnerFilter,
} from './filter-model';
import { useT } from '../../lib/i18n';
import { useAuthStore } from '../../stores';

/**
 * Status is `<FilterPills wrap>`, not a tab strip: four segmented tabs measure
 * 357px against 338px of usable width at 390dpr, so the last one gets clipped
 * behind a sideways scroll. Status is the one filter that must always be
 * readable, so it wraps instead.
 */
interface HistoryFiltersBarProps {
  filters: HistoryFilters;
  onChange: (patch: Partial<HistoryFilters>) => void;
  statusCounts: Record<string, number>;
  feedbackCounts: Record<string, number>;
  profiles: Profile[];
  groups: SessionGroup[];
  tags: SessionTag[];
  onManageTags: () => void;
  searchPlaceholder: string;
}

export function HistoryFiltersBar({
  filters,
  onChange,
  statusCounts,
  feedbackCounts,
  profiles,
  groups,
  tags,
  onManageTags,
  searchPlaceholder,
}: HistoryFiltersBarProps) {
  const t = useT();
  const [showMore, setShowMore] = React.useState(false);
  const hidden = countHiddenFilters(filters);
  const isSuper = useAuthStore((s) => s.currentUser?.role) === 'super';
  const statusPills = [
    { key: 'active', label: t('common.active') },
    { key: 'archived', label: t('common.archived') },
    { key: 'deleted', label: t('common.deleted') },
    { key: 'eval', label: t('history.eval') },
  ];
  const feedbackPills: Array<{ key: Exclude<FeedbackFilter, 'all'>; label: string }> = [
    { key: 'good', label: t('history.good') },
    { key: 'bad', label: t('history.bad') },
    { key: 'starred', label: t('history.starred') },
  ];

  /** Reset everything behind "More"; status and search are the user's place, not a filter. */
  const resetRefinements = () =>
    onChange({
      feedback: DEFAULT_HISTORY_FILTERS.feedback,
      owner: DEFAULT_HISTORY_FILTERS.owner,
      group: DEFAULT_HISTORY_FILTERS.group,
      profile: DEFAULT_HISTORY_FILTERS.profile,
      rating: DEFAULT_HISTORY_FILTERS.rating,
      tagId: DEFAULT_HISTORY_FILTERS.tagId,
    });

  return (
    <div className="flex-shrink-0 space-y-2 border-b border-edge bg-surface-sunken/50 px-4 py-2.5 md:px-6">
      {/* Row 1: the two axes that decide which conversations exist, plus search */}
      <div className="flex items-center gap-2 flex-wrap">
        <FilterPills
          wrap
          variant="segment"
          items={statusPills.map((pill) => ({ ...pill, count: statusCounts[pill.key] || 0 }))}
          activeKey={filters.status}
          onChange={(status) => status && onChange({ status })}
          className="flex-shrink-0"
        />
        {/* Ownership is promoted out of "More": it is the difference between
            "my conversations" and "the whole team's", not a refinement. */}
        <Select
          size="sm"
          inline
          value={filters.owner}
          aria-label={t('history.ownership')}
          onChange={(e) => onChange({ owner: e.target.value as OwnerFilter })}
        >
          {/* Ordered by widening scope, so the list reads as a dial. */}
          <option value="mine">{t('history.ownedByMe')}</option>
          <option value="shared">{t('history.sharedWithMe')}</option>
          {/* Only a super's list contains other people's conversations, so for
              everyone else this bucket is always empty. `all` stays for all
              roles — for a team user it still means "mine + shared". */}
          {isSuper && <option value="team">{t('history.othersConversations')}</option>}
          <option value="all">{t('history.allConversations')}</option>
        </Select>
        <SearchInput
          value={filters.search}
          onChange={(search) => onChange({ search })}
          placeholder={searchPlaceholder}
          className="flex-1 min-w-[120px] sm:flex-none sm:w-[200px]"
        />
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          className="inline-flex items-center gap-1 text-xs text-primary-fg hover:text-primary-fg-strong transition-colors"
          aria-expanded={showMore}
        >
          <Filter size={12} />
          {showMore ? t('history.less') : t('history.more')}
          {/* Without this count, a filter left on inside the collapsed row silently shrinks the list. */}
          {!showMore && hidden > 0 && (
            <span className="rounded-full bg-primary-subtle px-1.5 text-[10px] text-primary-fg-strong">{hidden}</span>
          )}
        </button>
      </div>

      {/* Row 2: refinements, grouped by what they refine */}
      {showMore && (
        <div className="space-y-2 border-t border-edge pt-2">
          <FilterSection label={t('history.sectionOrganize')}>
            <Select
              size="sm"
              inline
              value={filters.group}
              aria-label={t('history.group')}
              onChange={(e) => onChange({ group: e.target.value })}
            >
              <option value="all">{t('history.allGroups')}</option>
              <option value="pinned">📌 {t('history.pinned')}</option>
              <option value="ungrouped">{t('history.ungrouped')}</option>
              {groups
                .filter((g) => g.kind !== 'pinned')
                .map((g) => (
                  <option key={g.id} value={`g:${g.id}`}>
                    {g.name}
                  </option>
                ))}
            </Select>

            {profiles.length > 1 && (
              <Select
                size="sm"
                inline
                value={filters.profile}
                aria-label={t('history.profile')}
                onChange={(e) => onChange({ profile: e.target.value })}
              >
                <option value="all">{t('history.allProfiles')}</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}

            {tags.length > 0 && (
              <span className="flex min-w-0 items-center gap-1.5">
                <TagFilter tags={tags} activeTagId={filters.tagId} onSelect={(tagId) => onChange({ tagId })} />
                <button
                  type="button"
                  onClick={onManageTags}
                  className="flex-shrink-0 rounded p-1 text-fg-faint transition-colors hover:text-fg-secondary"
                  title={t('sessionTags.manage')}
                >
                  <Tag size={12} />
                </button>
              </span>
            )}
          </FilterSection>

          <FilterSection label={t('history.sectionReview')}>
            <FilterPills
              wrap
              toggle
              allLabel={t('common.all')}
              items={feedbackPills.map((item) => ({ ...item, count: feedbackCounts[item.key] || undefined }))}
              activeKey={filters.feedback === 'all' ? null : filters.feedback}
              onChange={(key) => onChange({ feedback: (key as FeedbackFilter | null) ?? 'all' })}
            />
            <span className="flex items-center gap-1.5">
              <span className="flex-shrink-0 text-[11px] text-fg-faint">{t('history.rating')}:</span>
              {/* Re-clicking the active star clears it — otherwise the only way
                  out of a rating filter is the reset button. */}
              <StarRating
                value={filters.rating ?? 0}
                onChange={(rating) => onChange({ rating: rating === filters.rating ? null : rating })}
              />
            </span>
            {hidden > 0 && (
              <button
                type="button"
                onClick={resetRefinements}
                className="inline-flex items-center gap-1 text-[11px] text-fg-faint transition-colors hover:text-fg-secondary"
              >
                <RotateCcw size={11} />
                {t('history.resetFilters')}
              </button>
            )}
          </FilterSection>
        </div>
      )}
    </div>
  );
}

/** One labelled band of refinements — the caption is what makes the grouping readable. */
function FilterSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-16 flex-shrink-0 pt-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2">{children}</div>
    </div>
  );
}
