/**
 * Skills in the browser (the Skills plugin's `skills` page): the team catalog, a skill's detail
 * with its whole version history (changelog, files, size, who and when), and uploading a skill or
 * a new version of one: pick SKILL.md, several files or the skill's folder (./bundle.ts reads
 * them), check the name, description, version and changelog, publish (`POST /api/skills/publish`;
 * the station scans the bundle and keeps versions immutable). New Version is offered to the
 * skill's owner and to supers, the station's own rule. The phone keeps the read-only list.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useResource } from '../../data/use-resource';
import { useT, localeOf, type TranslationKey } from '../../lib/i18n';
import { relativeTimeNow } from '../../lib/time-words';
import { useAuth } from '../../store/auth';
import { usePrefs } from '../../store/prefs';
import { Icon } from '../../ui/core';
import { Place, PlaceEmpty } from '../../ui/place.web';
import { toast } from '../../ui/toast';
import { AdminDialog, Badge, Callout, Field, type Tone } from '../../admin/kit.web';
import { dateTimeLabel } from '../../admin/format';
import { useWrite } from '../../admin/use-write';
import { getSkill, listSkills, publishSkill, type SkillSummary } from './api';
import {
  bundleFromFiles,
  headingOf,
  isSemver,
  MAX_BUNDLE_BYTES,
  MAX_FILES,
  nextVersion,
  parseTags,
  readFrontmatter,
  SKILL_NAME_RE,
  type BundleFile,
  type BundleProblem,
  type PickedFile,
} from './bundle';

const SCAN_TONE: Record<SkillSummary['scan_status'], Tone> = {
  clean: 'success',
  pending: 'info',
  suspicious: 'warning',
  blocked: 'danger',
};

const size = (bytes: number) => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`);

type Open = { kind: 'detail'; name: string } | { kind: 'upload'; skill?: SkillSummary } | null;

export function SkillsScreen({ title }: { title: string }) {
  const t = useT();
  const list = useResource(useCallback(() => listSkills(), []));
  const [open, setOpen] = useState<Open>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const refresh = () => void list.refresh();
    window.addEventListener('greenhouse:refresh', refresh);
    return () => window.removeEventListener('greenhouse:refresh', refresh);
  });
  const skills = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = list.data?.skills ?? [];
    return q
      ? all.filter((s) => [s.name, s.display_name, s.description, ...s.tags].some((v) => v.toLowerCase().includes(q)))
      : all;
  }, [list.data, query]);
  return (
    <Place
      title={title}
      actions={
        <>
          <button onClick={() => void list.refresh()} disabled={list.loading} aria-label={t('common.refresh')}>
            <Icon name="refresh" size={16} />
          </button>
          <button className="gh-primary" onClick={() => setOpen({ kind: 'upload' })} data-testid="skill-upload">
            {t('skillHub.upload')}
          </button>
        </>
      }
    >
      <div className="gh-place-scroll">
        {list.data?.skills.length ? (
          <div className="gh-toolbar">
            <input
              className="gh-input"
              type="search"
              placeholder={t('skillHub.search')}
              aria-label={t('skillHub.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="gh-count">{t('skillHub.count', { n: list.data.total })}</span>
          </div>
        ) : null}
        {!list.data ? (
          <PlaceEmpty
            loading={list.loading}
            error={list.error ? list.error.message || t('places.pluginError') : null}
            retry={list.error?.status === 403 ? undefined : () => void list.refresh()}
          />
        ) : !skills.length ? (
          <PlaceEmpty
            icon="sparkle"
            title={query ? t('skillHub.noMatch') : t('skillHub.empty')}
            message={query ? undefined : t('skillHub.emptyHint')}
          />
        ) : (
          <ul className="gh-resource-list" data-testid="skills-list">
            {skills.map((skill) => (
              <li
                key={skill.name}
                data-open=""
                role="button"
                tabIndex={0}
                aria-label={skill.display_name || skill.name}
                onClick={() => setOpen({ kind: 'detail', name: skill.name })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setOpen({ kind: 'detail', name: skill.name });
                  }
                }}
              >
                <span className="gh-resource-icon">
                  <Icon name="sparkle" size={18} color="var(--gh-accent-text)" />
                </span>
                <div className="gh-resource-body">
                  <strong>{skill.display_name || skill.name}</strong>
                  <p>{skill.description}</p>
                  <div className="gh-resource-tags">
                    <span className="gh-mono">{skill.name}</span>
                    {skill.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                </div>
                <div className="gh-resource-meta">
                  <span className="gh-resource-status">v{skill.latest_version}</span>
                  {skill.scan_status !== 'clean' ? (
                    <Badge tone={SCAN_TONE[skill.scan_status]}>{t(`skillHub.scan.${skill.scan_status}`)}</Badge>
                  ) : null}
                  <small>{relativeTimeNow(skill.updated_at)}</small>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {open?.kind === 'detail' ? (
        <SkillDetailDialog
          name={open.name}
          close={() => setOpen(null)}
          newVersion={(skill) => setOpen({ kind: 'upload', skill })}
        />
      ) : null}
      {open?.kind === 'upload' ? (
        <SkillUploadDialog
          skill={open.skill}
          close={() => setOpen(null)}
          published={(name) => {
            void list.refresh();
            setOpen({ kind: 'detail', name });
          }}
        />
      ) : null}
    </Place>
  );
}

function SkillDetailDialog({
  name,
  close,
  newVersion,
}: {
  name: string;
  close: () => void;
  newVersion: (skill: SkillSummary) => void;
}) {
  const t = useT();
  const locale = localeOf(usePrefs((s) => s.lang));
  const user = useAuth((s) => s.user);
  const detail = useResource(useCallback(() => getSkill(name), [name]));
  const skill = detail.data?.skill;
  const canPublish = !!skill && !!user && (user.role === 'super' || user.id === skill.owner_user_id);
  return (
    <AdminDialog
      size="lg"
      title={skill ? skill.display_name || skill.name : name}
      onClose={close}
      testID="skill-detail"
      footer={
        <>
          <button type="button" className="gh-secondary-button" onClick={close}>
            {t('common.close')}
          </button>
          {canPublish ? (
            <button
              type="button"
              className="gh-primary"
              onClick={() => newVersion(skill!)}
              data-testid="skill-new-version"
            >
              {t('skillHub.newVersion')}
            </button>
          ) : null}
        </>
      }
    >
      {!detail.data ? (
        <PlaceEmpty
          loading={detail.loading}
          error={detail.error ? detail.error.message || t('skillHub.loadFailed') : null}
          retry={() => void detail.refresh()}
        />
      ) : (
        <div className="gh-form">
          <p>{detail.data.skill.description}</p>
          <div className="gh-chip-row">
            <span className="gh-badge gh-mono">{detail.data.skill.name}</span>
            <Badge tone="accent">v{detail.data.skill.latest_version}</Badge>
            <Badge tone={SCAN_TONE[detail.data.skill.scan_status]}>
              {t(`skillHub.scan.${detail.data.skill.scan_status}`)}
            </Badge>
            {detail.data.skill.status === 'archived' ? <Badge>{t('skillHub.archived')}</Badge> : null}
            {detail.data.skill.tags.map((tag) => (
              <Badge key={tag}>{tag}</Badge>
            ))}
          </div>
          <h4 className="gh-form-heading">{t('skillHub.history')}</h4>
          <table className="gh-data-grid gh-admin-grid" data-testid="skill-versions">
            <thead>
              <tr>
                <th>{t('skillHub.version')}</th>
                <th>{t('skillHub.changelog')}</th>
                <th>{t('skillHub.files')}</th>
                <th>{t('skillHub.published')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.data.versions.map((version) => (
                <tr key={version.version}>
                  <td className="gh-mono">{version.version}</td>
                  <td style={{ whiteSpace: 'normal' }}>{version.changelog || '—'}</td>
                  <td>{`${version.file_count} · ${size(version.size_bytes)}`}</td>
                  <td>{dateTimeLabel(version.created_at, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminDialog>
  );
}

interface Picked {
  files: BundleFile[];
  bytes: number;
  front: { name?: string; description?: string; version?: string };
  heading?: string;
}

async function readPicked(list: FileList | null): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  for (const file of Array.from(list ?? [])) {
    // A folder pick keeps the folder in webkitRelativePath; bundleFromFiles drops that top folder.
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    out.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  return out;
}

function problemText(t: ReturnType<typeof useT>, problem: BundleProblem): string {
  switch (problem.kind) {
    case 'path':
      return t('skillHub.problem.path', { path: problem.path });
    case 'duplicate':
      return t('skillHub.problem.duplicate', { path: problem.path });
    case 'too-many':
      return t('skillHub.problem.tooMany', { n: problem.count, max: MAX_FILES });
    case 'too-big':
      return t('skillHub.problem.tooBig', { size: size(problem.bytes), max: size(MAX_BUNDLE_BYTES) });
    default:
      return t(`skillHub.problem.${problem.kind === 'no-skill-md' ? 'noSkillMd' : problem.kind}` as TranslationKey);
  }
}

function SkillUploadDialog({
  skill,
  close,
  published,
}: {
  skill?: SkillSummary;
  close: () => void;
  published: (name: string) => void;
}) {
  const t = useT();
  const { busy, run } = useWrite();
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: skill?.name ?? '',
    display_name: '',
    description: '',
    tags: '',
    version: '',
    changelog: '',
  });
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));
  useEffect(() => {
    // The folder picker is a non-standard attribute React does not pass through by name.
    folderRef.current?.setAttribute('webkitdirectory', '');
  }, []);

  const pick = async (list: FileList | null) => {
    const result = bundleFromFiles(await readPicked(list));
    if (!result.ok) {
      setPicked(null);
      setProblem(problemText(t, result.problem));
      return;
    }
    setProblem(null);
    const skillMd = result.files.find((file) => file.path === 'SKILL.md')!;
    const front = skillMd.encoding ? {} : readFrontmatter(skillMd.content);
    const heading = skillMd.encoding ? undefined : headingOf(skillMd.content);
    setPicked({ files: result.files, bytes: result.bytes, front, heading });
    setForm((f) => ({
      name: skill?.name ?? front.name ?? f.name,
      display_name: heading ?? skill?.display_name ?? f.display_name,
      description: front.description ?? skill?.description ?? f.description,
      tags: f.tags || (skill?.tags ?? []).join(', '),
      version: front.version ?? nextVersion(skill?.latest_version),
      changelog: f.changelog,
    }));
  };

  const nameMismatch = !!(skill && picked?.front.name && picked.front.name !== skill.name);
  const missing = !picked
    ? t('skillHub.need.files')
    : !SKILL_NAME_RE.test(form.name.trim())
      ? t('skillHub.need.name')
      : nameMismatch
        ? t('skillHub.need.sameName', { name: skill!.name })
        : form.version.trim() && !isSemver(form.version.trim())
          ? t('skillHub.need.version')
          : skill && !form.changelog.trim()
            ? t('skillHub.need.changelog')
            : !skill && !form.description.trim()
              ? t('skillHub.need.description')
              : null;

  const submit = async () => {
    if (missing || !picked) return;
    const answer = await run(
      () =>
        publishSkill({
          name: form.name.trim(),
          display_name: form.display_name.trim() || undefined,
          description: form.description.trim() || undefined,
          tags: parseTags(form.tags),
          version: form.version.trim() || undefined,
          changelog: form.changelog.trim() || undefined,
          files: picked.files,
        }),
      t('skillHub.publishFailed'),
    );
    if (!answer) return;
    toast(
      t('skillHub.publishedToast', {
        name: answer.skill.display_name || answer.skill.name,
        version: answer.version.version,
      }),
      'check',
    );
    published(answer.skill.name);
  };

  return (
    <AdminDialog
      size="lg"
      title={
        skill ? t('skillHub.newVersionTitle', { name: skill.display_name || skill.name }) : t('skillHub.uploadTitle')
      }
      onClose={close}
      testID="skill-upload-form"
      footer={
        <>
          {missing && picked ? <span className="gh-dialog-footer-lead gh-hint">{missing}</span> : null}
          <button type="button" className="gh-secondary-button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="skill-upload" className="gh-primary" disabled={busy || !!missing}>
            {busy ? t('common.loading') : t('skillHub.publish')}
          </button>
        </>
      }
    >
      <form
        id="skill-upload"
        className="gh-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="gh-hint">{t('skillHub.uploadIntro', { files: MAX_FILES, size: size(MAX_BUNDLE_BYTES) })}</p>
        <div className="gh-button-row">
          <button type="button" className="gh-secondary-button" onClick={() => filesRef.current?.click()}>
            <Icon name="docPlus" size={14} />
            {t('skillHub.pickFiles')}
          </button>
          <button type="button" className="gh-secondary-button" onClick={() => folderRef.current?.click()}>
            <Icon name="folder" size={14} />
            {t('skillHub.pickFolder')}
          </button>
          <input
            ref={filesRef}
            type="file"
            multiple
            hidden
            data-testid="skill-files"
            onChange={(e) => void pick(e.target.files)}
          />
          <input
            ref={folderRef}
            type="file"
            hidden
            data-testid="skill-folder"
            onChange={(e) => void pick(e.target.files)}
          />
        </div>
        {problem ? <Callout tone="danger">{problem}</Callout> : null}
        {picked ? (
          <p className="gh-hint" data-testid="skill-picked">
            {t('skillHub.picked', { n: picked.files.length, size: size(picked.bytes) })}
          </p>
        ) : null}
        {skill?.source_group ? <Callout>{t('skillHub.firstParty')}</Callout> : null}
        <div className="gh-form-grid">
          <Field label={t('skillHub.name')} required help={t('skillHub.nameHint')}>
            {(id) => (
              <input
                id={id}
                className="gh-mono"
                value={form.name}
                disabled={!!skill || !!picked?.front.name}
                onChange={(e) => set('name', e.target.value.toLowerCase())}
              />
            )}
          </Field>
          <Field label={t('skillHub.version')} help={t('skillHub.versionHint')}>
            {(id) => (
              <input
                id={id}
                className="gh-mono"
                value={form.version}
                onChange={(e) => set('version', e.target.value)}
              />
            )}
          </Field>
        </div>
        <Field label={t('skillHub.displayName')}>
          {(id) => <input id={id} value={form.display_name} onChange={(e) => set('display_name', e.target.value)} />}
        </Field>
        <Field label={t('skillHub.description')} required={!skill}>
          {(id) => (
            <textarea id={id} rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} />
          )}
        </Field>
        <Field label={t('skillHub.tags')} help={t('skillHub.tagsHint')}>
          {(id) => <input id={id} value={form.tags} onChange={(e) => set('tags', e.target.value)} />}
        </Field>
        <Field label={t('skillHub.changelog')} required={!!skill}>
          {(id) => (
            <textarea
              id={id}
              rows={3}
              placeholder={t('skillHub.changelogPlaceholder')}
              value={form.changelog}
              onChange={(e) => set('changelog', e.target.value)}
            />
          )}
        </Field>
      </form>
    </AdminDialog>
  );
}
