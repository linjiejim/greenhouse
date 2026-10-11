/**
 * The app's published versions (spec D5): number, release notes, who
 * published it and when, which one is live — and "restore to draft", which
 * copies an old version into the draft (replacing it). Nothing people use
 * changes until the restored draft is published, as a new version: version
 * numbers only go up.
 */

import { useEffect, useState } from 'react';
import type { AppDraftView, AppSummary, AppVersionSummary } from '@greenhouse/types/apps';
import { Button, ConfirmDialog, Drawer, EmptyState, IconButton, Spinner, Tag, toast } from '../../../components/ui';
import { isRevisionConflict, listAppVersions, restoreAppVersion } from '../../../lib/api/apps-builder';
import { useT } from '../../../lib/i18n';
import { formatDate } from '../../../lib/utils';
import { History, RotateCcw, X } from '../../../lib/icons';

export function VersionsDrawer({
  open,
  onClose,
  app,
  flush,
  revision,
  onRestored,
  onConflict,
}: {
  open: boolean;
  onClose: () => void;
  app: AppSummary;
  flush: () => Promise<boolean>;
  revision: () => number;
  onRestored: (view: AppDraftView, version: number) => void;
  onConflict: () => void;
}) {
  const t = useT();
  const [versions, setVersions] = useState<AppVersionSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [restoring, setRestoring] = useState<AppVersionSummary | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setVersions(null);
    setFailed(false);
    listAppVersions(app.id)
      .then((next) => !cancelled && setVersions(next))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [app.id, app.publishedVersion, open]);

  const restore = async (version: AppVersionSummary) => {
    setBusy(true);
    try {
      // Pending edits are saved first, so the restore replaces what the builder sees.
      await flush();
      const view = await restoreAppVersion(app.id, version.version, revision());
      onRestored(view, version.version);
      toast(t('apps.builder.versions.restored', { version: version.version }), 'success');
    } catch (error) {
      if (isRevisionConflict(error)) onConflict();
      else toast(error instanceof Error ? error.message : t('apps.builder.versions.restoreFailed'), 'error');
    } finally {
      setBusy(false);
      setRestoring(null);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} side="right" width={420} ariaLabel={t('apps.builder.versions.title')}>
      <div className="flex h-full flex-col" data-testid="app-versions">
        <div className="flex items-center justify-between gap-2 border-b border-edge px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
            <History size={14} />
            {t('apps.builder.versions.title')}
          </h3>
          <IconButton label={t('common.close')} onClick={onClose}>
            <X size={14} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="mb-3 text-xs leading-4 text-fg-muted">{t('apps.builder.versions.intro')}</p>
          {failed ? (
            <p className="text-sm text-danger">{t('apps.builder.versions.loadFailed')}</p>
          ) : !versions ? (
            <div className="flex justify-center py-8">
              <Spinner className="h-5 w-5 text-fg-faint" />
            </div>
          ) : versions.length === 0 ? (
            <EmptyState variant="compact" icon={History} title={t('apps.builder.versions.empty')} />
          ) : (
            <ol className="space-y-2">
              {versions.map((version) => (
                <li
                  key={version.version}
                  className="space-y-1.5 rounded-lg border border-edge p-3"
                  data-testid={`app-version-${version.version}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm font-semibold text-fg">
                      {t('apps.builder.versions.label', { version: version.version })}
                      {version.version === app.publishedVersion && (
                        <Tag tone="primary">{t('apps.builder.versions.live')}</Tag>
                      )}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => setRestoring(version)}
                      data-testid={`app-version-restore-${version.version}`}
                    >
                      <RotateCcw size={12} className="mr-1.5" />
                      {t('apps.builder.versions.restore')}
                    </Button>
                  </div>
                  <p className="text-[11px] text-fg-faint">
                    {t('apps.builder.versions.by', {
                      name: version.publishedBy.name,
                      time: formatDate(version.publishedAt),
                    })}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-xs text-fg-secondary">
                    {version.notes || t('apps.builder.versions.noNotes')}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={restoring !== null}
        onClose={() => setRestoring(null)}
        onConfirm={() => restoring && void restore(restoring)}
        busy={busy}
        title={t('apps.builder.versions.restoreTitle', { version: restoring?.version ?? 0 })}
        description={t('apps.builder.versions.restoreDescription', {
          version: restoring?.version ?? 0,
          next: (app.publishedVersion ?? 0) + 1,
        })}
        confirmLabel={t('apps.builder.versions.restore')}
      />
    </Drawer>
  );
}
