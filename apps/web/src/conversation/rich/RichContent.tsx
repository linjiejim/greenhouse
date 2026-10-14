/**
 * A reply's rich blocks (CONV-14, packages/types rich-output): the text runs as Markdown and each
 * registered fence becomes its block — chart, table, stats, cards, steps, buttons, Mermaid,
 * a web page preview. A block still being written holds its place; a block that fails its
 * check stays a code block. Block buttons only ever send a visible message.
 */

import { lazy, memo, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { BarChart3, Check, Download, FileCode2, ListChecks, Maximize2, Table2 } from 'lucide-react';
import { Badge, Button, ChatCard, Overlay, Skeleton, StatusBadge, type Tone } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import {
  injectHtmlBridge,
  parseSegments,
  readHtmlBridgeMessage,
  resolveBlockAction,
  type BlockAction,
  type CardBadgeTone,
  type CardsData,
  type DataTableData,
  type HtmlPreviewSegment,
  type StatsData,
  type StepStatus,
  type StepsData,
} from '@greenhouse/types/rich-output';
import { useNotify } from '../../app/notify';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { saveBlob } from '../../lib/save';
import { Markdown } from '../Markdown';
import { ChartView } from './Chart';

const MermaidView = lazy(() => import('./Mermaid'));

export interface BlockContext {
  /** Sends a block button's value as the member's next message. */
  onAction?: (value: string) => void;
  /** Puts text into the composer (an html-preview page's sendPrompt). */
  onPrompt?: (text: string) => void;
  /** The member's message after this reply: which button was pressed. */
  followUp?: string | null;
  onDownload?: () => void;
}

function Actions({ actions, context }: { actions?: BlockAction[]; context: BlockContext }) {
  if (!actions?.length) return null;
  const chosen = resolveBlockAction(actions, context.followUp);
  return (
    <div className="app-block-actions">
      {actions.map((action) => (
        <Button
          key={action.value}
          size="sm"
          kind={action.variant === 'primary' ? 'primary' : action.variant === 'destructive' ? 'danger' : 'secondary'}
          disabled={chosen !== null || !context.onAction}
          aria-pressed={chosen === action.value || undefined}
          onClick={() => context.onAction?.(action.value)}
        >
          {chosen === action.value && <Check size={icon.sm} />}
          {action.label}
        </Button>
      ))}
    </div>
  );
}

function cell(value: unknown, type: DataTableData['columns'][number]['type'], locale: string) {
  if (value === null || value === undefined) return '';
  if (type === 'boolean') return value ? '✓' : '—';
  if (typeof value === 'number') {
    if (type === 'currency')
      return value.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (type === 'percent') return `${value.toLocaleString(locale, { maximumFractionDigits: 1 })}%`;
    return value.toLocaleString(locale);
  }
  return String(value);
}

function toCsv(data: DataTableData): string {
  const quote = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    data.columns.map((column) => quote(column.label)).join(','),
    ...data.rows.map((row) => data.columns.map((column) => quote(row[column.key])).join(',')),
  ].join('\n');
}

function TableBlock({ data, context }: { data: DataTableData; context: BlockContext }) {
  const { t, locale } = useI18n();
  return (
    <ChatCard
      icon={<Table2 size={icon.md} />}
      title={data.title ?? t('rich.table')}
      meta={t('rich.rows', { count: data.rows.length })}
      footer={
        <Button
          kind="ghost"
          size="sm"
          onClick={() => {
            saveBlob(new Blob([toCsv(data)], { type: 'text/csv;charset=utf-8' }), `${data.title ?? 'table'}.csv`);
            context.onDownload?.();
          }}
        >
          <Download size={icon.sm} />
          {t('rich.exportCsv')}
        </Button>
      }
    >
      <div className="app-table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              {data.columns.map((column) => (
                <th
                  key={column.key}
                  className={cx(column.type && column.type !== 'text' && column.type !== 'badge' && 'is-number')}
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, index) => (
              <tr key={index}>
                {data.columns.map((column) => (
                  <td
                    key={column.key}
                    className={cx(column.type && column.type !== 'text' && column.type !== 'badge' && 'is-number')}
                  >
                    {column.type === 'badge' && row[column.key] ? (
                      <Badge>{String(row[column.key])}</Badge>
                    ) : (
                      cell(row[column.key], column.type, locale)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChatCard>
  );
}

const TREND_TONE: Record<string, string> = { positive: 'is-positive', negative: 'is-negative', neutral: '' };

function StatsBlock({ data, context }: { data: StatsData; context: BlockContext }) {
  return (
    <section className="app-stats" aria-label={data.title}>
      {data.title && <h4 className="app-block-title">{data.title}</h4>}
      <div className="app-stats-grid">
        {data.items.map((item, index) => (
          <div key={index} className="app-stat">
            <span className="app-stat-label">{item.label}</span>
            <span className="app-stat-value">
              {typeof item.value === 'number' ? item.value.toLocaleString() : item.value}
              {item.unit && <span className="app-stat-unit">{item.unit}</span>}
            </span>
            {item.delta !== undefined && (
              <span className={cx('app-stat-delta', TREND_TONE[item.tone ?? 'neutral'])}>
                {item.trend === 'up' ? '↑' : item.trend === 'down' ? '↓' : ''} {item.delta}
              </span>
            )}
            {item.hint && <span className="app-stat-hint">{item.hint}</span>}
          </div>
        ))}
      </div>
      <Actions actions={data.actions} context={context} />
    </section>
  );
}

const BADGE_TONE: Record<CardBadgeTone, Tone> = {
  neutral: 'neutral',
  primary: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
};

function CardsBlock({ data, context }: { data: CardsData; context: BlockContext }) {
  return (
    <section className="app-cards-block" aria-label={data.title}>
      {data.title && <h4 className="app-block-title">{data.title}</h4>}
      <ul className="app-cards">
        {data.items.map((item, index) => {
          const external = item.url && /^https?:/i.test(item.url);
          const body = (
            <>
              <span className="app-card-head">
                <strong>{item.title}</strong>
                {item.badges?.map((badge) => (
                  <Badge key={badge.label} tone={BADGE_TONE[badge.tone ?? 'neutral']}>
                    {badge.label}
                  </Badge>
                ))}
              </span>
              {item.subtitle && <span className="app-card-subtitle">{item.subtitle}</span>}
              {item.fields?.length ? (
                <dl className="app-card-fields">
                  {item.fields.map((field) => (
                    <div key={field.label}>
                      <dt>{field.label}</dt>
                      <dd>{field.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </>
          );
          return (
            <li key={index}>
              {item.url ? (
                <a
                  className="app-card is-link"
                  href={item.url}
                  {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                >
                  {body}
                </a>
              ) : (
                <div className="app-card">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      <Actions actions={data.actions} context={context} />
    </section>
  );
}

const STEP_WORD: Record<
  StepStatus,
  'rich.stepDone' | 'rich.stepActive' | 'rich.stepPending' | 'rich.stepBlocked' | 'rich.stepSkipped'
> = {
  done: 'rich.stepDone',
  active: 'rich.stepActive',
  pending: 'rich.stepPending',
  blocked: 'rich.stepBlocked',
  skipped: 'rich.stepSkipped',
};

function StepsBlock({ data, context }: { data: StepsData; context: BlockContext }) {
  const { t } = useI18n();
  return (
    <ChatCard
      icon={<ListChecks size={icon.md} />}
      title={data.title ?? t('rich.steps')}
      meta={t('message.steps', { count: data.items.length })}
    >
      <ol className="app-plan">
        {data.items.map((item, index) => (
          <li key={index} className={cx('app-plan-step', `is-${item.status}`)}>
            <span className="app-plan-dot" aria-hidden />
            <span className="app-plan-text">
              <strong>{item.title}</strong>
              {item.detail && <span>{item.detail}</span>}
            </span>
            {item.time && <span className="app-step-time">{item.time}</span>}
            <span className="app-sr-only">{t(STEP_WORD[item.status])}</span>
          </li>
        ))}
      </ol>
      <Actions actions={data.actions} context={context} />
    </ChatCard>
  );
}

function HtmlPreviewBlock({ segment, context }: { segment: HtmlPreviewSegment; context: BlockContext }) {
  const { t } = useI18n();
  const notify = useNotify();
  const [open, setOpen] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const title = segment.title ?? t('rich.webPage');
  const page = useMemo(() => injectHtmlBridge(segment.code), [segment.code]);

  useEffect(() => {
    if (!open || !context.onPrompt) return;
    const listen = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const message = readHtmlBridgeMessage(event.data);
      if (!message) return;
      context.onPrompt?.(message.text);
      if (message.truncated) notify(t('rich.promptCut'));
      setOpen(false);
    };
    window.addEventListener('message', listen);
    return () => window.removeEventListener('message', listen);
  }, [open, context, notify, t]);

  return (
    <>
      <ChatCard
        icon={<FileCode2 size={icon.md} />}
        title={title}
        meta={t('rich.webPage')}
        footer={
          <>
            <Button kind="ghost" size="sm" onClick={() => setOpen(true)}>
              <Maximize2 size={icon.sm} />
              {t('rich.preview')}
            </Button>
            <Button
              kind="ghost"
              size="sm"
              onClick={() => {
                saveBlob(new Blob([segment.code], { type: 'text/html;charset=utf-8' }), `${title}.html`);
                context.onDownload?.();
              }}
            >
              <Download size={icon.sm} />
              {t('rich.download')}
            </Button>
          </>
        }
      />
      {open && (
        <Overlay title={title} wide onClose={() => setOpen(false)}>
          <iframe
            ref={frame}
            className="app-preview-frame"
            title={title}
            sandbox="allow-scripts allow-forms"
            referrerPolicy="no-referrer"
            srcDoc={page}
          />
        </Overlay>
      )}
    </>
  );
}

function Placeholder({ fence }: { fence: string }) {
  const { t } = useI18n();
  return (
    <ChatCard
      icon={<BarChart3 size={icon.md} />}
      title={t('rich.writing')}
      meta={fence}
      status={t('rich.generating')}
      tone="info"
    >
      <Skeleton lines={3} />
    </ChatCard>
  );
}

export const RichContent = memo(function RichContent({
  text,
  streaming,
  failed,
  context,
}: {
  text: string;
  streaming: boolean;
  failed?: boolean;
  context: BlockContext;
}) {
  const { t } = useI18n();
  const id = useId();
  const segments = useMemo(() => parseSegments(text), [text]);
  return (
    <>
      {segments.map((segment, index) => {
        const key = `${id}-${index}`;
        switch (segment.type) {
          case 'markdown':
            return (
              <Markdown
                key={key}
                text={segment.content}
                className={cx(
                  'is-reply-text',
                  streaming && index === segments.length - 1 && 'is-streaming',
                  failed && 'is-failed',
                )}
              />
            );
          case 'pending':
            return streaming ? (
              <Placeholder key={key} fence={segment.fence} />
            ) : (
              <Markdown key={key} text={segment.raw} />
            );
          case 'chart':
            return (
              <ChatCard key={key} icon={<BarChart3 size={icon.md} />} title={segment.data.title ?? t('rich.chart')}>
                <ChartView data={segment.data} />
              </ChatCard>
            );
          case 'datatable':
            return <TableBlock key={key} data={segment.data} context={context} />;
          case 'stats':
            return <StatsBlock key={key} data={segment.data} context={context} />;
          case 'cards':
            return <CardsBlock key={key} data={segment.data} context={context} />;
          case 'steps':
            return <StepsBlock key={key} data={segment.data} context={context} />;
          case 'confirm':
            return (
              <div key={key} className="app-confirm-block">
                <Markdown text={segment.data.text} />
                <Actions actions={segment.data.actions} context={context} />
              </div>
            );
          case 'mermaid':
            return (
              <Suspense key={key} fallback={<Skeleton lines={4} />}>
                <MermaidView code={segment.code} />
              </Suspense>
            );
          case 'html-preview':
            return <HtmlPreviewBlock key={key} segment={segment} context={context} />;
          case 'attachments':
          case 'mission-artifacts':
            return (
              <ul key={key} className="app-file-list">
                {segment.data.map((item, at) => (
                  <li key={at}>
                    <StatusBadge status={'name' in item ? item.name : item.path} tone="neutral" />
                  </li>
                ))}
              </ul>
            );
        }
      })}
    </>
  );
});
