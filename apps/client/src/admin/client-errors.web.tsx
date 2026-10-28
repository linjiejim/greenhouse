/**
 * Client errors (GET /api/admin/client-reports?days=7|30|90): errors the apps caught on members'
 * devices and browsers (src/reports), grouped by kind with how often, for how many members, on
 * which platforms and app versions. A row opens its latest report: where in the app, the device,
 * the build and the redacted stack. Reports carry no message or document text.
 */
import React, { useCallback, useState } from 'react';
import { get } from '../api/client';
import { useResource } from '../data/use-resource';
import { localeOf, useT, type TranslationKey } from '../lib/i18n';
import type { ClientErrorGroup, ClientErrorReport } from '../shared/client-reports';
import { usePrefs } from '../store/prefs';
import { Icon } from '../ui/core';
import { AdminPage, Badge, Kpis, SectionState } from './kit.web';
import { dateTimeLabel } from './format';
import {
  CLIENT_ERROR_DAYS,
  appLine,
  clientErrorTotals,
  errorHeadline,
  type ClientErrorDays,
} from './client-errors-model';

export default function ClientErrorsSection() {
  const t = useT();
  const [days, setDays] = useState<ClientErrorDays>(7);
  const report = useResource(
    useCallback(() => get<ClientErrorReport>('/api/admin/client-reports', { days }), [days]),
  );
  const data = report.data?.days === days ? report.data : null;
  return (
    <AdminPage
      title={t('admin.sections.client-errors')}
      testID="admin-client-errors"
      actions={
        <>
          <select
            className="gh-input"
            aria-label={t('admin.usage.range')}
            value={days}
            onChange={(e) => setDays(Number(e.target.value) as ClientErrorDays)}
          >
            {CLIENT_ERROR_DAYS.map((d) => (
              <option key={d} value={d}>
                {t('admin.usage.lastDays', { n: d })}
              </option>
            ))}
          </select>
          <button
            className="gh-icon-button"
            aria-label={t('common.refresh')}
            disabled={report.loading}
            onClick={() => void report.refresh()}
          >
            <Icon name="refresh" size={16} />
          </button>
        </>
      }
    >
      {data?.groups.length ? (
        <Groups report={data} />
      ) : (
        <SectionState
          loading={report.loading}
          error={report.error}
          retry={() => void report.refresh()}
          icon="checkCircle"
          title={t('admin.clientErrors.empty')}
          message={t('admin.clientErrors.emptyHint')}
        />
      )}
    </AdminPage>
  );
}

function Groups({ report }: { report: ClientErrorReport }) {
  const t = useT();
  const locale = localeOf(usePrefs((s) => s.lang));
  const [open, setOpen] = useState<string | null>(null);
  const totals = clientErrorTotals(report);
  return (
    <>
      <Kpis
        items={[
          { label: t('admin.clientErrors.reports'), value: totals.reports.toLocaleString() },
          { label: t('admin.clientErrors.kinds'), value: totals.kinds.toLocaleString() },
          {
            label: t('admin.clientErrors.fatal'),
            value: totals.fatal.toLocaleString(),
            hint: t('admin.clientErrors.fatalHint'),
            tone: totals.fatal ? 'warning' : undefined,
          },
        ]}
      />
      <table className="gh-data-grid gh-admin-grid" data-testid="admin-client-errors-list">
        <thead>
          <tr>
            <th>{t('admin.clientErrors.error')}</th>
            <th className="gh-number">{t('admin.clientErrors.count')}</th>
            <th className="gh-number">{t('admin.clientErrors.members')}</th>
            <th>{t('admin.clientErrors.platforms')}</th>
            <th>{t('admin.clientErrors.versions')}</th>
            <th>{t('admin.clientErrors.lastSeen')}</th>
          </tr>
        </thead>
        <tbody>
          {report.groups.map((group) => {
            const expanded = open === group.fingerprint;
            const toggle = () => setOpen(expanded ? null : group.fingerprint);
            return (
              <React.Fragment key={group.fingerprint}>
                <tr
                  data-open=""
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={toggle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggle();
                    }
                  }}
                >
                  <td
                    title={errorHeadline(group)}
                    style={{ maxWidth: 460, overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    <span className="gh-admin-person">
                      <Icon name={expanded ? 'chevD' : 'chevR'} size={12} />
                      {group.fatal ? <Badge tone="danger">{t('admin.clientErrors.fatalBadge')}</Badge> : null}
                      {errorHeadline(group)}
                    </span>
                  </td>
                  <td className="gh-number">{group.count.toLocaleString()}</td>
                  <td className="gh-number">{group.members.toLocaleString()}</td>
                  <td>
                    <span className="gh-admin-person">
                      {group.platforms.map((p) => (
                        <Badge key={p}>{t(`admin.clientErrors.platform.${p}` as TranslationKey)}</Badge>
                      ))}
                    </span>
                  </td>
                  <td>{group.versions.join(', ')}</td>
                  <td>{dateTimeLabel(group.last_at, locale)}</td>
                </tr>
                {expanded ? <Latest group={group} locale={locale} /> : null}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

function Latest({ group, locale }: { group: ClientErrorGroup; locale: string }) {
  const t = useT();
  const { latest } = group;
  const facts: [string, string | null][] = [
    [t('admin.clientErrors.source'), t(`admin.clientErrors.sources.${latest.source}` as TranslationKey)],
    [t('admin.clientErrors.route'), latest.route],
    [
      t('admin.clientErrors.device'),
      [t(`admin.clientErrors.platform.${latest.platform}` as TranslationKey), latest.os_version]
        .filter(Boolean)
        .join(' '),
    ],
    [t('admin.clientErrors.app'), appLine(latest)],
    [t('admin.clientErrors.apiLevel'), latest.api_level == null ? null : String(latest.api_level)],
    [t('admin.clientErrors.firstSeen'), dateTimeLabel(group.first_at, locale)],
  ];
  return (
    <tr data-detail="">
      <td colSpan={6}>
        <div className="gh-admin-latest">
          <span className="gh-admin-latest-title">{t('admin.clientErrors.latest')}</span>
          {facts
            .filter(([, value]) => value)
            .map(([label, value]) => (
              <span key={label}>
                {label} <strong>{value}</strong>
              </span>
            ))}
        </div>
        {latest.stack ? (
          <pre className="gh-admin-code" data-testid="admin-client-error-stack">
            {latest.stack}
          </pre>
        ) : (
          <p className="gh-hint">{t('admin.clientErrors.noStack')}</p>
        )}
      </td>
    </tr>
  );
}
