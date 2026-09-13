/**
 * MissionArtifactsBlock — file cards for a mission outcome message's
 * ```mission-artifacts fence (Cloud Agent run deliverables).
 *
 * Reuses the house FileAttachmentCard; downloads go through the authenticated
 * /api/missions/runs/:run_id/artifacts/:id/download endpoint (a plain
 * <a href> carries no Bearer). Items were already shape-checked by
 * parseSegments; an empty list renders nothing.
 */

import React from 'react';
import { PanelRight } from 'lucide-react';
import { FileAttachmentCard } from '../files/file-attachment-card';
import { Button, toast } from '../ui';
import { useT } from '../../lib/i18n';
import { authFetch } from '../../lib/auth';
import { downloadAuthenticatedFile } from '../../lib/file-download';
import { cloudAgentArtifactDownloadUrl, isPreviewableHtmlArtifact } from '../../lib/api/cloud-agent';
import { openSidePane, useSidePaneStore } from '../../stores/side-pane-store';
import type { MissionArtifactsData } from './index';

export function MissionArtifactsBlock({ data }: { data: MissionArtifactsData }) {
  const t = useT();
  const hostMounted = useSidePaneStore((s) => s.hostMounted);
  if (data.length === 0) return null;

  return (
    <div className="space-y-1.5">
      {data.map((item) => {
        const name = item.path.split('/').pop() || item.path;
        // The bytes live behind an authenticated endpoint, so the preview has
        // to fetch them and hand the pane a string — a sandboxed iframe has no
        // credentials of its own and could not load the URL itself.
        const canPreview = hostMounted && isPreviewableHtmlArtifact(item.path, item.size_bytes);
        return (
          <FileAttachmentCard
            key={`${item.run_id}:${item.id}`}
            name={name}
            size={item.size_bytes}
            detail={item.path === name ? undefined : item.path}
            downloadLabel={t('cloudAgent.download')}
            onDownload={() => downloadAuthenticatedFile(cloudAgentArtifactDownloadUrl(item.run_id, item.id), name)}
            downloadError={() => toast(t('cloudAgent.downloadFailed'), 'error')}
            secondaryAction={
              canPreview ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    try {
                      const res = await authFetch(cloudAgentArtifactDownloadUrl(item.run_id, item.id));
                      if (!res.ok) throw new Error('preview failed');
                      // sourcePath is the artifact's stable identity: when a
                      // follow-up run rewrites this same file, the settle
                      // handler matches on it and refreshes this open pane.
                      openSidePane({ kind: 'html', code: await res.text(), title: name, sourcePath: item.path });
                    } catch {
                      toast(t('cloudAgent.downloadFailed'), 'error');
                    }
                  }}
                >
                  <PanelRight size={14} className="mr-1.5" />
                  {t('sidePane.openPreview')}
                </Button>
              ) : undefined
            }
          />
        );
      })}
    </div>
  );
}
