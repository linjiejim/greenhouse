/**
 * Skill version history — changelog list + per-version file viewer.
 *
 * Migrated verbatim from the old CRUD SkillCenterPanel (settings/skills.tsx),
 * now the "Versions" tab of SkillDetail. Passive bundle reads (file preview)
 * use meter:false so browsing doesn't inflate download_count; the explicit
 * confirmed ZIP download is a real pull and keeps the default (metered).
 */

import React, { useEffect, useState } from 'react';
import { Spinner, Tag } from '../ui';
import { Download } from '../../lib/icons';
import {
  downloadSkillBundle,
  getSkill,
  type SkillFileEntry,
  type SkillSummary,
  type SkillVersionSummary,
} from '../../lib/api/skills';
import { formatDate, timeAgo } from '../../lib/utils';
import { useT } from '../../lib/i18n';
import { SkillDownloadConfirm, type SkillDownloadTarget } from './skill-download-confirm';

export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function VersionFiles({ name, version }: { name: string; version: string }) {
  const t = useT();
  const [files, setFiles] = useState<SkillFileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);

  useEffect(() => {
    // Preview only — don't count as a download. Guard against a stale response
    // landing under a newer (name, version) selection.
    let ignore = false;
    downloadSkillBundle(name, version, { meter: false })
      .then((bundle) => {
        if (!ignore) setFiles(bundle.files);
      })
      .catch((e) => {
        if (!ignore) setError(e.message);
      });
    return () => {
      ignore = true;
    };
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
          {file.encoding === 'base64' && <span className="ml-2 text-fg-faint">{t('skillHub.binaryBase64')}</span>}
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

export function SkillHistory({ skill, usersById }: { skill: SkillSummary; usersById: Map<string, string> }) {
  const t = useT();
  const [versions, setVersions] = useState<SkillVersionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filesOpenFor, setFilesOpenFor] = useState<string | null>(null);
  const [downloadTarget, setDownloadTarget] = useState<SkillDownloadTarget | null>(null);

  useEffect(() => {
    let ignore = false;
    getSkill(skill.name)
      .then((detail) => {
        if (!ignore) setVersions(detail.versions);
      })
      .catch((e) => {
        if (!ignore) setError(e.message);
      });
    return () => {
      ignore = true;
    };
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
    <div className="space-y-3 animate-fade-in">
      <div className="flex items-center gap-3 text-xs text-fg-muted flex-wrap">
        <span>
          {t('skillHub.owner')}: <span className="text-fg-secondary">{nameOf(skill.owner_user_id)}</span>
        </span>
        <span>
          {t('skillHub.created')}: <span className="text-fg-secondary">{formatDate(skill.created_at)}</span>
        </span>
        <span className="font-mono text-fg-faint">{skill.name}</span>
      </div>

      <div>
        <div className="text-xs font-medium text-fg-muted mb-1.5">{t('skillHub.versionHistory')}</div>
        <div className="space-y-2">
          {versions.map((v) => (
            <div key={v.version} className="rounded-md border border-edge bg-surface-card p-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                <Tag tone={v.version === skill.latest_version ? 'primary' : 'neutral'}>v{v.version}</Tag>
                <span className="text-xs text-fg-faint" title={v.created_at}>
                  {t('skillHub.versionMeta', {
                    time: timeAgo(v.created_at),
                    author: nameOf(v.created_by),
                    count: v.file_count,
                    size: formatSize(v.size_bytes),
                  })}
                </span>
                <div className="flex-1" />
                <button
                  className="text-xs text-fg-muted hover:text-fg inline-flex items-center gap-1"
                  onClick={() => setFilesOpenFor(filesOpenFor === v.version ? null : v.version)}
                >
                  {filesOpenFor === v.version ? t('skillHub.hideFiles') : t('skillHub.viewFiles')}
                </button>
                <button
                  className="text-xs text-fg-muted hover:text-fg inline-flex items-center gap-1"
                  onClick={() =>
                    setDownloadTarget({ name: skill.name, displayName: skill.display_name, version: v.version })
                  }
                >
                  <Download size={12} />
                  {t('skillHub.downloadZip')}
                </button>
              </div>
              <p className="mt-1.5 text-xs text-fg-secondary whitespace-pre-wrap">{v.changelog}</p>
              {filesOpenFor === v.version && <VersionFiles name={skill.name} version={v.version} />}
            </div>
          ))}
        </div>
      </div>
      <SkillDownloadConfirm target={downloadTarget} onClose={() => setDownloadTarget(null)} />
    </div>
  );
}
