/**
 * The computer's background processes — long jobs started with `gh-jobs`
 * (a Bot's run_background, or the member in the terminal): what runs, how
 * each ended, its log, and Stop (with a confirmation).
 *
 * While the tab shows and a job runs, the list (and the open log) refresh
 * every 3 s, paused in a background tab; a job's final output is read once
 * more when it ends. Logs come redacted from the server; the viewer only makes
 * terminal output readable (colour codes dropped, `\r` progress lines
 * collapsed to their last state).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ComputerProcessLog, ComputerProcessView } from '@greenhouse/types/bots';
import { Button, ConfirmDialog, EmptyState, IconButton, Spinner, StatusDot, Tag, toast, type TagTone } from '../ui';
import { Activity, AlertTriangle, ArrowLeft, CircleStop, RefreshCw, ScrollText } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import {
  fetchComputerProcessLog,
  isBotsApiError,
  listComputerProcesses,
  stopComputerProcess,
} from '../../lib/api/bots';
import { formatDate, timeAgo } from '../../lib/utils';
import { computerErrorKey, computerErrorText } from './computer-pane';

/** How often a running job's list entry and open log refresh. */
export const PROCESS_REFRESH_MS = 3_000;

const ESC = String.fromCharCode(27);
/** CSI / OSC escape sequences (colours, cursor moves, titles). */
const ANSI_SEQUENCE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${ESC}\\u0007]*(?:\\u0007|${ESC}\\\\)?|[@-Z\\\\-_])`,
  'g',
);

/** Terminal output as plain text: no escape codes, a `\r`-redrawn line shows its last state. */
export function readableLog(text: string): string {
  return text
    .replace(ANSI_SEQUENCE, '')
    .split('\n')
    .map((line) => {
      const redraws = line.replace(/\r+$/, '').split('\r');
      return redraws[redraws.length - 1] ?? '';
    })
    .join('\n');
}

type Translate = ReturnType<typeof useT>;

function statusOf(process: ComputerProcessView, t: Translate): { label: string; tone: TagTone; title?: string } {
  if (process.status === 'running') return { label: t('botsComputer.proc_running'), tone: 'info' };
  if (process.status === 'lost') {
    return { label: t('botsComputer.proc_lost'), tone: 'warning', title: t('botsComputer.proc_lostHint') };
  }
  if (process.exit_code === null) return { label: t('botsComputer.proc_ended'), tone: 'neutral' };
  return {
    label: t('botsComputer.proc_exitCode', { code: process.exit_code }),
    tone: process.exit_code === 0 ? 'success' : 'danger',
  };
}

function ProcessStatus({ process }: { process: ComputerProcessView }) {
  const t = useT();
  const status = statusOf(process, t);
  return (
    <Tag
      tone={status.tone}
      size="xs"
      title={status.title}
      icon={process.status === 'running' ? <StatusDot color="info" size="sm" pulse className="mr-0.5" /> : undefined}
    >
      {status.label}
    </Tag>
  );
}

export interface ComputerProcessesProps {
  /** The Processes tab is the one showing: refresh, and keep refreshing while a job runs. */
  active: boolean;
  /** A call found the computer stopped: let the owner refresh its status. */
  onStale?: () => void;
}

export function ComputerProcesses({ active, onStale }: ComputerProcessesProps) {
  const t = useT();
  const [processes, setProcesses] = useState<ComputerProcessView[] | null>(null);
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [log, setLog] = useState<ComputerProcessLog | null>(null);
  const [logFailed, setLogFailed] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState<ComputerProcessView | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const onStaleRef = useRef(onStale);
  onStaleRef.current = onStale;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadList = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await listComputerProcesses();
      if (!mounted.current) return;
      setProcesses(next);
      setLoadFailed(null);
    } catch (err) {
      if (!mounted.current) return;
      if (isBotsApiError(err, 'stopped')) onStaleRef.current?.();
      setLoadFailed(computerErrorText(t, err, 'botsComputer.proc_loadFailed'));
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [t]);

  const openIdRef = useRef(openId);
  openIdRef.current = openId;
  const loadLog = useCallback(
    async (id: string) => {
      try {
        const next = await fetchComputerProcessLog(id);
        if (!mounted.current || openIdRef.current !== id) return;
        setLog(next);
        setLogFailed(null);
      } catch (err) {
        if (mounted.current && openIdRef.current === id) {
          setLogFailed(computerErrorText(t, err, 'botsComputer.proc_logFailed'));
        }
      }
    },
    [t],
  );

  const open = processes?.find((process) => process.id === openId) ?? null;
  const anyRunning = processes?.some((process) => process.status === 'running') ?? false;
  const openStatus = open?.status;

  // Shown (again): the jobs may have changed meanwhile.
  useEffect(() => {
    if (active) void loadList();
  }, [active, loadList]);

  // The open log: on opening, and once more when its job ends (the last output).
  useEffect(() => {
    if (active && openId) void loadLog(openId);
  }, [active, openId, openStatus, loadLog]);

  // While a job runs: refresh the list (to see it end) and the open log every 3 s.
  useEffect(() => {
    if (!active || !anyRunning) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadList();
      const id = openIdRef.current;
      if (id && openStatus === 'running') void loadLog(id);
    }, PROCESS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, anyRunning, openStatus, loadList, loadLog]);

  const showLog = (id: string | null) => {
    setLog(null);
    setLogFailed(null);
    setOpenId(id);
  };

  const stop = async (process: ComputerProcessView) => {
    setConfirmStop(null);
    setStopping(process.id);
    try {
      const { stopped } = await stopComputerProcess(process.id);
      toast(
        stopped
          ? t('botsComputer.proc_stopped', { name: process.name })
          : t('botsComputer.proc_alreadyEnded', { name: process.name }),
        stopped ? 'success' : 'info',
      );
    } catch (err) {
      if (isBotsApiError(err, 'stopped')) onStaleRef.current?.();
      const shared = computerErrorKey(err);
      toast(shared ? t(shared) : t('botsComputer.proc_stopFailed', { name: process.name }), 'error');
    } finally {
      if (mounted.current) setStopping(null);
      void loadList();
    }
  };

  let body: ReactNode;
  if (open) {
    body = (
      <ProcessLog
        process={open}
        log={log}
        failed={logFailed}
        live={active && open.status === 'running'}
        stopping={stopping === open.id}
        onBack={() => showLog(null)}
        onRefresh={() => {
          void loadList();
          void loadLog(open.id);
        }}
        onStop={() => setConfirmStop(open)}
      />
    );
  } else if (!processes) {
    body = loadFailed ? (
      <EmptyState
        variant="compact"
        tone="danger"
        icon={AlertTriangle}
        title={loadFailed}
        action={
          <Button size="sm" variant="outline" onClick={() => void loadList()}>
            {t('botsComputer.retry')}
          </Button>
        }
      />
    ) : (
      <div className="flex justify-center py-8" role="status" aria-label={t('common.loading')}>
        <Spinner />
      </div>
    );
  } else if (processes.length === 0) {
    body = (
      <EmptyState
        variant="compact"
        tone="neutral"
        icon={Activity}
        title={t('botsComputer.proc_emptyTitle')}
        description={t('botsComputer.proc_emptyDesc')}
      />
    );
  } else {
    body = (
      <>
        <div className="flex items-center justify-end">
          <IconButton label={t('botsComputer.refresh')} onClick={() => void loadList()} tooltip="top">
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          </IconButton>
        </div>
        <ul
          className="min-h-0 flex-1 divide-y divide-edge overflow-y-auto rounded-lg border border-edge"
          data-testid="computer-process-list"
        >
          {processes.map((process) => (
            <li
              key={process.id}
              className="flex items-center gap-1 pl-3 pr-1 transition-colors hover:bg-surface-muted"
              data-testid="computer-process-row"
              data-status={process.status}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 flex-col gap-1 py-2 text-left"
                onClick={() => showLog(process.id)}
                aria-label={t('botsComputer.proc_viewLogOf', { name: process.name })}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-medium text-fg" title={process.name}>
                    {process.name}
                  </span>
                  <ProcessStatus process={process} />
                </span>
                <span className="block truncate font-mono text-[11px] text-fg-muted" title={process.command}>
                  {process.command}
                </span>
                <span className="text-[11px] text-fg-faint" title={formatDate(process.started_at)}>
                  {t('botsComputer.proc_started', { time: timeAgo(process.started_at) })}
                </span>
              </button>
              {process.status === 'running' && (
                <IconButton
                  label={t('botsComputer.proc_stopOf', { name: process.name })}
                  variant="destructive"
                  onClick={() => setConfirmStop(process)}
                  disabled={stopping === process.id}
                  tooltip="top"
                  data-testid="computer-process-stop"
                >
                  {stopping === process.id ? <Spinner className="h-3.5 w-3.5" /> : <CircleStop size={15} />}
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="computer-processes">
      {body}
      <ConfirmDialog
        open={confirmStop !== null}
        onClose={() => setConfirmStop(null)}
        onConfirm={() => {
          if (confirmStop) void stop(confirmStop);
        }}
        title={t('botsComputer.proc_stopTitle', { name: confirmStop?.name ?? '' })}
        description={t('botsComputer.proc_stopDesc')}
        confirmLabel={t('botsComputer.proc_stop')}
        confirmVariant="destructive"
      />
    </div>
  );
}

function ProcessLog({
  process,
  log,
  failed,
  live,
  stopping,
  onBack,
  onRefresh,
  onStop,
}: {
  process: ComputerProcessView;
  log: ComputerProcessLog | null;
  /** Why the log could not be read (null: it could). */
  failed: string | null;
  live: boolean;
  stopping: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onStop: () => void;
}) {
  const t = useT();
  const preRef = useRef<HTMLPreElement>(null);
  const following = useRef(true);
  const text = log ? readableLog(log.text) : '';

  // Follow the end of the log, unless the member scrolled up to read.
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (pre && following.current) pre.scrollTop = pre.scrollHeight;
  }, [text]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="computer-process-log" data-process-id={process.id}>
      <div className="flex items-center gap-1">
        <IconButton label={t('botsComputer.proc_back')} onClick={onBack} tooltip="top">
          <ArrowLeft size={16} />
        </IconButton>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg" title={process.name}>
          {process.name}
        </span>
        <ProcessStatus process={process} />
        <IconButton label={t('botsComputer.refresh')} onClick={onRefresh} tooltip="top">
          <RefreshCw size={14} />
        </IconButton>
        {process.status === 'running' && (
          <Button
            size="sm"
            variant="outline"
            onClick={onStop}
            disabled={stopping}
            className="ml-1"
            data-testid="computer-process-stop"
          >
            {stopping ? <Spinner className="mr-1" /> : <CircleStop size={14} className="mr-1" aria-hidden="true" />}
            {t('botsComputer.proc_stop')}
          </Button>
        )}
      </div>
      <div className="space-y-0.5 text-[11px] text-fg-faint">
        <p className="truncate font-mono text-fg-muted" title={process.command}>
          {process.command}
        </p>
        <p>
          <span title={formatDate(process.started_at)}>
            {t('botsComputer.proc_started', { time: timeAgo(process.started_at) })}
          </span>
          {process.ended_at && (
            <span title={formatDate(process.ended_at)}>
              {' · '}
              {t('botsComputer.proc_endedAt', { time: timeAgo(process.ended_at) })}
            </span>
          )}
          {process.status === 'lost' && <span>{` · ${t('botsComputer.proc_lostHint')}`}</span>}
        </p>
      </div>
      {failed && !log ? (
        <EmptyState
          variant="compact"
          tone="danger"
          icon={AlertTriangle}
          title={failed}
          action={
            <Button size="sm" variant="outline" onClick={onRefresh}>
              {t('botsComputer.retry')}
            </Button>
          }
        />
      ) : !log ? (
        <div className="flex justify-center py-8" role="status" aria-label={t('common.loading')}>
          <Spinner />
        </div>
      ) : (
        <pre
          ref={preRef}
          onScroll={(event) => {
            const pre = event.currentTarget;
            following.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
          }}
          className="min-h-[200px] flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-edge bg-surface-sunken p-2.5 font-mono text-[11px] leading-[1.45] text-fg-secondary"
          aria-label={t('botsComputer.proc_viewLog')}
          data-testid="computer-process-log-text"
        >
          {text || <span className="text-fg-faint">{t('botsComputer.proc_logEmpty')}</span>}
        </pre>
      )}
      {(live || log?.truncated) && (
        <p className="flex items-center gap-1.5 text-[11px] text-fg-faint">
          {live && (
            <>
              <ScrollText size={12} aria-hidden="true" />
              {t('botsComputer.proc_logLive')}
            </>
          )}
          {live && log?.truncated && ' · '}
          {log?.truncated && t('botsComputer.proc_logTruncated')}
        </p>
      )}
    </div>
  );
}
