import { invoke } from '../desktop/native';
export async function openLink(url: string, _accentHex?: string): Promise<void> {
  await invoke('open_external', { url });
}
