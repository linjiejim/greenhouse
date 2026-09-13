import { ConfirmDialog, toast } from '../ui';
import { downloadSkillArchive } from '../../lib/api/skills';
import { useT } from '../../lib/i18n';

export interface SkillDownloadTarget {
  name: string;
  displayName: string;
  version: string;
}

/** One confirmation contract for every human-triggered SkillHub download. */
export function SkillDownloadConfirm({ target, onClose }: { target: SkillDownloadTarget | null; onClose: () => void }) {
  const t = useT();

  const download = () => {
    if (!target) return;
    const requested = target;
    onClose();
    void downloadSkillArchive(requested.name, requested.version).catch((error) =>
      toast(error instanceof Error ? error.message : t('common.downloadFailed'), 'error'),
    );
  };

  return (
    <ConfirmDialog
      open={target !== null}
      onClose={onClose}
      onConfirm={download}
      title={t('skillHub.downloadConfirmTitle', { name: target?.displayName ?? '' })}
      description={t('skillHub.downloadConfirmDescription', { version: target?.version ?? '' })}
      confirmLabel={t('skillHub.downloadConfirmAction')}
    />
  );
}
