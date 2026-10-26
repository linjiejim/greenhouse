import React, { useCallback, useState } from 'react';
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
import { myAutomations, runResult } from './model';
import { useResource } from '../data/use-resource';
import { captureIdentity } from '../data/identity';
import { PlaceSecondary } from '../shell/place-secondary.web';
import { Place, PlaceSidebar, PlaceRow, PlaceEmpty } from '../ui/place.web';
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { useStartChat } from '../shell/open-object';
import { alertError, confirmAction } from '../ui/dialogs';
export default function AutomationsPlace() {
  const { width } = useWindowDimensions();
  return width < 760 ? <Phone /> : <AutomationsDesktop />;
}
function AutomationsDesktop() {
  const t = useT(),
    router = useRouter(),
    start = useStartChat();
  const { id: given } = useLocalSearchParams<{ id?: string }>();
  const [query, setQuery] = useState(''),
    [busy, setBusy] = useState(false);
  const user = useAuth((s) => s.user);
  const list = useResource(useCallback(() => listAutomations(), []));
  const tasks = myAutomations(list.data ?? [], user?.id).filter(
    (task) => !query || task.name.toLowerCase().includes(query.toLowerCase()),
  );
  const id = given ?? tasks[0]?.id;
  const detail = useResource(
    useCallback(() => (id ? getAutomation(id) : Promise.resolve({ ok: true as const, data: null })), [id]),
  );
  const runs = useResource(
    useCallback(() => (id ? listAutomationRuns(id) : Promise.resolve({ ok: true as const, data: [] })), [id]),
  );
  const task = detail.data?.task;
  const write = async (action: 'toggle' | 'run' | 'delete') => {
    if (!task || busy) return;
    const current = captureIdentity();
    if (
      action === 'delete' &&
      !(await confirmAction({
        title: t('library.deleteTitle', { name: task.name }),
        destructive: true,
        confirmLabel: t('library.delete'),
      }))
    )
      return;
    if (!current()) return;
    setBusy(true);
    const r =
      action === 'run'
        ? await runAutomationNow(task.id)
        : action === 'toggle'
          ? await setAutomationEnabled(task.id, !task.enabled)
          : await deleteAutomation(task.id);
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
      if (action === 'delete') router.setParams({ id: undefined });
    }
  };
  return (
    <>
      <PlaceSecondary>
        <PlaceSidebar
          title={t('nav.automations')}
          query={query}
          onQuery={setQuery}
          action={
            <button aria-label={t('places.newAutomation')} onClick={() => start(t('places.createAutomation'))}>
              +
            </button>
          }
        >
          <div data-place-list>
            {[true, false].map((enabled) => (
              <React.Fragment key={String(enabled)}>
                <h3>{t(enabled ? 'places.active' : 'places.paused')}</h3>
                {tasks
                  .filter((task) => task.enabled === enabled)
                  .map((task) => (
                    <PlaceRow
                      key={task.id}
                      title={task.name}
                      detail={
                        task.next_run_at
                          ? new Date(task.next_run_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                          : undefined
                      }
                      icon="clock"
                      selected={task.id === id}
                      onOpen={() => router.setParams({ id: task.id })}
                      items={[{ id: 'open', title: t('client.openInspector'), icon: 'open' }]}
                      onSelect={() => router.setParams({ id: task.id })}
                    />
                  ))}
              </React.Fragment>
            ))}
          </div>
        </PlaceSidebar>
      </PlaceSecondary>
      <Place
        title={task?.name ?? t('nav.automations')}
        actions={
          task ? (
            <>
              <button disabled={busy} onClick={() => void write('toggle')}>
                {t(task.enabled ? 'places.pause' : 'places.resume')}
              </button>
              <button className="gh-primary" disabled={busy} onClick={() => void write('run')}>
                {t('places.runNow')}
              </button>
              <button aria-label={t('library.delete')} disabled={busy} onClick={() => void write('delete')}>
                ⋯
              </button>
            </>
          ) : null
        }
      >
        <div className="gh-place-scroll">
          <div className="gh-automation">
            {!task ? (
              <PlaceEmpty
                loading={detail.loading || list.loading}
                error={detail.error?.message}
                retry={() => void detail.refresh()}
              />
            ) : (
              <>
                <section className="gh-automation-card">
                  <small>{t('places.instructions')}</small>
                  <p>{task.task_prompt}</p>
                  <div className="gh-doc-meta">
                    ◷ {task.schedule} · {task.timezone} · {task.profile_id}
                  </div>
                  <button onClick={() => start(t('places.modifyAutomation', { name: task.name }))}>
                    {t('places.askModify')}
                  </button>
                </section>
                <header className="gh-place-bar">
                  <strong>{t('places.runs')}</strong>
                  <small>
                    {t('places.nextRun')} {task.next_run_at ? new Date(task.next_run_at).toLocaleString() : '—'}
                  </small>
                </header>
                <section className="gh-automation-card" data-place-list>
                  {runs.data?.map((run) => (
                    <PlaceRow
                      key={run.session_id}
                      title={`${runResult(run) === 'failed' ? '●' : '●'} ${new Date(run.created_at).toLocaleString()}`}
                      detail={run.title ?? run.run?.status}
                      icon="msg"
                      onOpen={() => router.push({ pathname: '/chat', params: { session: run.session_id } })}
                    />
                  ))}
                  {!runs.data?.length ? (
                    <PlaceEmpty loading={runs.loading} error={runs.error?.message} retry={() => void runs.refresh()} />
                  ) : null}
                </section>
              </>
            )}
          </div>
        </div>
      </Place>
    </>
  );
}
