/**
 * The prototype's own compositions on top of the kit (@greenhouse/ui/kit): the page frame, the
 * "需要你" cards, the record editor, the chart and run steps that use mock data, and the native
 * select of the preview toolbar.
 */

import { useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  BarChart3,
  Bell,
  Check,
  ChevronDown,
  FileText,
  ScanFace,
  KeyRound,
  ListChecks,
  MessageCircleQuestion,
  MonitorPlay,
  Sparkles,
} from 'lucide-react';
import {
  Button,
  ChatCard,
  Checkbox,
  DatePicker,
  Field,
  HelpHint,
  IconButton,
  Input,
  OverlayActions,
  Select,
  Spinner,
  TextArea,
  type Tone,
} from '@greenhouse/ui/kit';
import { DesignContext, useDesign } from './context';
import { decideApproval, type ApprovalState, type RecordItem, type Status } from './data';

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
  builder = false,
  children,
}: {
  title: ReactNode;
  help?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  width?: 'reading' | 'form' | 'list' | 'canvas';
  className?: string;
  builder?: boolean;
  children: ReactNode;
}) {
  const { headerLead, mobile, navigate, needsYou, continueOnComputer } = useDesign();
  const label = typeof title === 'string' ? title : '页面';
  return (
    <div className={`page-frame ${className}`}>
      <header className="page-header">
        {headerLead}
        <h1 className="page-header-title">{title}</h1>
        {help && <HelpHint label={label}>{help}</HelpHint>}
        {badge}
        <span className="grow" />
        {builder && mobile ? (
          <Button kind="primary" onClick={continueOnComputer}>
            在电脑上继续
          </Button>
        ) : (
          actions
        )}
        {mobile && (
          <IconButton label="通知" onClick={() => navigate('notifications')}>
            <Bell size={18} />
            {needsYou > 0 && (
              <span className="count warning" aria-label={`${needsYou} 件需要你`}>
                {needsYou}
              </span>
            )}
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
const approvalStatus: Record<ApprovalState, [string, Tone]> = {
  pending: ['需要你', 'warning'],
  accepted: ['已批准', 'success'],
  rejected: ['已拒绝', 'neutral'],
  expired: ['已过期', 'neutral'],
};
/** A simulated system check stays inside the product's floating boundary. */
export function FaceVerification({ onVerified }: { onVerified: () => void }) {
  const complete = useRef(onVerified);
  useEffect(() => {
    complete.current = onVerified;
  }, [onVerified]);
  useEffect(() => {
    const timer = setTimeout(() => complete.current(), 1000);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="face-verification" role="status" aria-label="Face ID 验证中">
      <div>
        <ScanFace size={48} />
        <span>Face ID</span>
      </div>
    </div>
  );
}
/** Shared cards use a request id; lab samples deliberately keep local state. */
export function ApprovalCard({
  initial = 'pending',
  expiresAt,
  onResult,
  requestId,
}: {
  initial?: ApprovalState;
  expiresAt?: number;
  onResult?: (state: ApprovalState) => void;
  requestId?: string;
}) {
  const context = useContext(DesignContext);
  const request = requestId ? context?.requests.find((item) => item.id === requestId) : undefined;
  const [approval, setApproval] = useState({ state: initial, expiresAt: expiresAt ?? Date.now() + 300000 });
  const [standing, setStanding] = useState(false);
  const [verifying, setVerifying] = useState(false);
  useEffect(() => {
    if (requestId || approval.state !== 'pending') return;
    const timer = setTimeout(
      () => setApproval((value) => ({ ...value, state: 'expired' })),
      Math.max(0, approval.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [approval, requestId]);
  const state = request?.state === 'done' ? 'accepted' : (request?.state ?? approval.state);
  const decide = (decision: 'accepted' | 'rejected') => {
    if (requestId) context?.decide(requestId, decision, standing);
    else {
      const result = decideApproval(approval, decision, Date.now());
      setApproval(result);
      onResult?.(result.state);
    }
  };
  const pending = state === 'pending';
  const tier = request?.tier ?? 2;
  const [status, tone] = approvalStatus[state];
  return (
    <>
      <ChatCard
        attention={pending}
        icon={<ListChecks size={16} />}
        title={request?.title ?? '把 2 条任务标为已完成？'}
        status={status}
        tone={tone}
        footerEnd={pending}
        footer={
          pending ? (
            <>
              <Button disabled={verifying} onClick={() => decide('rejected')}>
                拒绝
              </Button>
              <Button
                kind="primary"
                disabled={verifying}
                onClick={() => (tier === 3 && context?.mobile ? setVerifying(true) : decide('accepted'))}
              >
                {tier === 3 && context?.mobile ? '用 Face ID 批准' : '批准'}
              </Button>
            </>
          ) : (
            <span className="muted small">
              {state === 'accepted'
                ? (request?.standing ?? standing)
                  ? '任务已更新，以后「产品计划」都允许。'
                  : tier === 3
                    ? '邀请已发送。'
                    : '任务已更新。'
                : state === 'rejected'
                  ? '没有执行。'
                  : '请让 Agent 重新发起。'}
            </span>
          )
        }
      >
        <div className="request-facts">
          <span>对象</span>
          <span>{request?.target ?? '产品计划'}</span>
          <span>影响</span>
          <span>{request?.effect ?? '2 条任务：进行中 → 已完成'}</span>
          <span>范围</span>
          <span>{request?.scope ?? '产品计划 / 任务'}</span>
        </div>
        {pending && tier === 2 && <Checkbox label="以后「产品计划」都允许" checked={standing} onChange={setStanding} />}
      </ChatCard>
      {verifying && (
        <FaceVerification
          onVerified={() => {
            setVerifying(false);
            decide('accepted');
          }}
        />
      )}
    </>
  );
}
type RequestKind = 'login' | 'takeover' | 'question' | 'proposal';
/** "需要你" — the other four request kinds share the same card. */
export function RequestCard({
  kind,
  onDone,
  requestId,
}: {
  kind: RequestKind;
  onDone?: (result: string) => void;
  requestId?: string;
}) {
  const context = useContext(DesignContext);
  const request = requestId ? context?.requests.find((item) => item.id === requestId) : undefined;
  const [result, setResult] = useState<{ status: string; note: string } | null>(null);
  const [answer, setAnswer] = useState('按优先级');
  const finish = (status: string, note: string) => {
    if (requestId) context?.decide(requestId, status === '已拒绝' ? 'rejected' : 'done');
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
  const pending = request ? request.state === 'pending' : !result;
  const status =
    request && !pending
      ? request.state === 'rejected'
        ? '已拒绝'
        : request.state === 'expired'
          ? '已过期'
          : '已完成'
      : result?.status;
  return (
    <ChatCard
      attention={pending}
      icon={icon}
      title={title}
      status={status ?? '需要你'}
      tone={pending ? 'warning' : status === '已完成' ? 'success' : 'neutral'}
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
          <span className="muted small">{result?.note ?? '已在其他设备处理。'}</span>
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
  const formId = useId();
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
      id={formId}
      className="record-form"
      noValidate
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
        <TextArea rows={5} value={draft.note} onChange={(event) => change({ note: event.target.value })} />
      </Field>
      <OverlayActions>
        <Button disabled={loading} onClick={onCancel}>
          取消
        </Button>
        <Button kind="primary" type="submit" form={formId} loading={loading}>
          保存
        </Button>
      </OverlayActions>
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
              {active ? <Spinner size={12} /> : <Check size={12} />}
            </span>
            <span className="grow">{step}</span>
            <span className="muted small">{active ? '运行中' : ['10:30', '10:31', '10:31'][index]}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** The prototype's own preview controls only (toolbar page switch, chat scenario); product UI uses Select. */
export function NativeSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <span className="native-select">
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
      <ChevronDown size={13} />
    </span>
  );
}
