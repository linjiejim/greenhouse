/**
 * SkillDetail — right-pane skill view: fixed header (meta + actions) + two tabs
 * (Guide = rendered SKILL.md, Versions = changelog/file history).
 *
 * SKILL.md is fetched via the bundle with meter:false so opening a skill never
 * inflates its download_count; only an explicit confirmed ZIP download counts.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, ConfirmDialog, IconButton, Select, Spinner, Tag, Tabs, toast } from '../ui';
import { Markdown } from '../markdown';
import {
  Archive,
  ArrowLeft,
  CheckCircle,
  Download,
  Package,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Upload,
} from '../../lib/icons';
import {
  archiveSkill,
  decideSkillScan,
  deleteSkill,
  downloadSkillBundle,
  getSkill,
  rescanSkill,
  unarchiveSkill,
  type SkillSummary,
  type SkillVersionSummary,
} from '../../lib/api/skills';
import { fetchShareableUsers } from '../../lib/api';
import { useAuthStore } from '../../stores';
import { needsReview } from './grouping';
import { SkillHistory } from './skill-history';
import { SkillDownloadConfirm, type SkillDownloadTarget } from './skill-download-confirm';
import { SkillUploadDialog } from './skill-upload-dialog';
import { reloadSkills } from './use-skills';
import { useT } from '../../lib/i18n';

/** Strip a leading YAML frontmatter block so only the SKILL.md body is rendered. */
function stripFrontmatter(md: string): string {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? md.slice(m[0].length) : md;
}

interface Detail {
  skill: SkillSummary;
  versions: SkillVersionSummary[];
}

export function SkillDetail({ name, backHref }: { name: string; backHref?: string }) {
  const t = useT();
  const { currentUser } = useAuthStore();
  const isSuper = currentUser?.role === 'super';

  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [guide, setGuide] = useState<string | null>(null);
  const [guideError, setGuideError] = useState<string | null>(null);
  const [usersById, setUsersById] = useState<Map<string, string>>(new Map());
  const [tab, setTab] = useState<'guide' | 'versions'>('guide');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [downloadVersion, setDownloadVersion] = useState('');
  const [downloadTarget, setDownloadTarget] = useState<SkillDownloadTarget | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadDetail = useCallback(() => {
    getSkill(name)
      .then(setDetail)
      .catch((e) => setError(e.message));
  }, [name]);

  // Reset per-skill state when the selected skill changes, then load. Guard the
  // async resolutions so a fast A→B switch can't render A's data under B (the
  // in-flight A requests resolve after B's effect has already re-run).
  useEffect(() => {
    let ignore = false;
    setDetail(null);
    setError(null);
    setGuide(null);
    setGuideError(null);
    setTab('guide');
    setDownloadVersion('');
    getSkill(name)
      .then((d) => {
        if (!ignore) setDetail(d);
      })
      .catch((e) => {
        if (!ignore) setError(e.message);
      });
    downloadSkillBundle(name, undefined, { meter: false })
      .then((bundle) => {
        if (ignore) return;
        const md = bundle.files.find((f) => f.path === 'SKILL.md');
        setGuide(md ? stripFrontmatter(md.content) : '');
      })
      .catch((e) => {
        if (!ignore) setGuideError(e.message);
      });
    return () => {
      ignore = true;
    };
  }, [name]);

  useEffect(() => {
    // shareable-users excludes the caller, so seed the map with the current user
    // — otherwise a skill you own (incl. seeded first-party) shows a raw UUID.
    const base = new Map<string, string>();
    if (currentUser) base.set(currentUser.id, currentUser.nickname);
    setUsersById(new Map(base));
    fetchShareableUsers()
      .then((users) => setUsersById(new Map([...base, ...users.map((u) => [u.id, u.nickname] as const)])))
      .catch(() => {});
  }, [currentUser]);

  const skill = detail?.skill;
  const canManage = useMemo(
    () => !!skill && (isSuper || skill.owner_user_id === currentUser?.id),
    [skill, isSuper, currentUser?.id],
  );

  const runAction = useCallback(
    async (fn: () => Promise<unknown>, okMsg: string) => {
      setBusy(true);
      try {
        await fn();
        toast(okMsg, 'success');
        await reloadSkills();
        reloadDetail();
      } catch (e) {
        toast(e instanceof Error ? e.message : t('common.operationFailed'), 'error');
      } finally {
        setBusy(false);
      }
    },
    [reloadDetail, t],
  );

  if (error)
    return (
      <div className="h-full flex flex-col">
        {backHref && <MobileBack backHref={backHref} />}
        <div className="p-6 text-sm text-danger">{error}</div>
      </div>
    );
  if (!skill)
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner className="h-6 w-6 text-fg-faint" />
      </div>
    );

  const ownerName = usersById.get(skill.owner_user_id) ?? skill.owner_user_id;
  const selectedVersion = downloadVersion || skill.latest_version;
  const flagged = needsReview(skill);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {backHref && <MobileBack backHref={backHref} />}

      {/* Fixed header */}
      <header className="flex-shrink-0 border-b border-edge bg-surface-raised px-4 md:px-6 py-3">
        <div className="flex flex-col md:flex-row md:items-start gap-3">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <div className="mt-0.5 flex-shrink-0 w-9 h-9 rounded-lg bg-surface-muted flex items-center justify-center">
              <Package size={18} className="text-fg-muted" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-base font-medium text-fg truncate" title={skill.display_name}>
                  {skill.display_name}
                </h1>
                <Badge variant={skill.status === 'archived' ? 'secondary' : 'success'}>{skill.status}</Badge>
                {skill.scan_status === 'suspicious' && <Tag tone="warning">{t('skillHub.scanSuspicious')}</Tag>}
                {skill.scan_status === 'blocked' && <Tag tone="danger">{t('skillHub.scanBlocked')}</Tag>}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-xs text-fg-faint flex-wrap">
                <span className="font-mono">{skill.name}</span>
                <span>·</span>
                <span className="font-mono">v{skill.latest_version}</span>
                <span>·</span>
                <span>{ownerName}</span>
                <span>·</span>
                <span>{t('skillHub.downloadCount', { count: skill.download_count })}</span>
              </div>
              {skill.tags.length > 0 && (
                <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                  {skill.tags.map((t) => (
                    <Tag key={t} tone={t === 'official' ? 'primary' : 'neutral'}>
                      {t}
                    </Tag>
                  ))}
                </div>
              )}
            </div>
          </div>

          <SkillHeaderActions
            skill={skill}
            versions={detail?.versions ?? []}
            selectedVersion={selectedVersion}
            onSelectVersion={setDownloadVersion}
            canManage={canManage}
            isSuper={isSuper}
            busy={busy}
            onUpload={() => setUploadOpen(true)}
            onDelete={() => setConfirmDelete(true)}
            onToggleArchive={() =>
              skill.status === 'archived'
                ? runAction(() => unarchiveSkill(skill.name), t('skillHub.restored'))
                : runAction(() => archiveSkill(skill.name), t('skillHub.archived'))
            }
            onDownload={() =>
              setDownloadTarget({ name: skill.name, displayName: skill.display_name, version: selectedVersion })
            }
          />
        </div>

        <div className="mt-3">
          <Tabs
            tabs={[
              { key: 'guide', label: t('skillHub.guide') },
              { key: 'versions', label: t('skillHub.versions'), count: detail?.versions.length },
            ]}
            active={tab}
            onChange={(k) => setTab(k as 'guide' | 'versions')}
          />
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-4">
        {flagged && (
          <ScanPanel skill={skill} isSuper={isSuper} busy={busy} onDecide={setConfirmBlock} run={runAction} />
        )}
        {tab === 'guide' ? (
          guideError ? (
            <div className="text-sm text-danger">{guideError}</div>
          ) : guide === null ? (
            <div className="py-4">
              <Spinner />
            </div>
          ) : guide.trim() === '' ? (
            <div className="text-sm text-fg-faint">{t('skillHub.noGuideBody')}</div>
          ) : (
            <Markdown content={guide} />
          )
        ) : (
          <SkillHistory skill={skill} usersById={usersById} />
        )}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          setConfirmDelete(false);
          setBusy(true);
          try {
            await deleteSkill(skill.name);
            toast(t('skillHub.deleted'), 'success');
            await reloadSkills();
            window.location.hash = '#/skillhub'; // unmounts this view — no detail refetch
          } catch (e) {
            toast(e instanceof Error ? e.message : t('common.deleteFailed'), 'error');
            setBusy(false);
          }
        }}
        title={t('skillHub.deleteTitle', { name: skill.display_name })}
        description={t('skillHub.deleteDescription')}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />

      <ConfirmDialog
        open={confirmBlock}
        onClose={() => setConfirmBlock(false)}
        onConfirm={async () => {
          setConfirmBlock(false);
          await runAction(() => decideSkillScan(skill.name, 'blocked'), t('skillHub.blockedToast'));
        }}
        title={t('skillHub.confirmMaliciousTitle', { name: skill.display_name })}
        description={t('skillHub.confirmMaliciousDescription')}
        confirmLabel={t('skillHub.confirmMalicious')}
        confirmVariant="destructive"
      />

      <SkillDownloadConfirm target={downloadTarget} onClose={() => setDownloadTarget(null)} />

      <SkillUploadDialog
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        skill={skill}
        onPublished={() => reloadDetail()}
      />
    </div>
  );
}

/**
 * Whether the Download button should be disabled for this viewer.
 *
 * Mirrors the server's rule (skills/center.ts `quarantineError`) so the button
 * states what the API will actually do. The server remains the boundary — this
 * only decides an affordance.
 */
export function isDownloadBlocked(skill: SkillSummary, opts: { isSuper: boolean; canManage: boolean }): boolean {
  if (opts.isSuper) return false; // supers can always pull, including for forensics
  if (skill.scan_status === 'blocked') return true; // sticky ban locks the owner out too
  if (skill.scan_status === 'suspicious') return !opts.canManage; // owner needs it to fix & republish
  return false;
}

/**
 * Header action bar — presentational, so it can be render-tested without the
 * detail view's data effects (the container/view split the mission cards use).
 */
export function SkillHeaderActions({
  skill,
  versions,
  selectedVersion,
  onSelectVersion,
  canManage,
  isSuper,
  busy,
  onDownload,
  onUpload,
  onToggleArchive,
  onDelete,
}: {
  skill: SkillSummary;
  versions: SkillVersionSummary[];
  selectedVersion: string;
  onSelectVersion: (version: string) => void;
  canManage: boolean;
  isSuper: boolean;
  busy: boolean;
  onDownload: () => void;
  onUpload: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const blocked = isDownloadBlocked(skill, { isSuper, canManage });
  return (
    <div className="flex-shrink-0 flex items-center gap-1.5 flex-wrap md:justify-end">
      {versions.length > 1 && (
        <Select
          size="sm"
          inline
          aria-label={t('skillHub.versionToDownload')}
          value={selectedVersion}
          onChange={(e) => onSelectVersion(e.target.value)}
        >
          {versions.map((v) => (
            <option key={v.version} value={v.version}>
              v{v.version}
              {v.version === skill.latest_version ? t('skillHub.latestSuffix') : ''}
            </option>
          ))}
        </Select>
      )}
      <IconButton
        label={
          blocked
            ? skill.scan_status === 'blocked'
              ? t('skillHub.downloadBlockedTitle')
              : t('skillHub.downloadPendingTitle')
            : t('skillHub.downloadZip')
        }
        size="compact"
        disabled={blocked}
        onClick={onDownload}
      >
        <Download size={14} />
      </IconButton>
      {canManage && (
        <IconButton label={t('skillHub.newVersion')} size="compact" disabled={busy} onClick={onUpload}>
          <Upload size={14} />
        </IconButton>
      )}
      {canManage && (
        <IconButton
          label={skill.status === 'archived' ? t('skillHub.unarchive') : t('common.archive')}
          size="compact"
          disabled={busy}
          onClick={onToggleArchive}
        >
          <Archive size={14} />
        </IconButton>
      )}
      {isSuper && (
        <IconButton label={t('common.delete')} variant="destructive" size="compact" disabled={busy} onClick={onDelete}>
          <Trash2 size={14} />
        </IconButton>
      )}
    </div>
  );
}

/**
 * Quarantine banner: why the skill is held, what matched, and — for a super —
 * the three rulings. `Confirm malicious` is destructive and permanent (it locks
 * out the owner too and blocks republishing), so it goes through ConfirmDialog.
 */
export function ScanPanel({
  skill,
  isSuper,
  busy,
  onDecide,
  run,
}: {
  skill: SkillSummary;
  isSuper: boolean;
  busy: boolean;
  onDecide: (open: boolean) => void;
  run: (fn: () => Promise<unknown>, okMsg: string) => Promise<void>;
}) {
  const t = useT();
  const blocked = skill.scan_status === 'blocked';
  const high = skill.scan_findings.filter((f) => f.severity === 'high');
  const other = skill.scan_findings.filter((f) => f.severity !== 'high');

  return (
    <div
      className={`mb-4 rounded-lg border p-3 ${blocked ? 'border-danger bg-danger-subtle' : 'border-warning bg-warning-subtle'}`}
    >
      <div className={`flex items-start gap-2 ${blocked ? 'text-danger' : 'text-warning'}`}>
        <ShieldAlert size={16} className="mt-0.5 flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">
            {blocked ? t('skillHub.scanBannerBlockedTitle') : t('skillHub.scanBannerFlaggedTitle')}
          </div>
          <p className="mt-0.5 text-xs">
            {blocked ? t('skillHub.scanBannerBlockedBody') : t('skillHub.scanBannerFlaggedBody')}
            {skill.scan_version && t('skillHub.scannedVersion', { version: skill.scan_version })}
          </p>
          {skill.scan_note && (
            <p className="mt-1 text-xs italic">{t('skillHub.reviewerNote', { note: skill.scan_note })}</p>
          )}
        </div>
      </div>

      {(high.length > 0 || other.length > 0) && (
        <div className="mt-2 space-y-1">
          {[...high, ...other].map((f, i) => (
            <div key={`${f.rule}-${f.path ?? 'meta'}-${i}`} className="text-[11px] text-fg-secondary">
              <Tag tone={f.severity === 'high' ? 'danger' : 'neutral'}>{f.rule}</Tag>
              {f.path && <span className="ml-1.5 font-mono text-fg-faint">{f.path}</span>}
              <div className="mt-0.5 font-mono break-all text-fg-muted">{f.excerpt}</div>
            </div>
          ))}
        </div>
      )}

      {isSuper && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run(() => decideSkillScan(skill.name, 'clean'), t('skillHub.markedCleanToast'))}
          >
            <CheckCircle size={14} className="mr-1" />
            {t('skillHub.markClean')}
          </Button>
          {!blocked && (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDecide(true)}>
              <ShieldAlert size={14} className="mr-1 text-danger" />
              {t('skillHub.confirmMalicious')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void run(() => rescanSkill(skill.name), t('skillHub.rescanDone'))}
          >
            <RefreshCw size={14} className="mr-1" />
            {t('skillHub.rescan')}
          </Button>
        </div>
      )}
    </div>
  );
}

function MobileBack({ backHref }: { backHref: string }) {
  const t = useT();
  return (
    <a
      href={backHref}
      className="md:hidden flex items-center gap-1.5 px-4 h-11 border-b border-edge text-sm text-fg-secondary hover:text-fg flex-shrink-0"
    >
      <ArrowLeft size={16} />
      <span>{t('skillHub.allSkills')}</span>
    </a>
  );
}
