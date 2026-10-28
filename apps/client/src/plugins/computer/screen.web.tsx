/**
 * Computer (browser place): my cloud computer's state in words with its one action (start or
 * stop), this month's minutes and their price, and the idle rule. A station without computers
 * says why and who can change it. There is no live view: the plugin runs no desktop or VNC.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { captureIdentity } from '../../data/identity';
import { useResource } from '../../data/use-resource';
import { localeOf, useT } from '../../lib/i18n';
import { relativeTimeNow } from '../../lib/time-words';
import { usePrefs } from '../../store/prefs';
import { Icon } from '../../ui/core';
import { alertError, confirmAction } from '../../ui/dialogs';
import { Place, PlaceEmpty } from '../../ui/place.web';
import { toast } from '../../ui/toast';
import { myComputer, startComputer, stopComputer } from './api';
import { canStart, canStop, computerCosts, computerState, startRefusal, TRANSITION_POLL_MS } from './model';
import '../app-pages.css';

export function ComputerScreen({ title }: { title: string }) {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const report = useResource(useCallback(() => myComputer(), []));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const refresh = () => void report.refresh();
    window.addEventListener('greenhouse:refresh', refresh);
    return () => window.removeEventListener('greenhouse:refresh', refresh);
  });
  const { data, refresh } = report;
  const state = data ? computerState(data) : null;
  const costs = data ? computerCosts(data, localeOf(lang)) : null;
  // A computer on its way up or down settles within seconds: look again until it has.
  useEffect(() => {
    if (state !== 'starting' && state !== 'stopping') return;
    const timer = setTimeout(() => void refresh(), TRANSITION_POLL_MS);
    return () => clearTimeout(timer);
  }, [state, data, refresh]);

  const start = async () => {
    const current = captureIdentity();
    setBusy(true);
    const r = await startComputer();
    if (!current()) return;
    setBusy(false);
    if (!r.ok) {
      const refusal = startRefusal(r.code);
      alertError(t('appPages.computer.startFailed'), refusal ? t(`appPages.computer.refusal.${refusal}`) : r.message);
    } else toast(t(r.data.started ? 'appPages.computer.started' : 'appPages.computer.alreadyRunning'));
    void report.refresh();
  };
  const stop = async () => {
    const current = captureIdentity();
    const ok = await confirmAction({
      title: t('appPages.computer.stopTitle'),
      message: t('appPages.computer.stopHint'),
      confirmLabel: t('appPages.computer.stop'),
      destructive: true,
    });
    if (!ok || !current()) return;
    setBusy(true);
    const r = await stopComputer();
    if (!current()) return;
    setBusy(false);
    if (!r.ok) alertError(t('appPages.computer.stopFailed'), r.message);
    else toast(t('appPages.computer.stopped'));
    void report.refresh();
  };

  return (
    <Place
      title={title}
      actions={
        <button onClick={() => void report.refresh()} disabled={report.loading} aria-label={t('common.refresh')}>
          <Icon name="refresh" size={16} />
        </button>
      }
    >
      <div className="gh-place-scroll">
        {!data || !state ? (
          <PlaceEmpty
            loading={report.loading}
            error={report.error ? report.error.message || t('places.pluginError') : null}
            retry={report.error?.status === 403 ? undefined : () => void report.refresh()}
          />
        ) : (
          <div className="gh-app-page" data-testid="computer-page">
            <p className="gh-hint">{t('appPages.computer.intro')}</p>
            <section className="gh-card" data-testid="computer-status">
              <div className="gh-app-hero">
                <span className="gh-app-tile">
                  <Icon name="computer" size={24} color="var(--gh-accent-text)" />
                </span>
                <div className="gh-app-hero-text">
                  <strong>{t(`appPages.computer.state.${state}`)}</strong>
                  <p>
                    {state === 'running' && data.computer
                      ? t('appPages.computer.stateHint.running', {
                          started: relativeTimeNow(data.computer.started_at),
                          used: relativeTimeNow(data.computer.last_used_at),
                        })
                      : t(`appPages.computer.stateHint.${state}`)}
                  </p>
                </div>
                {canStart(state) ? (
                  <button className="gh-primary" disabled={busy} onClick={() => void start()}>
                    {t('appPages.computer.start')}
                  </button>
                ) : canStop(state) ? (
                  <button className="gh-secondary-button gh-danger" disabled={busy} onClick={() => void stop()}>
                    {t('appPages.computer.stop')}
                  </button>
                ) : null}
              </div>
            </section>
            <section className="gh-card" data-testid="computer-usage">
              <header>
                <Icon name="pricing" size={16} />
                <strong>{t('appPages.computer.usage')}</strong>
              </header>
              <dl className="gh-app-facts">
                <div>
                  <dt>{t('appPages.computer.thisMonth')}</dt>
                  <dd>
                    {t('appPages.computer.minutes', { n: data.minutes_this_month })}
                    {costs ? <small>{t('appPages.computer.about', { amount: costs.thisMonth })}</small> : null}
                  </dd>
                </div>
                <div>
                  <dt>{t('appPages.computer.price')}</dt>
                  <dd>
                    {costs ? t('appPages.computer.perMinute', { price: costs.perMinute }) : t('appPages.computer.unpriced')}
                    {costs ? <small>{t('appPages.computer.perHour', { price: costs.perHour })}</small> : null}
                  </dd>
                </div>
                <div>
                  <dt>{t('appPages.computer.idle')}</dt>
                  <dd>{t('appPages.computer.idleAfter', { n: data.idle_minutes })}</dd>
                </div>
              </dl>
            </section>
            <div className="gh-callout" data-tone="neutral" role="note">
              <Icon name="folder" size={16} color="var(--gh-secondary)" />
              <div className="gh-callout-text">{t('appPages.computer.files')}</div>
            </div>
          </div>
        )}
      </div>
    </Place>
  );
}
