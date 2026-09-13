/**
 * SessionTypeIcon — a HISTORICAL marker in the sidebar: conversations started
 * under the retired mission / workflow presets get a cloud or a graph.
 *
 * Nothing new earns an icon. Since the presets collapsed into one agent
 * (2026-08-01) every new session is `sprouty`, and what a conversation does is
 * decided per turn — by which dispatch card the user launches — not by the
 * agent it was opened with. These ids only ever appear on rows created before
 * that, so this list is closed and will never grow.
 *
 * Purely presentational; it renders in the leading indicator slot of the chat
 * history rows, yielding to the streaming/unread/important indicators.
 */

import React from 'react';
import { Cloud, Workflow } from '../../lib/icons';
import { useT } from '../../lib/i18n';

const RETIRED_MISSION_ID = 'sprouty-mission';
const RETIRED_WORKFLOW_IDS = new Set(['sprouty-workflows', 'workflow-planner', 'sprouty-agents']);

export function SessionTypeIcon({ profileId, size = 10 }: { profileId?: string | null; size?: number }) {
  const t = useT();
  if (profileId === RETIRED_MISSION_ID) {
    return (
      <span className="text-primary-fg" title={t('chat.cloudMission')}>
        <Cloud size={size} aria-hidden="true" />
      </span>
    );
  }
  if (profileId && RETIRED_WORKFLOW_IDS.has(profileId)) {
    return (
      <span className="text-fg-faint" title={t('chat.workflow')}>
        <Workflow size={size} aria-hidden="true" />
      </span>
    );
  }
  return null;
}
