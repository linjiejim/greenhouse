import {
  Children,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import {
  BarChart3,
  Bell,
  Check,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  FileText,
  Inbox,
  KeyRound,
  ListChecks,
  LoaderCircle,
  MessageCircleQuestion,
  MonitorPlay,
  Search,
  Sparkles,
  X,
} from 'lucide-react';
import { useDesign } from './context';
import { decideApproval, type ApprovalState, type RecordItem, type Status } from './data';
import { DatePicker, Select } from './pickers';

export function Button({
  children,
  kind = 'secondary',
  loading = false,
  className = '',
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`button ${kind} ${className}`}
    >
      {loading && <LoaderCircle size={16} className="spin" />}
      {children}
    </button>
  );
}
export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <Button {...props} kind="ghost" className={`icon-button ${props.className || ''}`} aria-label={label} title={label}>
      {children}
    </Button>
  );
}

/**
 * The light "?" that keeps supplementary explanation off the page
 * (docs/design-system/components.md, 说明): hover or focus shows it,
 * a click pins it, Escape or an outside click closes it. Never for errors,
 * required fields, irreversible consequences or permission reasons.
 */
export function HelpHint({ label, children }: { label: string; children: ReactNode }) {
  const [pinned, setPinned] = useState(false);
  const [peek, setPeek] = useState(false);
  const [shift, setShift] = useState(0);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = pinned || peek;
  // Escape dismisses it however it was opened — hover, focus or click (WCAG 1.4.13).
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setPinned(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setPinned(false);
        setPeek(false);
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // Keep the bubble inside the product window (or the viewport).
  useLayoutEffect(() => {
    if (!open || !bubble.current) return;
    const box = bubble.current.getBoundingClientRect();
    const frame = (root.current?.closest('.product-window') ?? document.body).getBoundingClientRect();
    const overflowRight = box.right - (frame.right - 8);
    const overflowLeft = frame.left + 8 - box.left;
    setShift(overflowRight > 0 ? -overflowRight : overflowLeft > 0 ? overflowLeft : 0);
  }, [open]);
  return (
    <span
      className="help-hint"
      ref={root}
      onMouseEnter={() => {
        timer.current = setTimeout(() => setPeek(true), 300);
      }}
      onMouseLeave={() => {
        if (timer.current) clearTimeout(timer.current);
        setPeek(false);
      }}
    >
      <button
        type="button"
        className="help-hint-button"
        aria-label={`说明：${label}`}
        aria-expanded={pinned}
        aria-describedby={open ? id : undefined}
        onClick={() => setPinned(!pinned)}
        onFocus={() => setPeek(true)}
        onBlur={() => setPeek(false)}
      >
        <CircleHelp size={14} />
      </button>
      {open && (
        <span
          ref={bubble}
          role="tooltip"
          id={id}
          className="help-hint-bubble"
          style={shift ? { transform: `translateX(${shift}px)` } : undefined}
        >
          {children}
        </span>
      )}
    </span>
  );
}

/**
 * A page: one 56px header (title, an optional "?", a status badge, at most one primary
 * action and a "⋯") over the page's single scroll area. No description line.
 * `width`: reading 760 · form 720 · list 1200 · canvas full (docs/design-system/layout.md).
 */
export function PageFrame({
  title,
  help,
  badge,
  actions,
  width = 'list',
  className = '',
  children,
}: {
  title: ReactNode;
  help?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  width?: 'reading' | 'form' | 'list' | 'canvas';
  className?: string;
  children: ReactNode;
}) {
  const { headerLead, mobile, navigate, needsYou } = useDesign();
  const label = typeof title === 'string' ? title : '页面';
  return (
    <div className={`page-frame ${className}`}>
      <header className="page-header">
        {headerLead}
        <h1 className="page-header-title">{title}</h1>
        {help && <HelpHint label={label}>{help}</HelpHint>}
        {badge}
        <span className="grow" />
        {actions}
        {mobile && (
          <IconButton label="通知" onClick={() => navigate('notifications')}>
            <Bell size={18} />
            {needsYou > 0 && <span className="notification-dot" />}
          </IconButton>
        )}
      </header>
      <div className={`scroll-page width-${width}`}>{children}</div>
    </div>
  );
}
export function SectionTitle({ title, help, actions }: { title: string; help?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="section-heading">
      <div className="row">
        <h2>{title}</h2>
        {help && <HelpHint label={title}>{help}</HelpHint>}
      </div>
      {actions}
    </div>
  );
}
export function Field({
  label,
  error,
  description,
  help,
  required = false,
  children,
}: {
  label: string;
  error?: string;
  /** One visible sentence that changes what the user does. Everything else goes to `help`. */
  description?: string;
  help?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <div className="field-label-row">
        <label className="field-label">
          <span>
            {label}
            {required && <span className="required"> · 必填</span>}
          </span>
          {children}
        </label>
        {help && (
          <span className="field-help">
            <HelpHint label={label}>{help}</HelpHint>
          </span>
        )}
      </div>
      {error ? (
        <span className="error" role="alert">
          {error}
        </span>
      ) : (
        description && <span className="muted small">{description}</span>
      )}
    </div>
  );
}
export function Input(props: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input {...props} className={`input ${props.className || ''}`} />;
}
export function SearchInput({
  value,
  onChange,
  placeholder = '搜索',
  label = '搜索',
  autoFocus = false,
  onEscape,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
  onEscape?: () => void;
}) {
  return (
    <div className="search-field">
      <Search size={16} />
      <Input
        aria-label={label}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          if (value) onChange('');
          else onEscape?.();
        }}
        placeholder={placeholder}
      />
      {value && (
        <IconButton label="清除搜索" onClick={() => onChange('')}>
          <X size={14} />
        </IconButton>
      )}
    </div>
  );
}
/** 2–4 mutually exclusive scopes or views. */
export function Segmented({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly string[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {items.map((item) => (
        <button key={item} role="radio" aria-checked={item === value} onClick={() => onChange(item)}>
          {item}
        </button>
      ))}
    </div>
  );
}
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="switch"
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
/** Write-only secret: shows whether it is configured, never the value. */
export function SecretField({
  label,
  configured,
  onSave,
  help,
}: {
  label: string;
  configured: boolean;
  onSave: () => void;
  help?: ReactNode;
}) {
  const [editing, setEditing] = useState(!configured);
  const [value, setValue] = useState('');
  return (
    <Field label={label} help={help}>
      {editing ? (
        <span className="secret-edit">
          <Input
            type="password"
            autoComplete="off"
            placeholder="粘贴新的 Key"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <Button
            kind="primary"
            disabled={!value.trim()}
            onClick={() => {
              setValue('');
              setEditing(false);
              onSave();
            }}
          >
            保存
          </Button>
        </span>
      ) : (
        <span className="secret-configured">
          <KeyRound size={15} />
          已配置
          <Button kind="ghost" onClick={() => setEditing(true)}>
            替换
          </Button>
        </span>
      )}
    </Field>
  );
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
/** One status vocabulary for the whole product (docs/design-system/content.md, 状态词). */
export function statusTone(status: string): Tone {
  if (/失败|不可用|错误/.test(status)) return 'danger';
  if (/需要你|待处理|已过期|等你接管/.test(status)) return 'warning';
  if (/运行中|进行中|排队|启动中|生成中/.test(status)) return 'info';
  if (/已完成|已连接|已批准|可用|已发布|已保存/.test(status)) return 'success';
  return 'neutral';
}
export function StatusBadge({ status, tone }: { status: string; tone?: Tone }) {
  return (
    <Badge tone={tone ?? statusTone(status)}>
      <span className="status-dot" />
      {status}
    </Badge>
  );
}
export function Tabs({
  items,
  value,
  onChange,
  label = '视图',
}: {
  items: readonly string[];
  value: string;
  onChange: (item: string) => void;
  label?: string;
}) {
  const id = useId();
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {items.map((item, index) => (
        <button
          key={item}
          role="tab"
          id={`${id}-${index}`}
          aria-selected={item === value}
          tabIndex={value === item ? 0 : -1}
          onClick={() => onChange(item)}
          onKeyDown={(event) => {
            if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
              event.preventDefault();
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : (index + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length;
              onChange(items[next]);
              (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
            }
          }}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
export function Empty({
  title = '这里还没有内容',
  description,
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <Inbox size={32} strokeWidth={1.4} />
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-group" role="status" aria-label="正在加载">
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="skeleton" style={{ width: `${100 - index * 12}%` }} />
      ))}
    </div>
  );
}
export function ErrorBox({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <CircleAlert size={18} />
      <div>{children}</div>
      {onRetry && <Button onClick={onRetry}>重试</Button>}
    </div>
  );
}
export function Overlay({
  title,
  help,
  children,
  footer,
  onClose,
  center = false,
  wide = false,
}: {
  title: string;
  help?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  center?: boolean;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [leaving, setLeaving] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const dragStart = useRef<number | null>(null);
  const callback = useRef(onClose);
  callback.current = onClose;
  const dismiss = () => {
    setLeaving(true);
  };
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(
      () => {
        callback.current();
        setLeaving(false);
      },
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180,
    );
    return () => clearTimeout(timer);
  }, [leaving]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const element = ref.current;
    const timer = setTimeout(() => {
      (element?.querySelector('[data-autofocus]') as HTMLElement | null)?.focus({ preventScroll: true });
      if (!element?.contains(document.activeElement)) element?.focus({ preventScroll: true });
    }, 30);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setLeaving(true);
      }
      if (event.key === 'Tab') {
        const targets = Array.from(
          element?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]',
          ) || [],
        ).filter((item) => item.tabIndex >= 0 && item.getClientRects().length && !item.closest('[inert]'));
        const first = targets[0];
        const last = targets.at(-1);
        if (!first) {
          event.preventDefault();
          element?.focus();
        } else if (!element?.contains(document.activeElement)) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', key);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div className={`overlay ${center ? 'center' : ''} ${leaving ? 'leaving' : ''}`}>
      <button className="scrim" aria-label="关闭弹框" tabIndex={-1} onClick={dismiss} />
      <div
        ref={ref}
        tabIndex={-1}
        className={`overlay-panel ${wide ? 'wide' : ''}`}
        style={
          dragOffset ? { transform: `translateY(${dragOffset}px)`, animation: 'none', transition: 'none' } : undefined
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <button
          className="sheet-handle"
          tabIndex={-1}
          aria-label="下拉关闭详情"
          onClick={dismiss}
          onPointerDown={(event) => {
            dragStart.current = event.clientY;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (dragStart.current !== null) setDragOffset(Math.max(0, event.clientY - dragStart.current));
          }}
          onPointerUp={() => {
            if (dragOffset > 90) dismiss();
            dragStart.current = null;
            setDragOffset(0);
          }}
          onPointerCancel={() => {
            dragStart.current = null;
            setDragOffset(0);
          }}
        />
        <header className="overlay-header">
          <h2 id={titleId}>{title}</h2>
          {help && <HelpHint label={title}>{help}</HelpHint>}
          <span className="grow" />
          <IconButton label="关闭详情" onClick={dismiss}>
            <X size={18} />
          </IconButton>
        </header>
        <div className="overlay-body">{children}</div>
        {footer && <footer className="overlay-footer">{footer}</footer>}
      </div>
    </div>
  );
}
/**
 * The one card for what an Agent shows inside a reply (docs/design-system/conversation.md):
 * results (records, tables, charts, files, media), process (tool calls, run steps) and
 * decisions ("需要你"). Title row: icon, title, a short meta, then the status badge at the far
 * right. Process cards fold and lead with a chevron; their finished state stays neutral.
 */
export function ChatCard({
  icon,
  title,
  meta,
  status,
  tone,
  attention = false,
  expandable = false,
  defaultOpen = false,
  footer,
  footerEnd = false,
  className = '',
  children,
}: {
  icon?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  status?: string;
  tone?: Tone;
  /** A decision that is waiting for the user. */
  attention?: boolean;
  expandable?: boolean;
  defaultOpen?: boolean;
  footer?: ReactNode;
  /** Decisions put their buttons on the right; results keep actions on the left. */
  footerEnd?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const heading = (
    <>
      {expandable ? (
        <ChevronRight size={15} className={`chat-card-chevron ${open ? 'open' : ''}`} />
      ) : (
        icon && <span className="chat-card-icon">{icon}</span>
      )}
      <span className="chat-card-title">{title}</span>
      {meta && <span className="chat-card-meta">{meta}</span>}
      <span className="grow" />
      {status && <StatusBadge status={status} tone={tone} />}
    </>
  );
  return (
    <section className={`chat-card ${attention ? 'attention' : ''} ${className}`}>
      {expandable ? (
        <button type="button" className="chat-card-header" aria-expanded={open} onClick={() => setOpen(!open)}>
          {heading}
        </button>
      ) : (
        <header className="chat-card-header">{heading}</header>
      )}
      {(!expandable || open) && Children.toArray(children).length > 0 && (
        <div className="chat-card-body">{children}</div>
      )}
      {footer && <footer className={`chat-card-footer ${footerEnd ? 'end' : ''}`}>{footer}</footer>}
    </section>
  );
}

const approvalStatus: Record<ApprovalState, [string, Tone]> = {
  pending: ['需要你', 'warning'],
  accepted: ['已批准', 'success'],
  rejected: ['已拒绝', 'neutral'],
  expired: ['已过期', 'neutral'],
};
/** "需要你" — approval: the action, its target, its effect and the scope of this grant. */
export function ApprovalCard({
  initial = 'pending',
  expiresAt,
  onResult,
}: {
  initial?: ApprovalState;
  expiresAt?: number;
  onResult?: (state: ApprovalState) => void;
}) {
  const [approval, setApproval] = useState({ state: initial, expiresAt: expiresAt ?? Date.now() + 300000 });
  useEffect(() => {
    if (approval.state !== 'pending') return;
    const timer = setTimeout(
      () => setApproval((value) => ({ ...value, state: 'expired' })),
      Math.max(0, approval.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [approval]);
  const decide = (state: 'accepted' | 'rejected') => {
    const result = decideApproval(approval, state, Date.now());
    setApproval(result);
    onResult?.(result.state);
  };
  const pending = approval.state === 'pending';
  const [status, tone] = approvalStatus[approval.state];
  return (
    <ChatCard
      attention={pending}
      icon={<ListChecks size={16} />}
      title="把 2 条任务标为已完成？"
      status={status}
      tone={tone}
      footerEnd={pending}
      footer={
        pending ? (
          <>
            <span className="muted small grow">仅批准这一次</span>
            <Button onClick={() => decide('rejected')}>拒绝</Button>
            <Button kind="primary" onClick={() => decide('accepted')}>
              批准
            </Button>
          </>
        ) : (
          <span className="muted small">
            {approval.state === 'accepted'
              ? '任务已更新。'
              : approval.state === 'rejected'
                ? '没有修改任务。'
                : '请让 Agent 重新发起。'}
          </span>
        )
      }
    >
      <p className="chat-card-text">「完善成员邀请流程」「对齐首页卡片样式」· 产品计划 / 任务</p>
      <div className="change-preview">
        <span>状态</span>
        <span>
          进行中 <span className="muted">→</span> 已完成
        </span>
      </div>
    </ChatCard>
  );
}
type RequestKind = 'login' | 'takeover' | 'question' | 'proposal';
/** "需要你" — the other four request kinds share the same card. */
export function RequestCard({ kind, onDone }: { kind: RequestKind; onDone?: (result: string) => void }) {
  const [result, setResult] = useState<{ status: string; note: string } | null>(null);
  const [answer, setAnswer] = useState('按优先级');
  const finish = (status: string, note: string) => {
    setResult({ status, note });
    onDone?.(note);
  };
  const content: Record<RequestKind, { icon: ReactNode; title: string; body: string }> = {
    login: { icon: <KeyRound size={16} />, title: '登录供应商门户', body: 'supplier.example.com · 用于下载报价单' },
    takeover: {
      icon: <MonitorPlay size={16} />,
      title: '完成人机验证',
      body: '网站要求验证你是真人。接管电脑，完成后交还。',
    },
    question: { icon: <MessageCircleQuestion size={16} />, title: '周报按什么顺序排列？', body: '' },
    proposal: {
      icon: <Sparkles size={16} />,
      title: '修改「卷卷」的指令',
      body: '新增：改工单状态前，先在工单里写一句处理说明。',
    },
  };
  const { icon, title, body } = content[kind];
  const pending = !result;
  return (
    <ChatCard
      attention={pending}
      icon={icon}
      title={title}
      status={result?.status ?? '需要你'}
      tone={pending ? 'warning' : result.status === '已完成' ? 'success' : 'neutral'}
      footerEnd={pending}
      footer={
        pending ? (
          <>
            {kind === 'login' && (
              <>
                <Button onClick={() => finish('已完成', '你已登录。')}>我来登录</Button>
                <Button kind="primary" onClick={() => finish('已完成', '已用密码库里的登录。')}>
                  使用已存登录
                </Button>
              </>
            )}
            {kind === 'takeover' && (
              <Button kind="primary" onClick={() => finish('已完成', '你已交还电脑。')}>
                接管电脑
              </Button>
            )}
            {kind === 'question' && (
              <Button kind="primary" onClick={() => finish('已完成', `已回答：${answer}`)}>
                提交
              </Button>
            )}
            {kind === 'proposal' && (
              <>
                <Button onClick={() => finish('已拒绝', '指令没有修改。')}>拒绝</Button>
                <Button kind="primary" onClick={() => finish('已完成', '指令已修改。')}>
                  确认修改
                </Button>
              </>
            )}
          </>
        ) : (
          <span className="muted small">{result.note}</span>
        )
      }
    >
      {body && <p className="chat-card-text">{body}</p>}
      {kind === 'proposal' && pending && (
        <div className="change-preview diff">
          <span>+ 改工单状态前，先在工单里写一句处理说明。</span>
        </div>
      )}
      {kind === 'question' && pending && (
        <Field label="排列方式">
          <Select
            label="排列方式"
            value={answer}
            options={['按优先级', '按截止日期', '按负责人']}
            onChange={setAnswer}
          />
        </Field>
      )}
      {kind === 'takeover' && pending && (
        <div className="computer-thumb">
          <MonitorPlay size={22} />
          <span className="muted small">供应商门户 · 验证页</span>
        </div>
      )}
    </ChatCard>
  );
}
export function RecordEditor({
  item,
  onSave,
  onDirty,
  onCancel,
}: {
  item: RecordItem;
  onSave: (item: RecordItem) => void;
  onDirty: (dirty: boolean) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(item);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const title = useRef<HTMLInputElement>(null);
  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  const change = (patch: Partial<RecordItem>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onDirty(JSON.stringify(next) !== JSON.stringify(item));
    setError('');
  };
  const submit = () => {
    if (!draft.title.trim()) {
      setError('请输入标题');
      return;
    }
    setLoading(true);
    timer.current = setTimeout(() => {
      setLoading(false);
      onDirty(false);
      onSave(draft);
    }, 650);
  };
  return (
    <form
      className="record-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="row muted small">
        <FileText size={15} />
        {item.id}
      </div>
      <Field label="标题" error={error} required>
        <Input
          ref={title}
          data-autofocus
          required
          value={draft.title}
          aria-invalid={!!error}
          onChange={(event) => change({ title: event.target.value })}
        />
      </Field>
      <div className="three-columns">
        <Field label="状态">
          <Select
            label="记录状态"
            value={draft.status}
            options={['待处理', '进行中', '已完成']}
            onChange={(status) => change({ status: status as Status })}
          />
        </Field>
        <Field label="优先级">
          <Select
            label="优先级"
            value={draft.priority}
            options={['高', '中', '低']}
            onChange={(priority) => change({ priority: priority as RecordItem['priority'] })}
          />
        </Field>
        <Field label="负责人">
          <Select
            label="负责人"
            value={draft.owner}
            options={['林杰', '陈晨', '周宁']}
            onChange={(owner) => change({ owner })}
          />
        </Field>
      </div>
      <div className="two-columns">
        <Field label="开始日期">
          <DatePicker
            label="开始日期"
            value={draft.start}
            max={draft.date || undefined}
            onChange={(start) => change({ start })}
          />
        </Field>
        <Field label="截止日期">
          <DatePicker
            label="截止日期"
            value={draft.date}
            min={draft.start || undefined}
            onChange={(date) => change({ date })}
          />
        </Field>
      </div>
      <Field label="说明">
        <textarea
          className="input"
          rows={5}
          value={draft.note}
          onChange={(event) => change({ note: event.target.value })}
        />
      </Field>
      <div className="form-actions">
        <Button disabled={loading} onClick={onCancel}>
          取消
        </Button>
        <Button kind="primary" loading={loading} onClick={submit}>
          保存
        </Button>
      </div>
    </form>
  );
}
export function MiniChart({ title = '本周完成的任务' }: { title?: string }) {
  return (
    <ChatCard icon={<BarChart3 size={16} />} title={title} meta="共 25 条">
      <div className="chart-bars" role="img" aria-label="周一 3 条，周二 5 条，周三 4 条，周四 7 条，周五 6 条">
        {[
          { day: '周一', value: 3 },
          { day: '周二', value: 5 },
          { day: '周三', value: 4 },
          { day: '周四', value: 7 },
          { day: '周五', value: 6 },
        ].map((item) => (
          <div key={item.day}>
            <span className="tabular">{item.value}</span>
            <div className="bar" style={{ height: item.value * 13 }} />
            <span className="muted">{item.day}</span>
          </div>
        ))}
      </div>
    </ChatCard>
  );
}
/** Run progress: one row per step, the state word on the right. */
export function Steps({ running = false }: { running?: boolean }) {
  return (
    <ol className="steps">
      {['读取任务', '核对进度', '整理周报'].map((step, index) => {
        const active = running && index === 2;
        return (
          <li key={step}>
            <span className={`step-dot ${active ? 'active' : ''}`}>
              {active ? <LoaderCircle size={12} className="spin" /> : <Check size={12} />}
            </span>
            <span className="grow">{step}</span>
            <span className="muted small">{active ? '运行中' : ['10:30', '10:31', '10:31'][index]}</span>
          </li>
        );
      })}
    </ol>
  );
}
export function Toast({
  text,
  onClose,
  action,
}: {
  text: string;
  onClose: () => void;
  action?: { label: string; onClick: () => void };
}) {
  useEffect(() => {
    const timer = setTimeout(onClose, action ? 8000 : 4000);
    return () => clearTimeout(timer);
  }, [text, onClose, action]);
  return (
    <div className="toast" role="status">
      <Check size={16} />
      <span>{text}</span>
      {action && (
        <Button kind="ghost" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
      <IconButton label="关闭提示" onClick={onClose}>
        <X size={14} />
      </IconButton>
    </div>
  );
}
