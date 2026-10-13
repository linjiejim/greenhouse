/**
 * A skill's detail (SKL-02 to SKL-04, SKL-09), as a drawer over the library: what it does, its
 * instructions and fields, what it needs, its versions, and its scan with the reviewer's buttons.
 * 在对话里使用 opens a new chat with it chosen.
 */

import { useState } from 'react';
import { Download, Play } from 'lucide-react';
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorBox,
  Overlay,
  OverlayActions,
  Skeleton,
  StatusBadge,
  type MenuEntry,
  Menu,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { SkillDetail } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { Markdown } from '../../conversation/Markdown';
import { formatSize } from '../../data/files';
import { useSkill, useSkillActions, useSkillVersions } from '../../data/skills';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { relativeTime } from '../../lib/time';
import { SkillDrawer, UploadSkillDialog } from './SkillForms';
import { SkillsPage } from './SkillsPage';
import { KIND, SCAN } from './status';

function Detail({ skill }: { skill: SkillDetail }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const actions = useSkillActions();
  const versions = useSkillVersions(skill.id);
  const scan = SCAN[skill.scan_status];
  const review = (decision: 'safe' | 'malicious' | 'rescan') =>
    actions.scan.mutate({ id: skill.id, input: { decision } }, { onError: (error) => notify(errorText(error, t)) });
  return (
    <div className="app-skill">
      <div className="app-run-meta">
        <span className="app-mono">/{skill.name}</span>
        <Badge>{skill.space === 'team' ? t('skills.team') : t('skills.personal')}</Badge>
        <Badge>{t(KIND[skill.kind])}</Badge>
        {scan && <StatusBadge status={t(scan.word)} tone={scan.tone} />}
        <span className="app-muted">v{skill.latest_version}</span>
      </div>
      <p>{skill.description}</p>
      {skill.unavailable && !skill.archived_at && (
        <p className="app-muted" role="note">
          {skill.unavailable.message}
        </p>
      )}

      {skill.scan_findings.length > 0 && (
        <section className="app-section">
          <h3 className="app-section-title">{t('skills.findings')}</h3>
          <ul className="app-list">
            {skill.scan_findings.map((finding, index) => (
              <li key={index} className="app-list-row is-static">
                <span className="app-list-main">
                  <span className="app-list-title">
                    {finding.rule}
                    {finding.path ? ` · ${finding.path}` : ''}
                  </span>
                  <span className="app-list-meta app-mono">{finding.excerpt}</span>
                </span>
                <StatusBadge
                  status={finding.severity === 'high' ? t('skills.severityHigh') : t('skills.severityMedium')}
                  tone={finding.severity === 'high' ? 'danger' : 'neutral'}
                />
              </li>
            ))}
          </ul>
          {skill.can_review && (
            <div className="app-inline-actions">
              <Button size="sm" onClick={() => review('rescan')}>
                {t('skills.rescan')}
              </Button>
              {skill.scan_status !== 'blocked' && (
                <Button size="sm" kind="danger" onClick={() => review('malicious')}>
                  {t('skills.markMalicious')}
                </Button>
              )}
              {skill.scan_status !== 'clean' && skill.scan_status !== 'blocked' && (
                <Button size="sm" kind="primary" onClick={() => review('safe')}>
                  {t('skills.markSafe')}
                </Button>
              )}
            </div>
          )}
        </section>
      )}

      {skill.variables.length > 0 && (
        <section className="app-section">
          <h3 className="app-section-title">{t('skills.fields')}</h3>
          <ul className="app-list">
            {skill.variables.map((variable) => (
              <li key={variable.key} className="app-list-row is-static">
                <span className="app-list-main">
                  <span className="app-list-title">{variable.label}</span>
                  <span className="app-list-meta app-mono">
                    {`{{${variable.key}}}`}
                    {variable.type === 'choice' && variable.options?.length ? ` · ${variable.options.join(' / ')}` : ''}
                  </span>
                </span>
                {variable.required !== false && <Badge>{t('skills.fieldRequired')}</Badge>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {(skill.requirements.computer || skill.requirements.connectors.length > 0) && (
        <section className="app-section">
          <h3 className="app-section-title">{t('skills.requirements')}</h3>
          <p className="app-muted">
            {[
              skill.requirements.computer ? t('skills.needsComputer') : null,
              ...skill.requirements.connectors.map((slug) => t('skills.needsConnector', { name: slug })),
            ]
              .filter(Boolean)
              .join('、')}
          </p>
        </section>
      )}

      <section className="app-section">
        <h3 className="app-section-title">{t('skills.instructions')}</h3>
        <div className="app-skill-body">
          <Markdown text={skill.body} />
        </div>
      </section>

      {skill.files.length > 0 && (
        <section className="app-section">
          <h3 className="app-section-title">{t('skills.files', { count: skill.files.length })}</h3>
          <ul className="app-list">
            {skill.files.map((file) => (
              <li key={file.path} className="app-list-row is-static">
                <span className="app-list-main">
                  <span className="app-list-title app-mono">{file.path}</span>
                </span>
                <span className="app-list-time">{formatSize(file.size, locale)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="app-section">
        <h3 className="app-section-title">{t('skills.versions')}</h3>
        {versions.isPending ? (
          <Skeleton lines={2} />
        ) : (
          <ul className="app-list">
            {(versions.data?.items ?? []).map((version) => (
              <li key={version.version} className="app-list-row is-static">
                <span className="app-list-main">
                  <span className="app-list-title">v{version.version}</span>
                  {version.changelog && <span className="app-list-meta">{version.changelog}</span>}
                </span>
                <time className="app-list-time" dateTime={version.created_at}>
                  {relativeTime(version.created_at, { locale, timeZone: me.timezone })}
                </time>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function SkillPage({ id }: { id: string }) {
  const { t } = useI18n();
  const notify = useNotify();
  const skill = useSkill(id);
  const actions = useSkillActions();
  const [newVersion, setNewVersion] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const close = () => navigate({ page: 'skills', scope: 'all' }, { replace: true });
  const data = skill.data;

  const download = () =>
    void api.skills
      .download(id)
      .then((file) => window.open(file.url, '_blank', 'noopener,noreferrer'))
      .catch((error: unknown) => notify(errorText(error, t)));

  const menu: MenuEntry[] = data
    ? [
        ...(data.kind === 'package'
          ? [{ label: t('skills.download'), icon: <Download size={icon.md} />, onClick: download }]
          : []),
        ...(data.can_manage && !data.archived_at && data.scan_status !== 'blocked'
          ? [{ label: t('skills.newVersion'), onClick: () => setNewVersion(true) }]
          : []),
        ...(data.can_manage
          ? data.archived_at
            ? [
                {
                  label: t('skills.restore'),
                  onClick: () => actions.restore.mutate(id, { onError: (error) => notify(errorText(error, t)) }),
                },
              ]
            : ['-' as const, { label: t('skills.archive'), danger: true, onClick: () => setArchiving(true) }]
          : []),
      ]
    : [];

  return (
    <>
      <SkillsPage scope="all" />
      <Overlay title={data ? data.display_name || data.name : t('nav.skills')} onClose={close}>
        {skill.isPending ? (
          <Skeleton lines={6} />
        ) : skill.isError || !data ? (
          <ErrorBox onRetry={() => void skill.refetch()}>
            {skill.error instanceof ApiClientError && skill.error.status === 404
              ? t('skills.notFound')
              : errorText(skill.error, t)}
          </ErrorBox>
        ) : (
          <Detail skill={data} />
        )}
        {data && (
          <OverlayActions>
            {menu.length > 0 && (
              <Menu label={t('row.actionsFor', { name: data.display_name || data.name })} items={menu} />
            )}
            <Button
              kind="primary"
              disabled={!data.available}
              disabledReason={data.unavailable?.message}
              onClick={() => navigate(`#/c/new?skill=${encodeURIComponent(data.id)}`)}
            >
              <Play size={icon.md} />
              {t('skills.use')}
            </Button>
          </OverlayActions>
        )}
      </Overlay>
      {newVersion &&
        data &&
        (data.kind === 'template' ? (
          <SkillDrawer skill={data} onClose={() => setNewVersion(false)} />
        ) : (
          <UploadSkillDialog skill={data} onClose={() => setNewVersion(false)} />
        ))}
      {archiving && data && (
        <ConfirmDialog
          danger
          title={t('skills.archiveTitle', { name: data.display_name || data.name })}
          confirmLabel={t('skills.archive')}
          onCancel={() => setArchiving(false)}
          onConfirm={() => {
            setArchiving(false);
            actions.archive.mutate(id, { onSuccess: close, onError: (error) => notify(errorText(error, t)) });
          }}
        >
          {t('skills.archiveBody')}
        </ConfirmDialog>
      )}
    </>
  );
}
