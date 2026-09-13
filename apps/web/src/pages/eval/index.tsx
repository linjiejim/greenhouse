/**
 * Evaluation page — manage test datasets, run evals, view results.
 * Sub-tabs: Runs | Datasets
 */

import React from 'react';
import { Tabs } from '../../components/ui';
import { DatasetsPanel } from './datasets';
import { RunsPanel } from './runs';
import { RunDetail } from './run-detail';
import { useT } from '../../lib/i18n';
import { ModulePage } from '../../components/app/module-page';

export function EvalPage({ subPath }: { subPath: string }) {
  const t = useT();
  const segments = subPath.split('/').filter(Boolean);
  let subTab: string;
  if (segments[0] === 'datasets') subTab = 'datasets';
  else subTab = 'runs';
  const detailRunId = segments[0] === 'runs' && segments[1] ? segments[1] : null;

  const setSubTab = (tab: string) => {
    if (tab === 'datasets') window.location.hash = '#/administration/eval/datasets';
    else window.location.hash = '#/administration/eval';
  };

  return (
    <ModulePage
      moduleId="admin.eval"
      layout="canvas"
      tabs={
        <div className="overflow-x-auto scrollbar-hide -mx-1 px-1">
          <Tabs
            tabs={[
              { key: 'runs', label: t('eval.runs') },
              { key: 'datasets', label: t('eval.datasets') },
            ]}
            active={subTab}
            onChange={setSubTab}
          />
        </div>
      }
    >
      <div className="h-full overflow-y-auto">
        {subTab === 'runs' && !detailRunId && <RunsPanel />}
        {subTab === 'runs' && detailRunId && (
          <RunDetail runId={detailRunId} onBack={() => (window.location.hash = '#/administration/eval')} />
        )}
        {subTab === 'datasets' && <DatasetsPanel />}
      </div>
    </ModulePage>
  );
}
