/**
 * 技能 (SKL-01): the skills I can use, the team's and my own, with what each needs and whether it
 * waits for review. New ones are templates (instructions and fields) or SKILL.md packages (ZIP).
 */

import { useState } from 'react';
import { Upload, Wand2 } from 'lucide-react';
import { Badge, Button, Empty, ErrorBox, SearchInput, Skeleton, StatusBadge } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Skill } from '@greenhouse/contract';
import { scopeQuery, useSkills } from '../../data/skills';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { href, type SkillScope } from '../../lib/router';
import { Page, PageHeader } from '../../shell/Page';
import { SkillDrawer, UploadSkillDialog } from './SkillForms';
import { KIND, SCAN } from './status';

export function SkillRow({ skill }: { skill: Skill }) {
  const { t } = useI18n();
  const scan = SCAN[skill.scan_status];
  return (
    <li>
      <a className="app-list-row" href={href({ page: 'skill', id: skill.id })}>
        <Wand2 size={icon.md} className="app-file-icon" aria-hidden />
        <span className="app-list-main">
          <span className="app-list-title">
            {skill.display_name || skill.name} <span className="app-mono app-muted">/{skill.name}</span>
          </span>
          <span className="app-list-meta">
            {skill.unavailable && skill.scan_status === 'clean' && !skill.archived_at
              ? skill.unavailable.message
              : skill.description}
          </span>
        </span>
        <Badge>{skill.space === 'team' ? t('skills.team') : t('skills.personal')}</Badge>
        <Badge>{t(KIND[skill.kind])}</Badge>
        {scan && <StatusBadge status={t(scan.word)} tone={scan.tone} />}
      </a>
    </li>
  );
}

export function SkillsPage({ scope }: { scope: SkillScope }) {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const skills = useSkills(scopeQuery(scope, q.trim() || undefined));
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState(false);
  return (
    <Page
      header={
        <PageHeader
          title={t(`skills.scope.${scope}`)}
          primary={
            <Button kind="primary" onClick={() => setCreating(true)}>
              {t('skills.new')}
            </Button>
          }
          menu={[{ label: t('skills.upload'), icon: <Upload size={icon.md} />, onClick: () => setUploading(true) }]}
        />
      }
    >
      <div className="app-toolbar">
        <SearchInput label={t('skills.search')} placeholder={t('skills.search')} value={q} onChange={setQ} />
      </div>
      {skills.isPending ? (
        <Skeleton lines={5} />
      ) : skills.isError ? (
        <ErrorBox onRetry={() => void skills.refetch()}>{errorText(skills.error, t)}</ErrorBox>
      ) : !skills.items.length ? (
        <Empty
          icon={<Wand2 />}
          title={q ? t('skills.noMatch') : t('skills.none')}
          description={q ? undefined : t('skills.noneHint')}
        />
      ) : (
        <ul className="app-list">
          {skills.items.map((skill) => (
            <SkillRow key={skill.id} skill={skill} />
          ))}
        </ul>
      )}
      {creating && <SkillDrawer onClose={() => setCreating(false)} />}
      {uploading && <UploadSkillDialog onClose={() => setUploading(false)} />}
    </Page>
  );
}
