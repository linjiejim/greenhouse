/**
 * ```mission-artifacts fenced block — a Cloud Agent run's deliverables, one
 * file card each (src/chat/file-card.tsx; tap → authenticated download into
 * the share sheet). Web parity: MissionArtifactsBlock (its HTML side-pane
 * preview has no mobile counterpart — the file opens from the share sheet).
 */
import { useMemo } from 'react';
import { View } from 'react-native';
import { space } from '../../../theme';
import { FileCard, fileDetail } from '../../file-card';
import { richSegment } from '../rich';
import { CodeBlock } from './code';

export const missionArtifactPath = (runId: string, id: number) =>
  `/api/missions/runs/${encodeURIComponent(runId)}/artifacts/${id}/download`;

export function MissionArtifactsBlock({ raw }: { raw: string }) {
  const seg = useMemo(() => richSegment('mission-artifacts', raw), [raw]);
  if (seg?.type !== 'mission-artifacts') return <CodeBlock lang="mission-artifacts" code={raw} />;
  if (!seg.data.length) return null;
  return (
    <View style={{ gap: space.xs + 2, marginVertical: space.sm + 2 }}>
      {seg.data.map((item) => {
        const name = item.path.split('/').pop() || item.path;
        return (
          <FileCard
            key={`${item.run_id}:${item.id}`}
            name={name}
            detail={fileDetail(item.size_bytes, item.path === name ? undefined : item.path)}
            path={missionArtifactPath(item.run_id, item.id)}
          />
        );
      })}
    </View>
  );
}
