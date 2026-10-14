/**
 * Status and feedback (docs/design-system/components.md, 展示 and 反馈): badges in the one status
 * vocabulary, empty states, skeletons, inline errors, the banner and the toast.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { Check, CircleAlert, Inbox, Info, X } from 'lucide-react';
import { icon } from '../tokens/haven';
import { Button, IconButton } from './controls';
import { useKitStrings } from './provider';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`gh-badge gh-badge-${tone}`}>{children}</span>;
}

/**
 * Colors of the status vocabulary (docs/design-system/content.md, 状态词): yellow only for what
 * needs you (to decide, take over or check), red only for failure. Every other word — 已过期,
 * 已取消, 已拒绝, 未配置 — is neutral.
 */
const TONE_OF_WORD: Record<string, Tone> = Object.fromEntries(
  (
    [
      ['warning', ['需要你', '等你接管', '结果未知']],
      ['danger', ['失败', '不可用', '部分不可用', '保存失败']],
      ['info', ['排队中', '排队', '运行中', '进行中', '启动中', '生成中', '保存中']],
      ['success', ['已完成', '已连接', '已批准', '可用', '已发布', '已保存']],
    ] as const
  ).flatMap(([tone, words]) => words.map((word) => [word, tone] as const)),
);

/** The tone of a status word; words outside the vocabulary are neutral (pass `tone` to StatusBadge instead). */
export function statusTone(status: string): Tone {
  return TONE_OF_WORD[status] ?? 'neutral';
}

/** A status word with its dot; the tone follows the vocabulary unless given. */
export function StatusBadge({ status, tone }: { status: string; tone?: Tone }) {
  return (
    <Badge tone={tone ?? statusTone(status)}>
      <span className="gh-status-dot" aria-hidden />
      {status}
    </Badge>
  );
}

/** One icon, one sentence, one action. Say which empty it is: none yet, no match, no access. */
export function Empty({
  icon: glyph,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  const t = useKitStrings();
  return (
    <div className="gh-empty">
      <span className="gh-empty-icon" aria-hidden>
        {glyph ?? <Inbox strokeWidth={icon.stroke} />}
      </span>
      <h3 className="gh-empty-title">{title ?? t.nothingHere}</h3>
      {description && <p className="gh-empty-description">{description}</p>}
      {action}
    </div>
  );
}

/** Placeholder lines the size of the real content; still, no shimmer. */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  const t = useKitStrings();
  return (
    <div className="gh-skeleton-group" role="status" aria-label={t.loading}>
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="gh-skeleton" style={{ width: `${100 - index * 12}%` }} />
      ))}
    </div>
  );
}

/** Says what went wrong and what was kept, with a retry. A failure never shows as empty. */
export function ErrorBox({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  const t = useKitStrings();
  return (
    <div className="gh-error-box" role="alert">
      <CircleAlert size={icon.lg} strokeWidth={icon.stroke} />
      <div className="gh-error-box-text">{children}</div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          {t.retry}
        </Button>
      )}
    </div>
  );
}

/**
 * At most one per screen, under the page header, about something the member can act on (the
 * action goes in `action`). It closes only when acting is optional (`onClose`).
 */
export function Banner({
  children,
  tone = 'info',
  action,
  onClose,
}: {
  children: ReactNode;
  tone?: 'info' | 'warning';
  action?: ReactNode;
  onClose?: () => void;
}) {
  const t = useKitStrings();
  return (
    <div className={`gh-banner gh-banner-${tone}`} role="status">
      <Info size={icon.md} strokeWidth={icon.stroke} className="gh-banner-icon" />
      <div className="gh-banner-text">{children}</div>
      {action}
      {onClose && (
        <IconButton label={t.close} size="sm" onClick={onClose}>
          <X size={icon.sm} strokeWidth={icon.stroke} />
        </IconButton>
      )}
    </div>
  );
}

/**
 * Bottom right, bottom centre in the narrow layout. Leaves after 4 s, 8 s when it offers an
 * action (撤销). Errors never go in a toast: they stay where they happened.
 */
export function Toast({
  text,
  onClose,
  action,
}: {
  text: string;
  onClose: () => void;
  action?: { label: string; onClick: () => void };
}) {
  const t = useKitStrings();
  const close = useRef(onClose);
  close.current = onClose;
  const hasAction = !!action;
  useEffect(() => {
    const timer = setTimeout(() => close.current(), hasAction ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [text, hasAction]);
  return (
    <div className="gh-toast" role="status">
      <Check size={icon.md} strokeWidth={icon.stroke} className="gh-toast-icon" />
      <span className="gh-toast-text">{text}</span>
      {action && (
        <Button kind="ghost" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
      <IconButton label={t.dismissToast} size="sm" onClick={onClose}>
        <X size={icon.sm} strokeWidth={icon.stroke} />
      </IconButton>
    </div>
  );
}
