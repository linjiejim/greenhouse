import { rpc } from './client';

export interface ArtifactReceipt {
  id: string;
  kind: 'tables_schema_plan' | 'task_capture';
  status: 'processing' | 'succeeded' | 'failed';
  result: unknown;
  error: string | null;
  updated_at: string;
}

export async function getArtifactReceipt(id: string): Promise<ArtifactReceipt | null> {
  const response = await rpc.api['artifact-actions'][':id'].$get({ param: { id } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Unable to load artifact receipt: ${response.status}`);
  return (await response.json()).receipt;
}
