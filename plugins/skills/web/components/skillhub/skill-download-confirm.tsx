import { ConfirmDialog, toast } from '@greenhouse/web/extension-kit';
import { downloadSkillArchive } from '../../api.js';
import { useT } from '@greenhouse/web/extension-kit';

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
      title={t('ext.skills.skillHub.downloadConfirmTitle', { name: target?.displayName ?? '' })}
      description={t('ext.skills.skillHub.downloadConfirmDescription', { version: target?.version ?? '' })}
      confirmLabel={t('ext.skills.skillHub.downloadConfirmAction')}
    />
  );
}
