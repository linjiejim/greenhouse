/**
 * 定时任务 in the wide browser. The secondary column holds two sections: my automations (active,
 * then paused) and custom agents (mine, then the team's). The main column shows the one chosen:
 * an automation (`/automations?id=`) with its instructions, schedule and run history, or an agent
 * (`/automations?view=agents&id=<row id>`). Automations and agents are created, edited and
 * duplicated in fixed-size dialogs (./editor.web.tsx, ./agent-editor.web.tsx); asking Sprouty
 * stays the second way to make or change one. Below 760 px the phone screen shows; an editor
 * already open there continues as a full-screen sheet.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { dateTimeLabel } from '../lib/time-words';
import { Icon } from '../ui/core';
import { useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Phone from './phone-screen';
import {
  listAutomations,
  getAutomation,
  listAutomationRuns,
  setAutomationEnabled,
  runAutomationNow,
  deleteAutomation,
} from '../api/automations';
import { deleteCustomAgent, findProfile, listCustomAgents, listProfiles, profileName } from '../api/profiles';
import { myAutomations, runResult, type Automation } from './model';
import { agentGroups, agentRowId, automationsUsing, copyName, type CustomAgent } from './agents';
import { AgentDetail } from './agent-detail.web';
import { AgentEditor, type AgentEditorMode } from './agent-editor.web';
import { AutomationEditor, type AutomationEditorMode } from './editor.web';
import { scheduleLabel } from './words';
import { useResource } from '../data/use-resource';
import { captureIdentity } from '../data/identity';
import { PlaceSecondary } from '../shell/place-secondary.web';
import { Place, PlaceSidebar, PlaceRow, PlaceEmpty } from '../ui/place.web';
import { NativeMenu } from '../ui/menu.web';
import type { MenuItem } from '../ui/menu-items';
import { useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import { useT } from '../lib/i18n';
import { useStartChat } from '../shell/open-object';
import { alertError, confirmAction } from '../ui/dialogs';
import { toast } from '../ui/toast';
import './automations.css';

type Editor =
  | { kind: 'automation'; mode: AutomationEditorMode }
  | { kind: 'agent'; mode: AgentEditorMode; mine: CustomAgent[] };
type Saved = { kind: 'automation' | 'agent'; id: string; n: number };

export default function AutomationsPlace() {
  const { width } = useWindowDimensions();
  const router = useRouter();
  // The open editor and the last save live here, so a window narrowing mid-edit keeps the draft.
  const [editor, setEditor] = useState<Editor | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);
  const close = useCallback(() => setEditor(null), []);
  return (
    <>
      {width < 760 ? <Phone /> : <AutomationsDesktop openEditor={setEditor} saved={saved} />}
      {editor?.kind === 'automation' ? (
        <AutomationEditor
          mode={editor.mode}
          onClose={close}
          onSaved={(task) => {
            setEditor(null);
            setSaved((s) => ({ kind: 'automation', id: task.id, n: (s?.n ?? 0) + 1 }));
          }}
          onManageAgents={() => {
            setEditor(null);
            router.setParams({ view: 'agents', id: undefined });
          }}
        />
      ) : null}
      {editor?.kind === 'agent' ? (
        <AgentEditor
          mode={editor.mode}
          mine={editor.mine}
          onClose={close}
          onSaved={(agent) => {
            setEditor(null);
            setSaved((s) => ({ kind: 'agent', id: agentRowId(agent.id), n: (s?.n ?? 0) + 1 }));
          }}
        />
      ) : null}
    </>
  );
}

function AutomationsDesktop({ openEditor, saved }: { openEditor: (editor: Editor) => void; saved: Saved | null }) {
  const t = useT(),
    router = useRouter(),
    start = useStartChat(),
    lang = usePrefs((s) => s.lang);
  const params = useLocalSearchParams<{ id?: string; view?: string }>();
  const view = params.view === 'agents' ? 'agents' : 'automations';
  const [query, setQuery] = useState(''),
    [busy, setBusy] = useState(false);
  const user = useAuth((s) => s.user);
  const list = useResource(useCallback(() => listAutomations(), []));
  const agentsRes = useResource(useCallback(() => listCustomAgents(), []));
  const profiles = useResource(useCallback(() => listProfiles(), []));
  const matches = (name: string) => !query || name.toLowerCase().includes(query.toLowerCase());
  const mineAll = useMemo(() => myAutomations(list.data ?? [], user?.id), [list.data, user?.id]);
  const tasks = mineAll.filter((task) => matches(task.name));
  const groups = useMemo(() => agentGroups(agentsRes.data ?? [], user?.id), [agentsRes.data, user?.id]);
  const mineAgents = groups.mine.filter((agent) => matches(agent.name));
  const sharedAgents = groups.shared.filter((agent) => matches(agent.name));

  const id = view === 'automations' ? (params.id ?? tasks[0]?.id) : undefined;
  const agent =
    view === 'agents'
      ? ([...groups.mine, ...groups.shared].find((a) => agentRowId(a.id) === params.id) ??
        (params.id ? null : (mineAgents[0] ?? sharedAgents[0] ?? null)))
      : null;

  const detail = useResource(
    useCallback(() => (id ? getAutomation(id) : Promise.resolve({ ok: true as const, data: null })), [id]),
  );
  const runs = useResource(
    useCallback(() => (id ? listAutomationRuns(id) : Promise.resolve({ ok: true as const, data: [] })), [id]),
  );
  const task = detail.data?.task;

  // after a save: reload what changed and show the saved one
  useEffect(() => {
    if (!saved) return;
    if (saved.kind === 'automation') {
      void list.refresh();
      router.setParams({ view: undefined, id: saved.id });
      void detail.refresh();
    } else {
      void agentsRes.refresh();
      void profiles.refresh();
      router.setParams({ view: 'agents', id: saved.id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per save
  }, [saved]);

  const editAutomation = (mode: AutomationEditorMode) => openEditor({ kind: 'automation', mode });
  const editAgent = (mode: AgentEditorMode) => openEditor({ kind: 'agent', mode, mine: groups.mine });
  const duplicateAgent = (source: CustomAgent) =>
    editAgent({
      kind: 'duplicate',
      agent: source,
      name: copyName(source.name, groups.mine, { one: t('agents.copyName'), many: t('agents.copyNameN') }),
    });

  const write = async (target: Automation, action: 'toggle' | 'run' | 'delete') => {
    if (busy) return;
    const current = captureIdentity();
    if (
      action === 'delete' &&
      !(await confirmAction({
        title: t('automations.deleteTitle', { name: target.name }),
        message: t('automations.deleteHint'),
        destructive: true,
        confirmLabel: t('automations.delete'),
      }))
    )
      return;
    if (!current()) return;
    setBusy(true);
    const r =
      action === 'run'
        ? await runAutomationNow(target.id)
        : action === 'toggle'
          ? await setAutomationEnabled(target.id, !target.enabled)
          : await deleteAutomation(target.id);
    if (!current()) return;
    setBusy(false);
    if (!r.ok) {
      alertError(t('library.failed'), r.message);
      return;
    }
    if (action === 'run' && 'session_id' in r.data)
      router.push({ pathname: '/chat', params: { session: String(r.data.session_id) } });
    else {
      void list.refresh();
      void detail.refresh();
      if (action === 'delete') {
        toast(t('automations.deleted'));
        router.setParams({ id: undefined });
      }
    }
  };

  const removeAgent = async (target: CustomAgent) => {
    const current = captureIdentity();
    const used = automationsUsing(target.id, mineAll);
    if (
      !(await confirmAction({
        title: t('agents.deleteTitle', { name: target.name }),
        message: used ? t('agents.deleteHintUsed', { n: used }) : t('agents.deleteHint'),
        destructive: true,
        confirmLabel: t('agents.delete'),
      }))
    )
      return;
    if (!current()) return;
    const r = await deleteCustomAgent(agentRowId(target.id));
    if (!current()) return;
    if (!r.ok) {
      alertError(t('agents.deleteFailed'), r.message);
      return;
    }
    toast(t('agents.deleted'));
    void agentsRes.refresh();
    void profiles.refresh();
    router.setParams({ view: 'agents', id: undefined });
  };

  const automationItems = (target: Automation): MenuItem[] => [
    { id: 'edit', title: t('automations.edit'), icon: 'pen' },
    { id: 'duplicate', title: t('automations.duplicate'), icon: 'copy' },
    {
      id: 'toggle',
      title: t(target.enabled ? 'places.pause' : 'places.resume'),
      icon: target.enabled ? 'sleep' : 'clock',
    },
    { id: 'delete', title: t('automations.delete'), icon: 'trash', destructive: true },
  ];
  const onAutomationItem = (target: Automation, item: string) => {
    if (item === 'edit') editAutomation({ kind: 'edit', task: target });
    else if (item === 'duplicate') editAutomation({ kind: 'duplicate', task: target });
    else if (item === 'toggle' || item === 'delete') void write(target, item);
  };
  const agentItems = (target: CustomAgent, own: boolean): MenuItem[] =>
    own
      ? [
          { id: 'edit', title: t('agents.edit'), icon: 'pen' },
          { id: 'duplicate', title: t('agents.duplicate'), icon: 'copy' },
          { id: 'delete', title: t('agents.delete'), icon: 'trash', destructive: true },
        ]
      : [{ id: 'duplicate', title: t('agents.duplicate'), icon: 'copy' }];
  const onAgentItem = (target: CustomAgent, item: string) => {
    if (item === 'edit') editAgent({ kind: 'edit', agent: target });
    else if (item === 'duplicate') duplicateAgent(target);
    else if (item === 'delete') void removeAgent(target);
  };

  const runsAs = (profileId: string) => {
    const found = findProfile(profiles.data ?? [], profileId);
    return found ? profileName(found, lang) : profileId.startsWith('custom:') ? t('automations.runsAsGone') : profileId;
  };

  const automationRow = (row: Automation) => (
    <PlaceRow
      key={row.id}
      title={row.name}
      detail={row.next_run_at ? dateTimeLabel(row.next_run_at) : undefined}
      icon="clock"
      selected={view === 'automations' && row.id === id}
      onOpen={() => router.setParams({ view: undefined, id: row.id })}
      items={automationItems(row)}
      onSelect={(item) => onAutomationItem(row, item)}
    />
  );
  const agentRow = (row: CustomAgent, own: boolean) => (
    <PlaceRow
      key={row.id}
      title={row.name}
      icon="sparkle"
      selected={view === 'agents' && agent?.id === row.id}
      onOpen={() => router.setParams({ view: 'agents', id: agentRowId(row.id) })}
      items={agentItems(row, own)}
      onSelect={(item) => onAgentItem(row, item)}
    />
  );

  return (
    <>
      <PlaceSecondary>
        <PlaceSidebar
          title={t('nav.automations')}
          query={query}
          onQuery={setQuery}
          action={
            <button aria-label={t('places.newAutomation')} onClick={() => editAutomation({ kind: 'new' })}>
              <Icon name="plus" size={18} />
            </button>
          }
        >
          <div data-place-list data-testid="automations-sections">
            <div className="gh-auto-heading">
              <h3>{t('automations.section')}</h3>
            </div>
            {[true, false].map((enabled) =>
              tasks.some((row) => row.enabled === enabled) ? (
                <React.Fragment key={String(enabled)}>
                  <div className="gh-auto-subheading">{t(enabled ? 'places.active' : 'places.paused')}</div>
                  {tasks.filter((row) => row.enabled === enabled).map(automationRow)}
                </React.Fragment>
              ) : null,
            )}
            <div className="gh-auto-heading">
              <h3>{t('agents.section')}</h3>
              <button aria-label={t('agents.new')} onClick={() => editAgent({ kind: 'new' })}>
                <Icon name="plus" size={16} />
              </button>
            </div>
            {mineAgents.map((row) => agentRow(row, true))}
            {sharedAgents.length ? <div className="gh-auto-subheading">{t('agents.shared')}</div> : null}
            {sharedAgents.map((row) => agentRow(row, false))}
          </div>
        </PlaceSidebar>
      </PlaceSecondary>
      {view === 'agents' ? (
        <AgentDetail
          agent={agent}
          mine={!!agent && agent.user_id === user?.id}
          isSuper={user?.role === 'super'}
          loading={agentsRes.loading}
          error={agentsRes.error?.message ?? null}
          retry={() => void agentsRes.refresh()}
          usedBy={agent ? mineAll.filter((row) => automationsUsing(agent.id, [row]) > 0) : []}
          empty={
            !agentsRes.loading && !agentsRes.error && !params.id && !groups.mine.length && !groups.shared.length ? (
              <PlaceEmpty
                icon="sparkle"
                title={t('agents.empty')}
                message={t('agents.emptyHint')}
                action={
                  <button className="gh-primary" onClick={() => editAgent({ kind: 'new' })}>
                    {t('agents.new')}
                  </button>
                }
              />
            ) : !agentsRes.loading && !agentsRes.error && params.id ? (
              <PlaceEmpty icon="sparkle" title={t('agents.notFound')} />
            ) : null
          }
          onEdit={() => agent && editAgent({ kind: 'edit', agent })}
          onDuplicate={() => agent && duplicateAgent(agent)}
          onDelete={() => agent && void removeAgent(agent)}
          onChanged={() => {
            void agentsRes.refresh();
            void profiles.refresh();
          }}
          onOpenAutomation={(next) => router.setParams({ view: undefined, id: next })}
        />
      ) : (
        <Place
          title={task?.name ?? t('nav.automations')}
          actions={
            task ? (
              <>
                <button disabled={busy} onClick={() => editAutomation({ kind: 'edit', task })}>
                  {t('automations.edit')}
                </button>
                <button disabled={busy} onClick={() => void write(task, 'toggle')}>
                  {t(task.enabled ? 'places.pause' : 'places.resume')}
                </button>
                <button className="gh-primary" disabled={busy} onClick={() => void write(task, 'run')}>
                  {t('places.runNow')}
                </button>
                <NativeMenu
                  items={[
                    { id: 'duplicate', title: t('automations.duplicate'), icon: 'copy' },
                    { id: 'ask', title: t('places.askModify'), icon: 'sparkle' },
                    { id: 'delete', title: t('automations.delete'), icon: 'trash', destructive: true },
                  ]}
                  onSelect={(item) =>
                    item === 'ask'
                      ? start(t('places.modifyAutomation', { name: task.name }))
                      : onAutomationItem(task, item)
                  }
                >
                  <button aria-label={t('automations.moreActions')} disabled={busy}>
                    <Icon name="more" size={18} />
                  </button>
                </NativeMenu>
              </>
            ) : null
          }
        >
          <div className="gh-place-scroll">
            <div className="gh-automation">
              {!task ? (
                <PlaceEmpty
                  loading={detail.loading || list.loading}
                  error={detail.error?.message ?? list.error?.message}
                  retry={() => void (list.error ? list.refresh() : detail.refresh())}
                  {...(!query && !mineAll.length
                    ? {
                        icon: 'clock' as const,
                        title: t('automations.empty'),
                        message: t('automations.emptyFormHint'),
                        action: (
                          <div className="gh-auto-empty-actions">
                            <button className="gh-primary" onClick={() => editAutomation({ kind: 'new' })}>
                              {t('places.newAutomation')}
                            </button>
                            <button onClick={() => start(t('places.createAutomation'))}>
                              {t('automations.askSprouty')}
                            </button>
                          </div>
                        ),
                      }
                    : {})}
                />
              ) : (
                <>
                  <section className="gh-automation-card">
                    <small>{t('places.instructions')}</small>
                    <p>{task.task_prompt}</p>
                    <div className="gh-doc-meta">
                      <span>◷ {scheduleLabel(task.schedule, task.timezone)}</span>·<span>{task.timezone}</span>·
                      <span>{runsAs(task.profile_id)}</span>
                    </div>
                    <button onClick={() => start(t('places.modifyAutomation', { name: task.name }))}>
                      {t('places.askModify')}
                    </button>
                  </section>
                  <header className="gh-place-bar">
                    <strong>{t('places.runs')}</strong>
                    <small>
                      {t('places.nextRun')} {task.next_run_at ? dateTimeLabel(task.next_run_at) : '—'}
                    </small>
                  </header>
                  <section className="gh-automation-card" data-place-list>
                    {runs.data?.map((run) => (
                      <PlaceRow
                        key={run.session_id}
                        title={`${runResult(run) === 'failed' ? '●' : '●'} ${dateTimeLabel(run.created_at)}`}
                        detail={run.title ?? run.run?.status}
                        icon="msg"
                        onOpen={() => router.push({ pathname: '/chat', params: { session: run.session_id } })}
                      />
                    ))}
                    {!runs.data?.length ? (
                      <PlaceEmpty
                        loading={runs.loading}
                        error={runs.error?.message}
                        retry={() => void runs.refresh()}
                      />
                    ) : null}
                  </section>
                </>
              )}
            </div>
          </div>
        </Place>
      )}
    </>
  );
}
