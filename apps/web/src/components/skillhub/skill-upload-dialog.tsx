/**
 * SkillUploadDialog — publish a skill (or a new version of one) from the web.
 *
 * A centered `<Dialog size="lg">` per the CRUD-form convention: this is a form
 * in the context of the list it publishes into, not a workspace.
 *
 * Two modes, one component:
 *  - create  → name comes from SKILL.md frontmatter and is shown read-only,
 *              because the name IS the skill's identity.
 *  - version → name is fixed to the skill being viewed; changelog is required
 *              and the version defaults to a patch bump.
 *
 * The repo's `skillhub/` directory remains the single source of truth for
 * first-party (`official`) skills — uploading over one gets an explicit warning
 * that the next deploy re-seeds it from the repo (spec D5).
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Input, Spinner, Textarea, toast } from '../ui';
import { AlertTriangle, Upload } from '../../lib/icons';
import { publishSkill, type SkillSummary } from '../../lib/api/skills';
import { bumpPatch, isValidSemver } from '@greenhouse/utils/semver';
import {
  deriveDisplayName,
  entriesFromZip,
  filesToSkillBundle,
  readFrontmatter,
  MAX_BUNDLE_BYTES,
  MAX_FILES,
  type BundleFile,
  type RawEntry,
} from './bundle-from-files';
import { reloadSkills } from './use-skills';
import { useT } from '../../lib/i18n';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Set when publishing a new version of an existing skill (name is locked). */
  skill?: SkillSummary;
  /** Called with the published skill's name after a successful publish. */
  onPublished?: (name: string) => void;
}

interface Parsed {
  files: BundleFile[];
  sizeBytes: number;
  frontmatterName?: string;
  description?: string;
  displayName?: string;
  version?: string;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

async function readEntries(fileList: File[]): Promise<RawEntry[]> {
  const entries: RawEntry[] = [];
  for (const file of fileList) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.zip$/i.test(file.name)) entries.push(...entriesFromZip(bytes));
    // webkitRelativePath is set when a directory was picked; it preserves the
    // folder shape that stripCommonRoot then removes.
    else
      entries.push({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, bytes });
  }
  return entries;
}

export function SkillUploadDialog({ open, onClose, skill, onPublished }: Props) {
  const t = useT();
  const isVersionMode = skill !== undefined;
  const inputRef = useRef<HTMLInputElement>(null);

  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [version, setVersion] = useState('');
  const [changelog, setChangelog] = useState('');

  const reset = useCallback(() => {
    setParsed(null);
    setParseError(null);
    setDragging(false);
    setBusy(false);
    setDisplayName('');
    setDescription('');
    setTags('');
    setVersion('');
    setChangelog('');
  }, []);

  const closeAndReset = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  const ingest = useCallback(
    async (fileList: File[]) => {
      setParseError(null);
      if (fileList.length === 0) return;
      try {
        const result = filesToSkillBundle(await readEntries(fileList));
        if (!result.ok) {
          setParsed(null);
          setParseError(result.error);
          return;
        }
        const skillMd = result.files.find((f) => f.path === 'SKILL.md')!;
        const front = skillMd.encoding === 'base64' ? {} : readFrontmatter(skillMd.content);
        const derived = skillMd.encoding === 'base64' ? undefined : deriveDisplayName(skillMd.content);
        setParsed({
          files: result.files,
          sizeBytes: result.sizeBytes,
          frontmatterName: front.name,
          description: front.description,
          displayName: derived,
          version: front.version,
        });
        setDisplayName(derived ?? skill?.display_name ?? '');
        setDescription(front.description ?? skill?.description ?? '');
        setTags((skill?.tags ?? []).join(', '));
        setVersion(
          front.version ?? (skill && isValidSemver(skill.latest_version) ? bumpPatch(skill.latest_version) : '0.1.0'),
        );
      } catch (e) {
        setParsed(null);
        setParseError(
          e instanceof Error
            ? t('skillHub.uploadDialog.readFailedWith', { error: e.message })
            : t('skillHub.uploadDialog.readFailed'),
        );
      }
    },
    [skill, t],
  );

  const targetName = skill?.name ?? parsed?.frontmatterName ?? '';
  const isOfficial = (skill?.tags ?? []).includes('official');

  const submitError = useMemo(() => {
    if (!parsed) return t('skillHub.uploadDialog.errNoFiles');
    if (!targetName) return t('skillHub.uploadDialog.errNoName');
    if (isVersionMode && !changelog.trim()) return t('skillHub.uploadDialog.errNoChangelog');
    if (isVersionMode && parsed.frontmatterName && parsed.frontmatterName !== skill!.name) {
      return t('skillHub.uploadDialog.errNameMismatch', { found: parsed.frontmatterName, expected: skill!.name });
    }
    return null;
  }, [parsed, targetName, isVersionMode, changelog, skill, t]);

  const submit = useCallback(async () => {
    if (!parsed || submitError) return;
    setBusy(true);
    try {
      const published = await publishSkill({
        name: targetName,
        display_name: displayName.trim() || undefined,
        description: description.trim() || undefined,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        version: version.trim() || undefined,
        changelog: changelog.trim() || undefined,
        files: parsed.files,
      });
      toast(
        published.created
          ? t('skillHub.uploadDialog.publishedNew', {
              name: published.skill.name,
              version: published.version.version,
            })
          : t('skillHub.uploadDialog.publishedVersion', {
              name: published.skill.name,
              version: published.version.version,
            }),
        'success',
      );
      if (published.skill.scan_status === 'suspicious') {
        toast(t('skillHub.uploadDialog.flaggedOnPublish'), 'error');
      }
      await reloadSkills();
      onPublished?.(published.skill.name);
      closeAndReset();
    } catch (e) {
      toast(e instanceof Error ? e.message : t('skillHub.uploadDialog.publishFailed'), 'error');
    } finally {
      setBusy(false);
    }
  }, [
    parsed,
    submitError,
    targetName,
    displayName,
    description,
    tags,
    version,
    changelog,
    onPublished,
    closeAndReset,
    t,
  ]);

  return (
    <Dialog
      open={open}
      onClose={closeAndReset}
      title={
        isVersionMode
          ? t('skillHub.uploadDialog.versionTitle', { name: skill!.display_name })
          : t('skillHub.uploadDialog.title')
      }
      size="lg"
    >
      <div className="space-y-4">
        {/* Drop zone */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void ingest(Array.from(e.dataTransfer.files));
          }}
          onClick={() => inputRef.current?.click()}
          className={`rounded-lg border border-dashed px-4 py-6 text-center cursor-pointer transition-colors ${
            dragging ? 'border-primary-500 bg-primary-subtle' : 'border-edge-strong hover:bg-surface-muted'
          }`}
        >
          <Upload size={20} className="mx-auto text-fg-faint" />
          <div className="mt-2 text-sm text-fg-secondary">{t('skillHub.uploadDialog.dropHint')}</div>
          <div className="mt-0.5 text-xs text-fg-faint">
            {t('skillHub.uploadDialog.limits', { files: MAX_FILES, size: formatSize(MAX_BUNDLE_BYTES) })}
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".zip,.md,.markdown,.txt,.json,.yml,.yaml,.svg,.png,.jpg,.jpeg,.gif,.webp,.html,.css,.js,.mjs,.cjs,.ts,.xml,.csv"
            className="hidden"
            onChange={(e) => {
              void ingest(Array.from(e.target.files ?? []));
              e.target.value = ''; // allow re-picking the same file
            }}
          />
        </div>

        {parseError && (
          <div className="rounded-md border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger">
            {parseError}
          </div>
        )}

        {parsed && (
          <>
            {isOfficial && (
              <div className="flex items-start gap-2 rounded-md border border-warning bg-warning-subtle px-3 py-2 text-xs text-warning">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                <span>{t('skillHub.uploadDialog.officialWarning')}</span>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('skillHub.uploadDialog.name')} hint={t('skillHub.uploadDialog.nameHint')}>
                <Input size="sm" value={targetName} readOnly disabled />
              </Field>
              <Field label={t('skillHub.uploadDialog.version')}>
                <Input size="sm" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="0.1.0" />
              </Field>
              <Field label={t('skillHub.uploadDialog.displayName')}>
                <Input size="sm" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </Field>
              <Field label={t('skillHub.uploadDialog.tags')} hint={t('skillHub.uploadDialog.tagsHint')}>
                <Input size="sm" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="pdf, report" />
              </Field>
            </div>

            <Field label={t('skillHub.uploadDialog.description')}>
              <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>

            <Field
              label={
                isVersionMode ? t('skillHub.uploadDialog.changelogRequired') : t('skillHub.uploadDialog.changelog')
              }
            >
              <Textarea
                rows={2}
                value={changelog}
                onChange={(e) => setChangelog(e.target.value)}
                placeholder={
                  isVersionMode
                    ? t('skillHub.uploadDialog.changelogPlaceholder')
                    : t('skillHub.uploadDialog.changelogInitial')
                }
              />
            </Field>

            <div>
              <div className="text-xs font-medium text-fg-muted">
                {t('skillHub.uploadDialog.fileSummary', {
                  count: parsed.files.length,
                  size: formatSize(parsed.sizeBytes),
                })}
              </div>
              <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-edge bg-surface-sunken p-2 space-y-0.5">
                {parsed.files.map((f) => (
                  <div key={f.path} className="flex items-center gap-2 text-[11px]">
                    <span className="font-mono text-fg-secondary truncate" title={f.path}>
                      {f.path}
                    </span>
                    {f.encoding === 'base64' && (
                      <span className="text-fg-faint flex-shrink-0">{t('skillHub.uploadDialog.binary')}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          {submitError && parsed && <span className="mr-auto text-xs text-fg-faint">{submitError}</span>}
          <Button variant="ghost" size="sm" onClick={closeAndReset} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy || submitError !== null}>
            {busy ? <Spinner className="mr-1 h-3.5 w-3.5" /> : <Upload size={14} className="mr-1" />}
            {t('skillHub.uploadDialog.publish')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-fg-muted">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-0.5 block text-[11px] text-fg-faint">{hint}</span>}
    </label>
  );
}
