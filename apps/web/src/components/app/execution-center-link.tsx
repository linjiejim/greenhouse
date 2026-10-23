import { History } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { ACTIVITY_ROOT_HASH } from '../../lib/execution-route';

/**
 * The account-flyout / collapsed-rail entry to the Activity log (操作记录) —
 * every member's own record of changes, which is what the Execution Center
 * became in v1.5. (Admins also reach everyone's under Administration.)
 */
export function ExecutionCenterLink({
  active,
  compact = false,
  menu = false,
  onNavigate,
}: {
  active: boolean;
  compact?: boolean;
  menu?: boolean;
  onNavigate?: () => void;
}) {
  const t = useT();
  const label = t('navigation.activityLog');

  return (
    <a
      href={ACTIVITY_ROOT_HASH}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      title={label}
      role={menu ? 'menuitem' : undefined}
      className={
        menu
          ? `flex w-full items-center gap-2.5 px-3 py-1.5 text-sm transition-colors ${
              active ? 'bg-primary-subtle text-primary-fg-strong' : 'text-fg-secondary hover:bg-surface-sunken'
            }`
          : compact
            ? `relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
                active ? 'sidebar-active-item' : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
              }`
            : `flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 text-xs font-medium transition-colors md:min-h-8 ${
                active ? 'sidebar-active-item font-semibold' : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
              }`
      }
    >
      <span className={menu ? 'w-5 text-center text-fg-faint' : undefined}>
        <History size={compact ? 16 : menu ? 15 : 14} className="inline flex-shrink-0" aria-hidden="true" />
      </span>
      {!compact && <span className="min-w-0 flex-1 truncate">{label}</span>}
    </a>
  );
}
