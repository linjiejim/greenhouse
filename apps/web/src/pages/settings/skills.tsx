/**
 * SkillCenterPanel — browse & manage the org's shared agent skills.
 *
 * Built on @greenhouse/crud: list + filters + delete come from one defineCrud
 * schema; the per-skill version history (changelogs + files) rides the
 * rowExpand slot. Publishing is agent-first (skill_mutation over chat / MCP),
 * so there is deliberately no create form here.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { defineCrud, CrudPage, type CrudDataSource } from '@greenhouse/crud';
import { Spinner, Tag, TagList, toast } from '../../components/ui';
import { Archive, Download, Package } from '../../lib/icons';
import { fetchShareableUsers } from '../../lib/api';
import {
  archiveSkill,
  deleteSkill,
  downloadSkillBundle,
  getSkill,
  listSkills,
  unarchiveSkill,
  type SkillFileEntry,
  type SkillSummary,
  type SkillVersionSummary,
} from '../../lib/api/skills';
import { useAuthStore } from '../../stores';
import { useT } from '../../lib/i18n';
import { formatDate, timeAgo } from '../../lib/utils';

const dataSource: CrudDataSource<SkillSummary> = {
  async list(params) {
    const q = params.filter?.find((f) => f.key === 'name')?.value?.[0];
    const status = params.filter?.find((f) => f.key === 'status')?.value?.[0];
    const { total, skills } = await listSkills({
      q: q ? String(q) : undefined,
      status: status === 'active' || status === 'archived' ? status : 'all',
      limit: params.limit,
      offset: params.skip,
    });
    return { items: skills, total };
  },
  async get(name) {
    return (await getSkill(String(name))).skill;
  },
  remove: (name) => deleteSkill(String(name)),
};

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function saveJsonFile(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Version history (rowExpand) ─────────────────────────

function VersionFiles({ name, version }: { name: string; version: string }) {
  const t = useT();
  const [files, setFiles] = useState<SkillFileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);

  useEffect(() => {
    downloadSkillBundle(name, version)
      .then((bundle) => setFiles(bundle.files))
      .catch((e) => setError(e.message));
  }, [name, version]);

  if (error) return <div className="text-xs text-danger py-1">{error}</div>;
  if (!files)
    return (
      <div className="py-2">
        <Spinner />
      </div>
    );
  return (
    <div className="mt-1.5 space-y-1">
      {files.map((file) => (
        <div key={file.path} className="text-xs">
          <button
            className="font-mono text-fg-secondary hover:text-fg hover:underline"
            onClick={() => setOpenPath(openPath === file.path ? null : file.path)}
            title={file.path}
          >
            {file.path}
          </button>
          {file.encoding === 'base64' && <span className="ml-2 text-fg-faint">({t('skillCenter.binaryFile')})</span>}
          {openPath === file.path && file.encoding !== 'base64' && (
            <pre className="mt-1 mb-2 p-2 rounded-md bg-surface-sunken border border-edge max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-relaxed">
              {file.content}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

function SkillHistory({ skill, usersById }: { skill: SkillSummary; usersById: Map<string, string> }) {
  const t = useT();
  const [versions, setVersions] = useState<SkillVersionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filesOpenFor, setFilesOpenFor] = useState<string | null>(null);

  useEffect(() => {
    getSkill(skill.name)
      .then((detail) => setVersions(detail.versions))
      .catch((e) => setError(e.message));
  }, [skill.name, skill.latest_version, skill.status]);

  const nameOf = (id: string) => usersById.get(id) ?? id;

  if (error) return <div className="text-xs text-danger p-3">{error}</div>;
  if (!versions)
    return (
      <div className="p-3">
        <Spinner />
      </div>
    );

  return (
    <div className="p-3 space-y-3 animate-fade-in">
      <div className="flex items-center gap-3 text-xs text-fg-muted flex-wrap">
        <span>
          {t('skillCenter.owner')}: <span className="text-fg-secondary">{nameOf(skill.owner_user_id)}</span>
        </span>
        <span>
          {t('skillCenter.createdAt')}: <span className="text-fg-secondary">{formatDate(skill.created_at)}</span>
        </span>
        <span className="font-mono text-fg-faint">{skill.name}</span>
      </div>

      <div>
        <div className="text-xs font-medium text-fg-muted mb-1.5">{t('skillCenter.versionHistory')}</div>
        <div className="space-y-2">
          {versions.map((v) => (
            <div key={v.version} className="rounded-md border border-edge bg-surface-raised p-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                <Tag tone={v.version === skill.latest_version ? 'primary' : 'neutral'}>v{v.version}</Tag>
                <span className="text-xs text-fg-faint" title={v.created_at}>
                  {timeAgo(v.created_at)} · {t('skillCenter.by')} {nameOf(v.created_by)} · {v.file_count}{' '}
                  {t('skillCenter.files')} · {formatSize(v.size_bytes)}
                </span>
                <div className="flex-1" />
                <button
                  className="text-xs text-fg-muted hover:text-fg inline-flex items-center gap-1"
                  onClick={() => setFilesOpenFor(filesOpenFor === v.version ? null : v.version)}
                >
                  {filesOpenFor === v.version ? t('skillCenter.hideFiles') : t('skillCenter.viewFiles')}
                </button>
                <button
                  className="text-xs text-fg-muted hover:text-fg inline-flex items-center gap-1"
                  onClick={() =>
                    downloadSkillBundle(skill.name, v.version)
                      .then((bundle) => saveJsonFile(`${skill.name}-${v.version}.json`, bundle))
                      .catch((e) => toast(e.message, 'error'))
                  }
                >
                  <Download size={12} />
                  {t('skillCenter.downloadJson')}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-fg-secondary whitespace-pre-wrap">{v.changelog}</p>
              {filesOpenFor === v.version && <VersionFiles name={skill.name} version={v.version} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Panel ───────────────────────────────────────────────

export function SkillCenterPanel() {
  const t = useT();
  const { currentUser } = useAuthStore();
  const isSuper = currentUser?.role === 'super';
  const [usersById, setUsersById] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    fetchShareableUsers().then((users) => setUsersById(new Map(users.map((u) => [u.id, u.nickname]))));
  }, []);

  const canManage = useMemo(
    () => (row: SkillSummary) => isSuper || row.owner_user_id === currentUser?.id,
    [isSuper, currentUser?.id],
  );

  const schema = useMemo(
    () =>
      defineCrud<SkillSummary>({
        name: 'Skill',
        icon: Package,
        idField: 'name',
        dataSource,
        pageSize: 50,
        storageKey: 'skill-center',
        emptyMessage: t('skillCenter.empty'),
        columns: [
          {
            key: 'display_name',
            label: t('skillCenter.colSkill'),
            type: 'custom',
            render: (row) => (
              <div className="min-w-0">
                <div className="text-sm text-fg truncate" title={row.display_name}>
                  {row.display_name}
                </div>
                {row.display_name !== row.name && <div className="text-[10px] font-mono text-fg-faint">{row.name}</div>}
              </div>
            ),
          },
          { key: 'description', label: t('skillCenter.colDescription'), truncate: 48 },
          {
            key: 'tags',
            label: t('skillCenter.colTags'),
            type: 'custom',
            render: (row) =>
              row.tags.length ? <TagList items={row.tags} max={3} /> : <span className="text-fg-faint">—</span>,
          },
          {
            key: 'latest_version',
            label: t('skillCenter.colVersion'),
            type: 'custom',
            render: (row) => <span className="font-mono text-xs">v{row.latest_version}</span>,
          },
          { key: 'download_count', label: t('skillCenter.colDownloads'), type: 'number' },
          {
            key: 'status',
            label: t('skillCenter.colStatus'),
            type: 'badge',
            badgeMap: { active: 'success', archived: 'secondary' },
          },
          { key: 'updated_at', label: t('skillCenter.colUpdated'), type: 'datetime' },
        ],
        filters: [
          {
            key: 'name',
            label: t('skillCenter.colSkill'),
            kind: 'text',
            placeholder: t('skillCenter.searchPlaceholder'),
          },
          {
            key: 'status',
            label: t('skillCenter.colStatus'),
            kind: 'select',
            options: [
              { value: 'active', label: t('skillCenter.statusActive') },
              { value: 'archived', label: t('skillCenter.statusArchived') },
            ],
          },
        ],
        access: { canView: false, canAdd: false, canEdit: false, canDelete: isSuper },
        tableActions: [
          {
            key: 'archive-toggle',
            label: (row) => (row.status === 'archived' ? t('skillCenter.unarchive') : t('skillCenter.archive')),
            icon: Archive,
            visible: canManage,
            onClick: async (row, ctx) => {
              try {
                if (row.status === 'archived') {
                  await unarchiveSkill(row.name);
                  toast(t('skillCenter.unarchived'), 'success');
                } else {
                  await archiveSkill(row.name);
                  toast(t('skillCenter.archived'), 'success');
                }
                ctx.reload();
              } catch (e: unknown) {
                toast(e instanceof Error ? e.message : t('skillCenter.actionFailed'), 'error');
              }
            },
          },
        ],
        slots: {
          rowExpand: (row) => <SkillHistory skill={row} usersById={usersById} />,
        },
      }),
    [t, isSuper, canManage, usersById],
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-muted max-w-2xl">{t('skillCenter.hint')}</p>
      <CrudPage schema={schema} />
    </div>
  );
}
