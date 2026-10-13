import { useRun } from '../../data/runs';
import { Page, PageHeader } from '../../shell/Page';

/** A run's detail (M1.4). */
export function RunPage({ id }: { id: string }) {
  const run = useRun(id);
  return <Page header={<PageHeader title={run.data?.title ?? ''} />}>{null}</Page>;
}
