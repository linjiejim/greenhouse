import { ClipboardList } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { useRuntimeAttentionCount } from '../../hooks/use-runtime-attention-count';
import { useAuthStore } from '../../stores';

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
  const user = useAuthStore((state) => state.currentUser);
  const attentionCount = useRuntimeAttentionCount(!!user);
  const countLabel = attentionCount > 99 ? '99+' : attentionCount;
  const href = attentionCount > 0 ? '#/executions?tab=attention' : '#/executions';

  return (
    <a
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      aria-label={t('taskCenter.title')}
      title={t('taskCenter.title')}
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
        <ClipboardList size={compact ? 16 : menu ? 15 : 14} className="inline flex-shrink-0" aria-hidden="true" />
      </span>
      {!compact && <span className="min-w-0 flex-1 truncate">{t('taskCenter.title')}</span>}
      {attentionCount > 0 && (
        <span
          className={`${compact ? 'absolute -right-1 -top-1' : ''} inline-flex min-w-4 items-center justify-center rounded-full bg-warning-subtle px-1 text-[9px] font-semibold text-warning`}
        >
          {countLabel}
        </span>
      )}
    </a>
  );
}
