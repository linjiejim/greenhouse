import type { RunView } from '../../lib/router';
import { useT } from '../../lib/i18n';
import { Page, PageHeader } from '../../shell/Page';

/** Runs: running, scheduled, finished (M1.4). */
export function RunsPage({ view }: { view: RunView }) {
  const t = useT();
  return <Page header={<PageHeader title={t(`runs.${view}`)} />}>{null}</Page>;
}
