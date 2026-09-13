/**
 * ProfileSelector — Agent profile picker shown above the chat input.
 *
 * - Compact: just profile name + chevron above input
 * - Click opens popover (desktop) or drawer (mobile)
 * - Desktop popover: compact grouped picker + hover tool tooltip
 * - Mobile drawer: grouped list with the same category filters
 * - Read-only mode for existing sessions
 */

import React, { useState, useRef, useEffect } from 'react';
import { Bot, ChevronDown, Check, X } from '../../lib/icons';
import { getToolIcon, getToolBrief } from '../../lib/icons';
import type { Profile } from '../../lib/api';
import { SproutyAvatar } from '../sprouty/index.js';
import { OverlayPanel } from '../app/overlay-panel';
import type { EyeStyle, SproutyVariant, LeafStyle } from '../sprouty/index.js';
import { useLocalized, useT, type TranslationKey } from '../../lib/i18n';
import { DEFAULT_AGENT_ID } from '../../lib/agent-constants';
import { useHoverFlyout } from '../../hooks/use-hover-flyout';

/** Resolves server-authored copy to the active locale — see `useLocalized`. */
type Localize = ReturnType<typeof useLocalized>;

const profileName = (p: Profile, l: Localize) => l(p.name_i18n, p.name);
const profileDescription = (p: Profile, l: Localize) => l(p.description_i18n, p.description ?? '');

type ProfileCategory = 'system' | 'custom';
type ProfileFilter = 'all' | ProfileCategory;

const PROFILE_CATEGORY_LABELS: Record<ProfileCategory, TranslationKey> = {
  system: 'profileSelector.system',
  custom: 'profileSelector.custom',
};

const PROFILE_FILTER_LABELS: Record<ProfileFilter, TranslationKey> = {
  all: 'profileSelector.all',
  system: 'profileSelector.system',
  custom: 'profileSelector.custom',
};

const PROFILE_FILTERS: ProfileFilter[] = ['all', 'system', 'custom'];

function getProfileCategory(p: Profile): ProfileCategory {
  if (p.is_custom) return 'custom';
  return 'system';
}

function getProfilesByCategory(profiles: Profile[]): Record<ProfileCategory, Profile[]> {
  return {
    system: profiles.filter((p) => getProfileCategory(p) === 'system'),
    custom: profiles.filter((p) => getProfileCategory(p) === 'custom'),
  };
}

/** Resolve profile appearance fields to Sprouty props. */
export function profileToSprouty(p: Profile): {
  variant: SproutyVariant;
  color?: string;
  accessories?: string[];
  leafStyle?: LeafStyle;
  eyeStyle?: EyeStyle;
} {
  if (p.is_custom) {
    const avatar = p.avatar;
    return {
      variant: 'custom',
      color: avatar?.color,
      accessories: avatar?.accessories,
      leafStyle: avatar?.leafStyle,
      eyeStyle: avatar?.eyeStyle,
    };
  }
  if (p.id === 'team') return { variant: 'team' };
  return { variant: 'default' };
}

// ─── Shared Profile Row Renderer ─────────────────────────

function getVisibleProfileGroups(
  groupedProfiles: Record<ProfileCategory, Profile[]>,
  filter: ProfileFilter,
): Array<{ category: ProfileCategory; profiles: Profile[] }> {
  const order: ProfileCategory[] = ['system', 'custom'];
  return order
    .filter((category) => filter === 'all' || filter === category)
    .map((category) => ({ category, profiles: groupedProfiles[category] }))
    .filter((group) => group.profiles.length > 0);
}

function getTooltipPosition(rowRect: DOMRect, width = 260, height = 260): React.CSSProperties {
  const margin = 12;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const canAttachLeft = rowRect.left >= width + margin;
  const canAttachRight = viewportWidth - rowRect.right >= width + margin;

  let left = canAttachLeft ? rowRect.left - width : rowRect.right;
  if (!canAttachLeft && !canAttachRight) left = rowRect.left - width;

  const maxTop = Math.max(margin, viewportHeight - height - margin);
  const maxLeft = Math.max(margin, viewportWidth - width - margin);
  const top = Math.min(Math.max(rowRect.top, margin), maxTop);
  left = Math.min(Math.max(left, margin), maxLeft);

  return { top, left, maxHeight: `calc(100dvh - ${margin * 2}px)` };
}

function ToolsPreviewTooltip({ profile, isRowHovered }: { profile: Profile; isRowHovered: boolean }) {
  const t = useT();
  const localized = useLocalized();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const surfaceHoveredRef = useRef(false);
  const [style, setStyle] = useState<React.CSSProperties | null>(null);
  const { open: visible, openNow, closeSoon, cancelClose } = useHoverFlyout();
  const tools = profile.tools;
  const visibleTools = tools.slice(0, 6);
  const hiddenCount = Math.max(0, tools.length - visibleTools.length);

  const showTooltip = () => {
    const rowRect = triggerRef.current?.closest('button')?.getBoundingClientRect();
    if (!rowRect) return;
    const estimatedHeight = Math.min(260, Math.max(78, 42 + (tools.length > 0 ? visibleTools.length * 42 : 32)));
    setStyle(getTooltipPosition(rowRect, 260, estimatedHeight));
    openNow();
  };

  useEffect(() => {
    if (isRowHovered || surfaceHoveredRef.current || !visible) return;
    closeSoon();
    return cancelClose;
  }, [cancelClose, closeSoon, isRowHovered, visible]);

  return (
    <span
      ref={triggerRef}
      onMouseEnter={showTooltip}
      onMouseLeave={() => {
        if (!isRowHovered) closeSoon();
      }}
      aria-label={t('profileSelector.toolsAria', { name: profileName(profile, localized) })}
      className="relative rounded-full px-1.5 py-0.5 text-[10px] text-fg-faint whitespace-nowrap hover:bg-primary-subtle hover:text-primary-fg-strong focus:outline-none focus:ring-1 focus:ring-primary-edge"
    >
      {t('profileSelector.toolCount', { count: tools.length })}
      {visible && style && (
        <span
          className="fixed z-40 block w-[260px] overflow-hidden rounded-xl border border-edge bg-surface-raised shadow-xl animate-fade-in pointer-events-auto"
          style={style}
          onMouseEnter={() => {
            surfaceHoveredRef.current = true;
            cancelClose();
          }}
          onMouseLeave={() => {
            surfaceHoveredRef.current = false;
            closeSoon();
          }}
        >
          <span className="flex items-center justify-between border-b border-edge px-3 py-2">
            <span className="text-[11px] font-medium text-fg-muted">{t('profileEditor.tools')}</span>
            <span className="text-[10px] text-fg-faint">{tools.length}</span>
          </span>
          {tools.length > 0 ? (
            <span className="block max-h-[220px] overflow-y-auto p-1.5">
              {visibleTools.map((tool) => {
                const Icon = getToolIcon(tool);
                return (
                  <span key={tool} className="flex items-start gap-2 rounded-md px-2 py-1.5">
                    <Icon size={13} className="mt-0.5 flex-shrink-0 text-primary-fg" />
                    <span className="min-w-0">
                      <span
                        className="block truncate text-[11px] font-medium leading-tight text-fg-secondary"
                        title={tool.replace(/_/g, ' ')}
                      >
                        {tool.replace(/_/g, ' ')}
                      </span>
                      <span className="block text-[10px] leading-tight text-fg-faint line-clamp-2">
                        {getToolBrief(tool)}
                      </span>
                    </span>
                  </span>
                );
              })}
              {hiddenCount > 0 && (
                <span className="block px-2 py-1 text-[10px] font-medium text-fg-faint">
                  {t('profileSelector.moreTools', { count: hiddenCount })}
                </span>
              )}
            </span>
          ) : (
            <span className="block px-3 py-2 text-center text-[10px] italic text-fg-faint">
              {t('profileSelector.promptOnly')}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

function renderProfileRow(
  p: Profile,
  selectedId: string,
  hoveredId: string | null,
  onSelect: (id: string) => void,
  onClose: () => void,
  setHoveredId: (id: string | null) => void,
  localized: Localize,
) {
  const isSelected = p.id === selectedId;
  const isHovered = hoveredId === p.id;
  const name = profileName(p, localized);
  const description = profileDescription(p, localized);
  return (
    <button
      key={p.id}
      onClick={() => {
        onSelect(p.id);
        onClose();
      }}
      onMouseEnter={() => setHoveredId(p.id)}
      onMouseLeave={() => setHoveredId(null)}
      onFocus={() => setHoveredId(p.id)}
      className={`h-[42px] w-full overflow-hidden text-left px-2 py-1.5 rounded-lg transition-colors flex items-center gap-2 ${
        isSelected
          ? 'bg-primary-subtle border border-primary-edge'
          : isHovered
            ? 'bg-surface-sunken border border-edge'
            : 'border border-transparent hover:bg-surface-sunken'
      }`}
    >
      <SproutyAvatar {...profileToSprouty(p)} state="idle" size="xs" animate={isHovered} />
      <span className="flex-1 min-w-0 overflow-hidden">
        <span
          className={`text-[13px] leading-tight font-medium truncate block ${isSelected ? 'text-primary-fg-strong' : 'text-fg-secondary'}`}
          title={name}
        >
          {name}
        </span>
        <span
          className={`mt-0.5 block h-3 truncate text-[10px] leading-3 ${
            isHovered && description ? 'text-fg-faint' : 'text-transparent'
          }`}
          title={description || undefined}
        >
          {description || '\u00a0'}
        </span>
      </span>
      <span className="flex items-center gap-1.5 flex-shrink-0">
        <ToolsPreviewTooltip profile={p} isRowHovered={isHovered} />
        {isSelected && <Check size={14} className="text-primary-fg" />}
      </span>
    </button>
  );
}

// ─── Desktop Compact Profile Popover ───────────────────

function ProfilePickerPopover({
  profiles,
  selectedId,
  onSelect,
  onClose,
  anchorRef,
}: {
  profiles: Profile[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  const localized = useLocalized();
  const groupedProfiles = getProfilesByCategory(profiles);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<ProfileFilter>('all');
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);

  // Position: fixed, anchored above the selector button and clamped to the viewport.
  useEffect(() => {
    if (!anchorRef.current) return;
    const rect = anchorRef.current.getBoundingClientRect();
    const listWidth = 340;
    const margin = 16;
    const viewportWidth = window.innerWidth;
    const preferredListLeft = rect.right - listWidth;
    const left = Math.min(Math.max(preferredListLeft, margin), viewportWidth - margin - listWidth);

    setPos({ bottom: window.innerHeight - rect.top + 8, left });
  }, [anchorRef]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const visibleGroups = getVisibleProfileGroups(groupedProfiles, activeFilter);
  const totalVisibleProfiles = visibleGroups.reduce((sum, group) => sum + group.profiles.length, 0);

  if (!pos) return null;

  return (
    <div ref={ref} className="fixed z-30 animate-fade-in" style={{ bottom: pos.bottom, left: pos.left }}>
      <div className="w-[340px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-edge bg-surface-raised shadow-xl">
        <div className="border-b border-edge px-3 py-2.5 flex items-center gap-2">
          <Bot size={14} className="text-primary-fg" />
          <span className="text-xs font-medium text-fg-muted">{t('profileSelector.selectAgent')}</span>
          {/* Light entry to the one place agents are actually managed. */}
          <button
            onClick={() => {
              onClose();
              window.location.hash = '#/agents';
            }}
            className="ml-auto rounded-md px-1.5 py-0.5 text-[11px] text-fg-secondary transition-colors hover:bg-surface-muted hover:text-fg"
          >
            {t('profileSelector.manage')}
          </button>
        </div>
        <div className="border-b border-edge px-2.5 py-2">
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
            {PROFILE_FILTERS.map((filter) => {
              const count = filter === 'all' ? profiles.length : groupedProfiles[filter].length;
              if (count === 0 && filter !== 'all') return null;
              const isActive = activeFilter === filter;
              return (
                <button
                  key={filter}
                  onClick={() => {
                    setActiveFilter(filter);
                    setHoveredId(null);
                  }}
                  className={`flex-shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                    isActive
                      ? 'bg-primary-subtle text-primary-fg-strong border border-primary-edge'
                      : 'border border-transparent text-fg-muted hover:bg-surface-sunken hover:text-fg-secondary'
                  }`}
                >
                  {t(PROFILE_FILTER_LABELS[filter])} <span className="text-fg-faint">{count}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="h-[164px] overflow-y-auto p-1.5">
          {totalVisibleProfiles > 0 ? (
            <div className="space-y-1">
              {visibleGroups.map((group, index) => (
                <div key={group.category}>
                  <div className={`${index > 0 ? 'mt-1.5 border-t border-edge pt-1.5' : ''} px-2 py-1`}>
                    <span className="text-[10px] font-medium uppercase tracking-wider text-fg-faint">
                      {t(PROFILE_CATEGORY_LABELS[group.category])}
                    </span>
                  </div>
                  <div className="space-y-1">
                    {group.profiles.map((p) =>
                      renderProfileRow(p, selectedId, hoveredId, onSelect, onClose, setHoveredId, localized),
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-24 items-center justify-center px-4 text-center">
              <span className="text-xs text-fg-faint">{t('profileSelector.noAgents')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Mobile Profile Picker Drawer ────────────────────────

function ProfilePickerDrawer({
  profiles,
  selectedId,
  onSelect,
  onClose,
}: {
  profiles: Profile[];
  selectedId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const localized = useLocalized();
  const groupedProfiles = getProfilesByCategory(profiles);
  const [activeFilter, setActiveFilter] = useState<ProfileFilter>('all');
  const visibleGroups = getVisibleProfileGroups(groupedProfiles, activeFilter);
  const totalVisibleProfiles = visibleGroups.reduce((sum, group) => sum + group.profiles.length, 0);

  const renderMobileRow = (p: Profile) => {
    const isSelected = p.id === selectedId;
    const name = profileName(p, localized);
    const description = profileDescription(p, localized);
    return (
      <button
        key={p.id}
        onClick={() => {
          onSelect(p.id);
          onClose();
        }}
        className={`w-full text-left px-4 py-3 rounded-xl transition-colors flex items-start gap-3 ${
          isSelected ? 'bg-primary-subtle' : 'hover:bg-surface-sunken'
        }`}
      >
        <div className="mt-0.5 flex-shrink-0">
          <SproutyAvatar {...profileToSprouty(p)} state="idle" size="sm" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`text-sm font-medium truncate ${isSelected ? 'text-primary-fg-strong' : 'text-fg-secondary'}`}
                title={name}
              >
                {name}
              </span>
              {isSelected && <Check size={14} className="text-primary-fg flex-shrink-0" />}
            </div>
            <span className="text-[10px] text-fg-faint flex-shrink-0">
              {t('profileSelector.toolCount', { count: p.tools.length })}
            </span>
          </div>
          {description && (
            <p className="text-xs text-fg-faint mt-0.5 leading-snug line-clamp-2" title={description}>
              {description}
            </p>
          )}
        </div>
      </button>
    );
  };

  return (
    <OverlayPanel onClose={onClose} variant="bottom" ariaLabel={t('profileSelector.selectAgent')}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-edge">
        <div className="flex items-center gap-2">
          <Bot size={14} className="text-primary-fg" />
          <span className="text-sm font-medium text-fg-secondary">{t('profileSelector.selectAgent')}</span>
        </div>
        <div className="flex items-center gap-1">
          {/* Light entry to the one place agents are actually managed. */}
          <button
            onClick={() => {
              onClose();
              window.location.hash = '#/agents';
            }}
            className="rounded-md px-2 py-1 text-xs text-fg-secondary transition-colors hover:bg-surface-muted hover:text-fg"
          >
            {t('profileSelector.manage')}
          </button>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-surface-muted text-fg-faint">
            <X size={16} />
          </button>
        </div>
      </div>
      <div className="border-b border-edge px-3 py-2">
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
          {PROFILE_FILTERS.map((filter) => {
            const count = filter === 'all' ? profiles.length : groupedProfiles[filter].length;
            if (count === 0 && filter !== 'all') return null;
            const isActive = activeFilter === filter;
            return (
              <button
                key={filter}
                onClick={() => setActiveFilter(filter)}
                className={`flex-shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  isActive
                    ? 'bg-primary-subtle text-primary-fg-strong border border-primary-edge'
                    : 'border border-transparent text-fg-muted hover:bg-surface-sunken hover:text-fg-secondary'
                }`}
              >
                {t(PROFILE_FILTER_LABELS[filter])} <span className="text-fg-faint">{count}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {totalVisibleProfiles > 0 ? (
          <div className="space-y-1">
            {visibleGroups.map((group, index) => (
              <div key={group.category}>
                <div className={`${index > 0 ? 'border-t border-edge mt-1.5 pt-1.5' : ''} px-4 py-1`}>
                  <span className="text-[10px] font-medium text-fg-faint uppercase tracking-wider">
                    {t(PROFILE_CATEGORY_LABELS[group.category])}
                  </span>
                </div>
                <div className="space-y-1">{group.profiles.map(renderMobileRow)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-24 items-center justify-center px-4 text-center">
            <span className="text-xs text-fg-faint">{t('profileSelector.noAgents')}</span>
          </div>
        )}
      </div>
    </OverlayPanel>
  );
}

// ─── Main ProfileSelector ────────────────────────────────

interface ProfileSelectorProps {
  profiles: Profile[];
  selectedProfileId: string;
  onSelectProfile: (id: string) => void;
  readonly?: boolean;
  onFork?: (profileId: string) => void;
}

export function ProfileSelector({
  profiles,
  selectedProfileId,
  onSelectProfile,
  readonly = false,
}: ProfileSelectorProps) {
  const [showPicker, setShowPicker] = useState(false);
  const selectorRef = useRef<HTMLDivElement>(null);
  const localized = useLocalized();

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

  if (!selectedProfile) return null;
  // Sprouty is the implicit default. Only an explicitly selected Agent earns a
  // persistent label in the toolbar; otherwise this slot belongs to the model.
  if (selectedProfileId === DEFAULT_AGENT_ID) return null;
  if (profiles.length <= 1 && !readonly) return null;

  return (
    <div ref={selectorRef} className="relative px-1 py-1">
      <button
        onClick={() => !readonly && profiles.length > 1 && setShowPicker(!showPicker)}
        disabled={readonly || profiles.length <= 1}
        className={`inline-flex min-h-11 sm:min-h-0 items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${
          readonly ? 'text-fg-muted cursor-default' : 'text-primary-fg-strong hover:bg-primary-subtle cursor-pointer'
        }`}
      >
        <SproutyAvatar {...profileToSprouty(selectedProfile)} state="idle" size="xs" animate={false} />
        <span className="truncate max-w-[110px] sm:max-w-[200px]">{profileName(selectedProfile, localized)}</span>
        {!readonly && profiles.length > 1 && (
          <ChevronDown size={12} className={`flex-shrink-0 transition-transform ${showPicker ? 'rotate-180' : ''}`} />
        )}
      </button>

      {/* Desktop popover */}
      {showPicker && !readonly && (
        <div className="hidden md:block">
          <ProfilePickerPopover
            profiles={profiles}
            selectedId={selectedProfileId}
            onSelect={onSelectProfile}
            onClose={() => setShowPicker(false)}
            anchorRef={selectorRef}
          />
        </div>
      )}

      {/* Mobile drawer */}
      {showPicker && !readonly && (
        <div className="md:hidden">
          <ProfilePickerDrawer
            profiles={profiles}
            selectedId={selectedProfileId}
            onSelect={onSelectProfile}
            onClose={() => setShowPicker(false)}
          />
        </div>
      )}
    </div>
  );
}
