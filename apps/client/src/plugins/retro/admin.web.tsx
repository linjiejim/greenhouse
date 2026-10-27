/**
 * Retro plugin › Monthly retro (an Admin section, manifest page `retro`): write (or update) this
 * month's team retro now (POST /api/admin/retro, the same document the scheduled job writes on
 * the 1st) and open the retros written so far (team knowledge documents; retro depends on it).
 */
import React, { useCallback, useState } from 'react';
import { get, post } from '../../api/client';
import { useResource } from '../../data/use-resource';
import { usePrefs } from '../../store/prefs';
import { useT, localeOf } from '../../lib/i18n';
import { useOpenObject } from '../../shell/open-object';
import { Icon } from '../../ui/core';
import { toast } from '../../ui/toast';
import { AdminPage, Callout, Card, SectionState } from '../../admin/kit.web';
import { useWrite } from '../../admin/use-write';
import { dateTimeLabel } from '../../admin/format';
import type { AdminScreenEntry, AdminScreenProps } from '../admin-types';
import { screen as retroScreen } from './index';

interface RetroResult {
  month: string;
  doc_id: string;
  created: boolean;
  skipped_reason: 'over_budget' | 'no_model' | 'failed' | null;
}
interface RetroDoc {
  id: string;
  title: string;
  updated_at: string;
}

function RetroScreen({ title }: AdminScreenProps) {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const openObject = useOpenObject();
  const docs = useResource(useCallback(() => get<{ docs: RetroDoc[] }>(retroScreen.endpoint!), []));
  const [result, setResult] = useState<RetroResult | null>(null);
  const { busy, run } = useWrite();
  const generate = async () => {
    const answer = await run(() => post<RetroResult>('/api/admin/retro', {}), t('admin.ext.retro.failed'));
    if (!answer) return;
    setResult(answer);
    toast(
      answer.skipped_reason
        ? t(`admin.ext.retro.skipped.${answer.skipped_reason}`, { month: answer.month })
        : t('admin.ext.retro.done', { month: answer.month }),
    );
    void docs.refresh();
  };
  const rows = docs.data?.docs ?? [];
  return (
    <AdminPage
      title={title}
      testID="admin-retro"
      actions={
        <button className="gh-primary" disabled={busy} onClick={() => void generate()} data-testid="retro-generate">
          {busy ? t('admin.ext.retro.generating') : t('admin.ext.retro.generate')}
        </button>
      }
    >
      <p className="gh-admin-hint">{t('admin.ext.retro.intro')}</p>
      {result ? (
        <Callout
          tone={result.skipped_reason ? 'warning' : 'info'}
          icon={result.skipped_reason ? 'alert' : 'checkCircle'}
          action={
            <button className="gh-admin-button" onClick={() => openObject({ kind: 'doc', id: result.doc_id })}>
              <Icon name="open" size={14} />
              {t('admin.ext.retro.open', { month: result.month })}
            </button>
          }
        >
          {result.skipped_reason
            ? t(`admin.ext.retro.skipped.${result.skipped_reason}`, { month: result.month })
            : t('admin.ext.retro.done', { month: result.month })}
        </Callout>
      ) : null}
      <Card title={t('admin.ext.retro.written')} icon="calendar" flush>
        {rows.length ? (
          <table className="gh-data-grid gh-admin-grid">
            <tbody>
              {rows.map((doc) => (
                <tr
                  key={doc.id}
                  data-open=""
                  tabIndex={0}
                  onClick={() => openObject({ kind: 'doc', id: String(doc.id) })}
                >
                  <td>{doc.title}</td>
                  <td className="gh-number">{dateTimeLabel(doc.updated_at, localeOf(lang))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <SectionState
            loading={docs.loading && !docs.data}
            error={docs.error}
            retry={() => void docs.refresh()}
            icon="calendar"
            title={t('admin.ext.retro.none')}
          />
        )}
      </Card>
    </AdminPage>
  );
}

export const adminScreen: AdminScreenEntry = { screen: 'retro', icon: 'calendar', component: RetroScreen };
